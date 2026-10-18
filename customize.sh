SKIPUNZIP=1
SKIPMOUNT=true
umask 022

DATA_DIR=/data/adb/adblockpro
STATE_DIR=/data/adb/bindhosts_personal
MODULE_ID=bindhosts_personal

fail() {
  ui_print "[AdBlock Pro] $1"
  abort "Installation stopped."
}

compat_file="$TMPDIR/adblock-pro-compat.sh"
unzip -p "$ZIPFILE" scripts/compat.sh > "$compat_file" || fail "Missing root compatibility helper."
curl_file="$TMPDIR/adblock-pro-curl"
unzip -p "$ZIPFILE" bin/curl > "$curl_file" || fail "Module package is missing its ARM64 curl binary."
chmod 755 "$curl_file" || fail "Cannot prepare the bundled curl binary."
CURL=$curl_file
export CURL
. "$compat_file" || fail "A complete BusyBox from KernelSU, Magisk or APatch is required."
"$CURL" --version >/dev/null 2>&1 || fail "The bundled ARM64 curl binary cannot run on this device."
abp_find_curl >/dev/null || fail "The bundled curl binary is unavailable."
command -v iptables >/dev/null 2>&1 || fail "IPv4 iptables is required for DNS redirection."
ca_file="$TMPDIR/adblock-pro-cacert.pem"
unzip -p "$ZIPFILE" certs/cacert.pem > "$ca_file" || fail "Module package is missing its CA certificate bundle."
[ -s "$ca_file" ] || fail "Module CA certificate bundle is empty."
ui_print "[AdBlock Pro] Root family: $(abp_root_family); BusyBox: $BB"
ROOT_FAMILY=$(abp_root_family)

ui_print "[AdBlock Pro] Preparing the AdGuard Home DNS engine..."

abi=$(getprop ro.product.cpu.abi)
case "$abi" in
  arm64-v8a|arm64) ;;
  *) fail "This build is for ARM64; device ABI is $abi." ;;
esac

if [ -d /data/adb/modules/AdGuardHome ] && [ ! -f /data/adb/modules/AdGuardHome/disable ]; then
  fail "Another AdGuardHome module is enabled. Disable it before switching engines."
fi

mkdir -p "$MODPATH" "$DATA_DIR" "$STATE_DIR" || fail "Cannot create module data directories."
# OpenSSL cannot use Android's old-hash CA directory as its native trust store.
mkdir -p "$DATA_DIR/certs" || fail "Cannot prepare the CA certificate directory."
cp "$ca_file" "$DATA_DIR/certs/cacert.pem" || fail "Cannot install the CA certificate bundle."
chmod 644 "$DATA_DIR/certs/cacert.pem" || fail "Cannot read the installed CA certificate bundle."

# Keep the current package defaults separately from persistent user settings so
# the WebUI can safely restore a fresh-install state after an overlay upgrade.
defaults_tmp="$DATA_DIR/.defaults.new.$$"
mkdir -p "$defaults_tmp" || fail "Cannot prepare factory-reset defaults."
unzip -oq "$ZIPFILE" "settings.conf" "config-blacklist.txt" "config-whitelist.txt" \
  "bin/data/filters/10007.txt" "bin/data/filters/1791638912.txt" -d "$defaults_tmp" || {
    rm -rf "$defaults_tmp"
    fail "Cannot extract factory-reset defaults."
  }
for file in settings.conf config-blacklist.txt config-whitelist.txt bin/data/filters/10007.txt bin/data/filters/1791638912.txt; do
  [ -s "$defaults_tmp/$file" ] || { rm -rf "$defaults_tmp"; fail "Factory-reset default is missing: $file."; }
done
mkdir -p "$DATA_DIR/defaults/filters" || { rm -rf "$defaults_tmp"; fail "Cannot install factory-reset defaults."; }
mv -f "$defaults_tmp/settings.conf" "$DATA_DIR/defaults/settings.conf" &&
  mv -f "$defaults_tmp/config-blacklist.txt" "$DATA_DIR/defaults/config-blacklist.txt" &&
  mv -f "$defaults_tmp/config-whitelist.txt" "$DATA_DIR/defaults/config-whitelist.txt" &&
  mv -f "$defaults_tmp/bin/data/filters/10007.txt" "$DATA_DIR/defaults/filters/10007.txt" &&
  mv -f "$defaults_tmp/bin/data/filters/1791638912.txt" "$DATA_DIR/defaults/filters/1791638912.txt" || {
    rm -rf "$defaults_tmp"
    fail "Cannot save factory-reset defaults."
  }
rm -rf "$defaults_tmp"
chmod 700 "$DATA_DIR/defaults" "$DATA_DIR/defaults/filters"
chmod 600 "$DATA_DIR/defaults"/* "$DATA_DIR/defaults/filters"/*

initialize_switch() {
  file="$STATE_DIR/$1"
  origin=preserved
  if [ ! -e "$file" ]; then
    tmp="$file.tmp.$$"
    printf 'on\n' > "$tmp" && chmod 600 "$tmp" && mv "$tmp" "$file" ||
      fail "Cannot initialize $1."
    origin=initialized
  fi
  value=$(cat "$file" 2>/dev/null)
  case "$value" in on|off) ;; *) fail "Invalid saved $1; preserved for manual recovery." ;; esac
  [ "$1" != dns-takeover ] || ui_print "[AdBlock Pro] DNS takeover: $value ($origin)."
}
initialize_switch autostart
initialize_switch dns-takeover

for file in action.sh module.prop service.sh uninstall.sh; do
  unzip -oq "$ZIPFILE" "$file" -d "$MODPATH" || fail "Cannot extract $file."
done
unzip -oq "$ZIPFILE" "webroot/*" -d "$MODPATH" || fail "Cannot extract WebUI files."
unzip -oq "$ZIPFILE" "rules/*" -d "$MODPATH" || fail "Cannot extract the shared rule snapshot."
for file in bindhosts.sh webui-config.sh webui-job.sh; do
  unzip -oq "$ZIPFILE" "$file" -d "$MODPATH" || fail "Cannot extract $file."
done

unzip -oq "$ZIPFILE" "scripts/*" -d "$DATA_DIR" || fail "Cannot extract runtime scripts."
mkdir -p "$MODPATH/scripts" || fail "Cannot prepare shared root helpers."
cp "$compat_file" "$MODPATH/scripts/compat.sh" || fail "Cannot install the root compatibility helper."
unzip -oq "$ZIPFILE" "scripts/adb-debug.sh" -d "$MODPATH" || fail "Cannot install the ADB diagnostics helper."
chmod 755 "$MODPATH/scripts/adb-debug.sh" || fail "Cannot prepare the ADB diagnostics helper."
if unzip -l "$ZIPFILE" | grep -Eq '^[[:space:]]*[0-9]+[[:space:]].*[[:space:]]debug-build$'; then
  unzip -oq "$ZIPFILE" "debug-build" -d "$MODPATH" || fail "Cannot enable the Debug build marker."
fi
: > "$MODPATH/skip_mount"
mkdir -p "$DATA_DIR/.install/bin" "$DATA_DIR/bin" || fail "Cannot prepare the AdGuard Home upgrade directory."
cp "$CURL" "$DATA_DIR/bin/curl" || fail "Cannot install the bundled curl binary."
chmod 755 "$DATA_DIR/bin/curl" || fail "Cannot make the bundled curl binary executable."
unzip -oq "$ZIPFILE" "bin/adblock-ai" -d "$DATA_DIR/.install" || fail "Missing optional AI analysis helper."
chmod 700 "$DATA_DIR/.install/bin/adblock-ai" || fail "Cannot prepare the AI analysis helper."
mv -f "$DATA_DIR/.install/bin/adblock-ai" "$DATA_DIR/bin/adblock-ai" || fail "Cannot install the AI analysis helper."
unzip -oq "$ZIPFILE" "bin/adblock-bootstrap" -d "$DATA_DIR" || fail "Missing per-device setup helper."
chmod 700 "$DATA_DIR/bin/adblock-bootstrap" || fail "Cannot prepare setup helper."
unzip -oq "$ZIPFILE" "bin/AdGuardHome" -d "$DATA_DIR/.install" || fail "Cannot extract AdGuard Home files."
[ -s "$DATA_DIR/.install/bin/AdGuardHome" ] || fail "The extracted AdGuard Home binary is missing."
mv -f "$DATA_DIR/.install/bin/AdGuardHome" "$DATA_DIR/bin/AdGuardHome" || fail "Cannot replace the AdGuard Home binary."
# The executable may have changed; force a fresh one-time version lookup.
rm -f "$STATE_DIR/engine-version"
rm -rf "$DATA_DIR/.install"
if [ ! -f "$DATA_DIR/bin/data/filters/10007.txt" ]; then
  unzip -oq "$ZIPFILE" "bin/data/filters/10007.txt" -d "$DATA_DIR" || fail "Cannot initialize the bundled 10007 rule cache."
fi
if [ ! -f "$DATA_DIR/bin/data/filters/1791638912.txt" ]; then
  unzip -oq "$ZIPFILE" "bin/data/filters/1791638912.txt" -d "$DATA_DIR" || fail "Cannot initialize the bundled AWAvenue Ads cache."
fi
if [ ! -f "$DATA_DIR/settings.conf" ]; then
  unzip -oq "$ZIPFILE" "settings.conf" -d "$DATA_DIR" || fail "Cannot extract runtime settings."
fi
unzip -oq "$ZIPFILE" "config-blacklist.txt" "config-whitelist.txt" -d "$MODPATH" || fail "Cannot extract list defaults."

# Create first-install defaults and a fresh bcrypt hash on the device.
# Existing credentials are preserved; never archive runtime auth/config files.
if [ ! -f "$DATA_DIR/bin/AdGuardHome.yaml" ] && [ ! -f "$DATA_DIR/admin.auth" ]; then
  "$DATA_DIR/bin/adblock-bootstrap" "$DATA_DIR/bin/AdGuardHome.yaml" "$DATA_DIR/admin.auth" ||
    fail "Failed to create local API credentials and DNS settings."
else
  [ -s "$DATA_DIR/bin/AdGuardHome.yaml" ] && [ -s "$DATA_DIR/admin.auth" ] ||
    fail "Existing DNS settings or API credentials are incomplete; refusing to overwrite them."
fi

# Keep module-managed allow/block rules in a separate AdGuard Home filter.
# This migration only adds our path to the existing allow-list; it does not
# rewrite unrelated AdGuard Home settings.
ensure_user_filter_path() {
  yaml="$DATA_DIR/bin/AdGuardHome.yaml"
  pattern='/data/adb/adblockpro/bin/userfilters/*'
  mkdir -p "$DATA_DIR/bin/userfilters" || return 1
  "$BB" grep -Fq "$pattern" "$yaml" && return 0
  backup="$STATE_DIR/AdGuardHome.yaml.before-user-filter"
  [ -f "$backup" ] || cp -p "$yaml" "$backup" || return 1
  has_patterns=0
  "$BB" grep -q '^  safe_fs_patterns:' "$yaml" && has_patterns=1
  tmp="$yaml.tmp.$$"
  "$BB" awk -v pattern="$pattern" -v has_patterns="$has_patterns" '
    /^  safe_fs_patterns:[[:space:]]*\[\][[:space:]]*$/ {
      print "  safe_fs_patterns:"; print "    - " pattern; seen=1; added=1; next
    }
    /^  safe_fs_patterns:[[:space:]]*$/ { print; seen=1; in_patterns=1; next }
    in_patterns && /^    - / { print; next }
    in_patterns { if (!added) print "    - " pattern; added=1; in_patterns=0 }
    /^filtering:[[:space:]]*$/ { in_filtering=1 }
    in_filtering && /^  [^[:space:]][^:]*:/ && !seen && !has_patterns {
      print "  safe_fs_patterns:"; print "    - " pattern; seen=1; added=1; in_filtering=0
    }
    { print }
    END {
      if (in_patterns && !added) print "    - " pattern
      if (!seen) exit 2
    }
  ' "$yaml" > "$tmp" || { rm -f "$tmp"; return 1; }
  [ -s "$tmp" ] || { rm -f "$tmp"; return 1; }
  chmod 644 "$tmp" && mv "$tmp" "$yaml"
}
ensure_user_filter_path || fail "Cannot safely allow the module's private rule file in AdGuard Home configuration."

# Keep the generated API password in the root-only runtime directory.
chmod 600 "$DATA_DIR/admin.auth" "$DATA_DIR/bin/AdGuardHome.yaml" || fail "Cannot protect local DNS credentials."

if [ ! -f "$STATE_DIR/v3-installed" ]; then
  mkdir -p "$STATE_DIR/legacy-hosts-v2"
  for file in sources.txt custom-sources.txt disabled-sources.txt blocking-mode auto-update; do
    [ ! -f "$STATE_DIR/$file" ] || cp -p "$STATE_DIR/$file" "$STATE_DIR/legacy-hosts-v2/$file"
  done
  : > "$STATE_DIR/sources.txt"
  : > "$STATE_DIR/custom-sources.txt"
  : > "$STATE_DIR/disabled-sources.txt"
  printf 'balanced\n' > "$STATE_DIR/blocking-mode"
  printf 'on\n' > "$STATE_DIR/auto-update"
  if [ ! -f "$STATE_DIR/blacklist.txt" ]; then
    cp "$MODPATH/config-blacklist.txt" "$STATE_DIR/blacklist.txt" || fail "Cannot initialize app-specific block rules."
  fi
  if [ ! -f "$STATE_DIR/whitelist.txt" ]; then
    cp "$MODPATH/config-whitelist.txt" "$STATE_DIR/whitelist.txt" || fail "Cannot initialize whitelist."
  fi
  printf '%s\n' \
    'https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward' \
    'https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/AWAvenue-Ads-Rule.txt' \
    > "$STATE_DIR/sources-applied.txt"
  : > "$STATE_DIR/last-update"
  : > "$STATE_DIR/v3-installed"
fi

user_filter='/data/adb/adblockpro/bin/userfilters/adblock-pro-user-rules.txt'
if "$BB" grep -Fq "$user_filter" "$DATA_DIR/bin/AdGuardHome.yaml"; then
  printf '%s\n' "$user_filter" > "$STATE_DIR/user-filter-applied"
fi
"$BB" sh "$MODPATH/bindhosts.sh" --render-user-rules || fail "Cannot build the personal rule filter."
ABP_MODULE_DIR="$MODPATH" "$BB" sh "$DATA_DIR/scripts/rule-store.sh" init || fail "Cannot prepare the shared app rules."

"$BB" sh "$MODPATH/webui-config.sh" init-sources || fail "Cannot initialize editable rule source preferences."

rm -f "$MODPATH/config-blacklist.txt" "$MODPATH/config-whitelist.txt"
chmod 700 "$DATA_DIR" "$DATA_DIR/scripts" "$DATA_DIR/bin/userfilters" 2>/dev/null
chmod 600 "$DATA_DIR/admin.auth" "$DATA_DIR/settings.conf" "$STATE_DIR"/*.txt "$STATE_DIR"/blocking-mode "$STATE_DIR"/auto-update "$STATE_DIR"/autostart "$STATE_DIR"/dns-takeover 2>/dev/null
chmod 700 "$STATE_DIR/profiles" 2>/dev/null
chmod 600 "$STATE_DIR"/profiles/*.txt "$STATE_DIR"/profiles-initialized 2>/dev/null
chmod 755 "$DATA_DIR/bin/AdGuardHome" "$DATA_DIR/bin/curl" "$DATA_DIR/scripts"/*.sh "$MODPATH"/*.sh
chown root:net_raw "$DATA_DIR/bin/AdGuardHome"
printf '%s\n' "$ROOT_FAMILY" > "$STATE_DIR/root-family.tmp" &&
  chmod 600 "$STATE_DIR/root-family.tmp" && mv "$STATE_DIR/root-family.tmp" "$STATE_DIR/root-family" ||
  fail "Cannot save the installed root family."

ui_print "[AdBlock Pro] ARM64 DNS engine installed. Reboot once to activate it."
