package main

import (
 "os"
 "path/filepath"
 "strings"
 "testing"

 "golang.org/x/crypto/bcrypt"
)

func TestFreshInstallCredentials(t *testing.T) {
 dir := t.TempDir()
 yaml := filepath.Join(dir,"AdGuardHome.yaml")
 auth := filepath.Join(dir,"admin.auth")
 if err := createConfig(yaml,auth); err != nil { t.Fatal(err) }
 cred, err := os.ReadFile(auth); if err != nil { t.Fatal(err) }
 parts := strings.Split(strings.TrimSpace(string(cred)),":")
 if len(parts)!=2 || parts[0]!="admin" || parts[1]!="password" { t.Fatalf("unexpected fresh-install credentials") }
 data, err := os.ReadFile(yaml); if err != nil { t.Fatal(err) }
 var hash string
 for _, line := range strings.Split(string(data),"\n") {
  if strings.HasPrefix(line,"    password: ") { hash=strings.TrimPrefix(line,"    password: "); break }
 }
 if err := bcrypt.CompareHashAndPassword([]byte(hash),[]byte(parts[1])); err!=nil { t.Fatalf("hash mismatch: %s",err) }
 if strings.Contains(string(data),"\n    password: "+parts[1]+"\n") { t.Fatal("plaintext password in config") }
 for _, path := range []string{yaml,auth} {
  info,err := os.Stat(path);if err!=nil {t.Fatal(err)}
  if info.Mode().Perm()!=0600 {t.Errorf("wrong mode: %v",info.Mode())}
 }
 if err := createConfig(yaml,auth); err==nil {t.Fatal("existing config overwritten")}
}

func TestFreshInstallsUseDefaultsWithIndependentHashes(t *testing.T) {
 a:=t.TempDir();b:=t.TempDir()
 if err:=createConfig(filepath.Join(a,"a.yml"),filepath.Join(a,"auth"));err!=nil {t.Fatal(err)}
 if err:=createConfig(filepath.Join(b,"a.yml"),filepath.Join(b,"auth"));err!=nil {t.Fatal(err)}
 ca,_:=os.ReadFile(filepath.Join(a,"auth"));cb,_:=os.ReadFile(filepath.Join(b,"auth"))
 if string(ca)!="admin:password\n" || string(cb)!=string(ca) {t.Fatal("fresh-install defaults differ")}
 ya,_:=os.ReadFile(filepath.Join(a,"a.yml"));yb,_:=os.ReadFile(filepath.Join(b,"a.yml"))
 if string(ya)==string(yb) {t.Fatal("bcrypt salts must remain independent")}
}

func TestExistingCredentialsAreNeverResetToDefaults(t *testing.T) {
 for _, existing := range []string{"config", "auth"} {
  t.Run(existing,func(t *testing.T) {
   dir:=t.TempDir();config:=filepath.Join(dir,"config");auth:=filepath.Join(dir,"auth")
   old:=config;other:=auth;if existing=="auth" {old=auth;other=config}
   value:=[]byte("existing-user-content\n")
   if err:=os.WriteFile(old,value,0600);err!=nil {t.Fatal(err)}
   if err:=createConfig(config,auth);err==nil {t.Fatal("existing user state was reset")}
   got,err:=os.ReadFile(old);if err!=nil || string(got)!=string(value) {t.Fatal("existing content changed")}
   if _,err:=os.Stat(other);!os.IsNotExist(err) {t.Fatal("partial existing installation was silently initialized")}
  })
 }
}

func TestFreshConfigEnablesSeparateLocalPersonalFilter(t *testing.T) {
 dir:=t.TempDir()
 yaml:=filepath.Join(dir,"AdGuardHome.yaml")
 if err:=createConfig(yaml,filepath.Join(dir,"auth"));err!=nil {t.Fatal(err)}
 data,err:=os.ReadFile(yaml);if err!=nil {t.Fatal(err)}
 filter:="  - enabled: true\n    url: /data/adb/adblockpro/bin/userfilters/adblock-pro-user-rules.txt\n    name: AdBlock Pro Personal Rules\n    id: 1791638913"
 if !strings.Contains(string(data),filter) {t.Fatal("local personal filter is not enabled on first boot")}
 if strings.Contains(string(data),"user_rules:") {t.Fatal("personal filter must not claim native user_rules")}
}
func TestFreshConfigUsesOnlyTheTwoBundledRemoteRuleSources(t *testing.T) {
 dir:=t.TempDir()
 yaml:=filepath.Join(dir,"AdGuardHome.yaml")
 if err:=createConfig(yaml,filepath.Join(dir,"auth"));err!=nil {t.Fatal(err)}
 data,err:=os.ReadFile(yaml);if err!=nil {t.Fatal(err)}
 config:=string(data)
 for _, want := range []string{
  "url: https://edgeone.gh-proxy.org/https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward",
  "url: https://cdn.uura.cn/AWAvenue/AWAvenue-Ads-Rule.txt",
  "name: AWAvenue Ads (Wang Fugui mirror)",
  "url: /data/adb/adblockpro/bin/userfilters/adblock-pro-shared-app-rules.txt",
 } { if !strings.Contains(config,want) {t.Errorf("fresh config is missing %q",want)} }
 for _, unwanted := range []string{"anti-ad.net", "AdGuardSDNSFilter", "filter_29.txt", "Adguard-Only.Ads.txt"} {
  if strings.Contains(config,unwanted) {t.Errorf("fresh config unexpectedly includes %q",unwanted)}
 }
}
func TestFreshConfigUsesBundledSchemaWithoutLegacyQueryLogReset(t *testing.T) {
 if !strings.Contains(initialConfig, "schema_version: 34\n") { t.Fatal("bundled core schema missing") }
 query := strings.Split(strings.Split(initialConfig, "querylog:\n")[1], "statistics:\n")[0]
 if !strings.Contains(query, "  enabled: false\n") || !strings.Contains(query, "  file_enabled: false\n") { t.Fatal("temporary observation requires disk query logging disabled on fresh installs") }
}

func TestFreshConfigDisablesAutomaticReverseDNS(t *testing.T) {
 dir := t.TempDir()
 yaml := filepath.Join(dir, "AdGuardHome.yaml")
 if err := createConfig(yaml, filepath.Join(dir, "auth")); err != nil { t.Fatal(err) }
 data, err := os.ReadFile(yaml); if err != nil { t.Fatal(err) }
 for _, want := range []string{
  "  use_private_ptr_resolvers: false\n  local_ptr_upstreams: []\n",
  "clients:\n  runtime_sources:\n    rdns: false\n",
 } {
  if !strings.Contains(string(data), want) { t.Errorf("fresh config is missing %q", want) }
 }
}
