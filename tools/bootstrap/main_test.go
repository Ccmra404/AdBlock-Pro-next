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
 if len(parts)!=2 || parts[0]!="admin" || len(parts[1])!=48 { t.Fatalf("invalid generated credentials") }
 data, err := os.ReadFile(yaml); if err != nil { t.Fatal(err) }
 var hash string
 for _, line := range strings.Split(string(data),"\n") {
  if strings.HasPrefix(line,"    password: ") { hash=strings.TrimPrefix(line,"    password: "); break }
 }
 if err := bcrypt.CompareHashAndPassword([]byte(hash),[]byte(parts[1])); err!=nil { t.Fatalf("hash mismatch: %s",err) }
 if strings.Contains(string(data),parts[1]) { t.Fatal("plaintext password in config") }
 for _, path := range []string{yaml,auth} {
  info,err := os.Stat(path);if err!=nil {t.Fatal(err)}
  if info.Mode().Perm()!=0600 {t.Errorf("wrong mode: %v",info.Mode())}
 }
 if err := createConfig(yaml,auth); err==nil {t.Fatal("existing config overwritten")}
}

func TestIndependentInstallsHaveDifferentCredentials(t *testing.T) {
 a:=t.TempDir();b:=t.TempDir()
 if err:=createConfig(filepath.Join(a,"a.yml"),filepath.Join(a,"auth"));err!=nil {t.Fatal(err)}
 if err:=createConfig(filepath.Join(b,"a.yml"),filepath.Join(b,"auth"));err!=nil {t.Fatal(err)}
 ca,_:=os.ReadFile(filepath.Join(a,"auth"));cb,_:=os.ReadFile(filepath.Join(b,"auth"))
 if string(ca)==string(cb) {t.Fatal("password reused across installs")}
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
func TestFreshConfigUsesBundledSchemaWithoutLegacyQueryLogReset(t *testing.T) {
 if !strings.Contains(initialConfig, "schema_version: 34\n") { t.Fatal("bundled core schema missing") }
 query := strings.Split(strings.Split(initialConfig, "querylog:\n")[1], "statistics:\n")[0]
 if !strings.Contains(query, "  enabled: false\n") || !strings.Contains(query, "  file_enabled: false\n") { t.Fatal("temporary observation requires disk query logging disabled on fresh installs") }
}
