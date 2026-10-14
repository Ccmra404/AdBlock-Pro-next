package main

import (
 "errors"
 "fmt"
 "os"
 "path/filepath"

 "golang.org/x/crypto/bcrypt"
)

// Public first-install default; upgrades never replace an existing account.
const initialPassword = "password"

const initialConfig = `# Created on this device by AdBlock Pro. Do not upload this file.
# Matches the bundled v0.107.79 core; avoid legacy migrations resetting querylog.
schema_version: 34
http:
  address: 127.0.0.1:3000
users:
  - name: admin
    password: %s
dns:
  bind_hosts:
    - 127.0.0.1
  port: 5591
  protection_enabled: true
  upstream_dns:
    - 223.5.5.5
    - 119.29.29.29
filtering:
  protection_enabled: true
  filtering_enabled: true
  safe_fs_patterns:
    - /data/adb/adblockpro/bin/userfilters/*
filters:
  - enabled: true
    url: https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward
    name: 10007 Base Ads
    id: 10007
  - enabled: true
    url: https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Adguard-Only.Ads.txt
    name: AWAvenue Ads Only
    id: 1791638912
  - enabled: true
    url: /data/adb/adblockpro/bin/userfilters/adblock-pro-shared-app-rules.txt
    name: AdBlock Pro Shared App Rules
    id: 1791638914
  - enabled: true
    url: /data/adb/adblockpro/bin/userfilters/adblock-pro-user-rules.txt
    name: AdBlock Pro Personal Rules
    id: 1791638913
querylog:
  enabled: false
  file_enabled: false
  size_memory: 1000
  interval: 2160h
statistics:
  enabled: true
  interval: 24h
`

func main() {
 if len(os.Args) != 3 {
  fmt.Fprintln(os.Stderr, "usage: adblock-bootstrap CONFIG_PATH AUTH_PATH")
  os.Exit(2)
 }
 if err := createConfig(os.Args[1], os.Args[2]); err != nil {
  fmt.Fprintln(os.Stderr, "initial configuration failed:", err)
  os.Exit(1)
 }
 fmt.Println("Local AdGuard Home configuration created on this device.")
}

func createConfig(configFile, authFile string) error {
 if _, err := os.Stat(configFile); err == nil {
  return errors.New("existing DNS configuration must not be overwritten")
 } else if !os.IsNotExist(err) {
  return err
 }
 if _, err := os.Stat(authFile); err == nil {
  return errors.New("existing API credentials must not be overwritten")
 } else if !os.IsNotExist(err) {
  return err
 }

 hash, err := bcrypt.GenerateFromPassword([]byte(initialPassword), bcrypt.DefaultCost)
 if err != nil { return err }
 for _, dir := range []string{filepath.Dir(configFile), filepath.Dir(authFile)} {
  if err := os.MkdirAll(dir, 0700); err != nil { return err }
 }
 // Write both files with private permissions. Nothing secret is printed.
 if err := writeExclusive(configFile, []byte(fmt.Sprintf(initialConfig, string(hash)))); err != nil { return err }
 if err := writeExclusive(authFile, []byte("admin:"+initialPassword+"\n")); err != nil {
  _ = os.Remove(configFile)
  return err
 }
 return nil
}

func writeExclusive(path string, value []byte) error {
 file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
 if err != nil { return err }
 if _, err := file.Write(value); err != nil { _ = file.Close(); _ = os.Remove(path); return err }
 if err := file.Close(); err != nil { _ = os.Remove(path); return err }
 return nil
}
