#!/system/bin/sh
DIR=/data/adb/bindhosts_personal
MODDIR=${0%/*}
. "$MODDIR/scripts/compat.sh" || exit 1
REWARD=https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward
AWAVENUE=https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt
AWA_ADS=https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Adguard-Only.Ads.txt
ANTIAD=https://anti-ad.net/easylist.txt
ADRULES=https://adguardteam.github.io/HostlistsRegistry/assets/filter_29.txt
ADGUARD=https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt
PROFILE_DIR=$DIR/profiles
umask 077

case "$1" in list-whitelist|list-blacklist|list-sources|shared-rules) ;; *)
  if [ "${ABP_CONFIG_LOCKED:-0}" != 1 ]; then
    export ABP_CONFIG_LOCKED=1
    exec "$BB" flock -n "$DIR/update.lock" "$BB" sh "$0" "$@"
  fi
  ;;
esac

valid_domain() {
  [ ${#1} -le 253 ] && printf '%s\n' "$1" | "$BB" grep -Eiq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
}
valid_custom_url() {
  [ ${#1} -ge 12 ] && [ ${#1} -le 2048 ] || return 1
  case "$1" in https://*) ;; *) return 1 ;; esac
  case "$1" in *[[:space:]]*|*'|'*|*'"'*|*"'"*|*'`'*|*'$('* ) return 1 ;; esac
  authority=${1#https://}; authority=${authority%%/*}
  case "$authority" in ''|*@*) return 1 ;; esac
}
is_builtin() {
  case "$1" in "$REWARD"|"$AWAVENUE"|"$AWA_ADS"|"$ANTIAD"|"$ADRULES"|"$ADGUARD") return 0 ;; *) return 1 ;; esac
}
source_id() {
  case "$1" in "$REWARD") printf '10007' ;; "$AWAVENUE"|"$AWA_ADS") printf 'awa' ;; "$ANTIAD") printf 'antiad' ;; "$ADRULES") printf 'adrules' ;; "$ADGUARD") printf 'adguard' ;; *) printf 'custom' ;; esac
}
source_label() {
  case "$1" in
    "$REWARD") printf '10007 基础广告规则' ;;
    "$AWAVENUE") printf '秋风完整规则（旧订阅）' ;;
    "$AWA_ADS") printf '秋风纯广告（约 655 条）' ;;
    "$ANTIAD") printf 'anti-AD EasyList（约 9.5 万条）' ;;
    "$ADRULES") printf 'AdRules DNS（约 20 万条 · 高内存）' ;;
    "$ADGUARD") printf 'AdGuard DNS' ;;
    *) printf '自定义规则源' ;;
  esac
}
read_mode() {
  mode=$(cat "$DIR/blocking-mode" 2>/dev/null)
  case "$mode" in light|balanced|strict) ;; *) mode=balanced ;; esac
}
append_line() {
  file=$1; line=$2
  "$BB" touch "$file" || return 1
  "$BB" grep -Fxq "$line" "$file" && return 0
  printf '%s\n' "$line" >> "$file"
}
remove_line() {
  file=$1; line=$2
  [ -f "$file" ] || return 0
  tmp="$file.tmp.$$"
  "$BB" grep -Fvx "$line" "$file" > "$tmp"
  rc=$?
  [ "$rc" -le 1 ] || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp" && mv "$tmp" "$file"
}
mode_sources() {
  case "$1" in
    light|balanced|strict)
      printf '%s\n' "$REWARD" "$AWA_ADS"
      [ ! -f "$PROFILE_DIR/$1.txt" ] || cat "$PROFILE_DIR/$1.txt"
      ;;
  esac
}

init_profiles() {
  [ -f "$DIR/profiles-initialized" ] && return 0
  mkdir -p "$PROFILE_DIR" || return 1
  [ -f "$PROFILE_DIR/light.txt" ] || : > "$PROFILE_DIR/light.txt"
  [ -f "$PROFILE_DIR/balanced.txt" ] || printf '%s\n' "$AWA_ADS" > "$PROFILE_DIR/balanced.txt"
  [ -f "$PROFILE_DIR/strict.txt" ] || printf '%s\n' "$ANTIAD" > "$PROFILE_DIR/strict.txt"
  for legacy in "$DIR/sources.txt" "$DIR/custom-sources.txt"; do
    [ ! -f "$legacy" ] || while IFS= read -r url; do
      valid_custom_url "$url" || continue
      for profile in light balanced strict; do append_line "$PROFILE_DIR/$profile.txt" "$url" || return 1; done
    done < "$legacy"
  done
  if [ -f "$DIR/disabled-sources.txt" ]; then
    while IFS= read -r url; do
      [ -n "$url" ] || continue
      for profile in light balanced strict; do remove_line "$PROFILE_DIR/$profile.txt" "$url" || return 1; done
    done < "$DIR/disabled-sources.txt"
  fi
  printf 'initialized\n' > "$DIR/profiles-initialized.tmp" && chmod 600 "$DIR/profiles-initialized.tmp" && mv "$DIR/profiles-initialized.tmp" "$DIR/profiles-initialized"
}

valid_profile() { case "$1" in light|balanced|strict) return 0 ;; *) return 1 ;; esac; }
profile_file() { printf '%s/%s.txt' "$PROFILE_DIR" "$1"; }
remove_from_profiles() {
  for profile in light balanced strict; do remove_line "$(profile_file "$profile")" "$1" || return 1; done
}

case "$1" in
  init-profiles)
    init_profiles || { echo '[!] Could not initialize rule profiles.' >&2; exit 1; }
    echo '[+] Rule profiles initialized; base and personal rules remain shared.'
    ;;
  list-whitelist|list-blacklist)
    cat "$DIR/${1#list-}.txt" 2>/dev/null
    ;;
  shared-rules)
    "$BB" sh /data/adb/adblockpro/scripts/rule-store.sh show
    ;;
  import-lists)
    "$BB" sh /data/adb/adblockpro/scripts/rule-store.sh import "$2"
    ;;
  export-rules)
    "$BB" sh /data/adb/adblockpro/scripts/rule-store.sh export "$2" "$3"
    ;;
  add-whitelist|add-blacklist)
    domain=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
    valid_domain "$domain" || { echo '[!] Invalid domain.' >&2; exit 1; }
    append_line "$DIR/${1#add-}.txt" "$domain" || exit 1
    echo "[+] Added $domain to ${1#add-}."
    ;;
  remove-whitelist|remove-blacklist)
    domain=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
    valid_domain "$domain" || { echo '[!] Invalid domain.' >&2; exit 1; }
    remove_line "$DIR/${1#remove-}.txt" "$domain"
    ;;
  auto-update)
    case "$2" in on|off) ;; *) echo '[!] Expected on or off.' >&2; exit 1 ;; esac
    /system/bin/sh "$MODDIR/bindhosts.sh" --set-auto-update "$2" || exit 1
    printf '%s\n' "$2" > "$DIR/auto-update.tmp" && mv "$DIR/auto-update.tmp" "$DIR/auto-update" || exit 1
    echo "[+] Automatic filter updates $2."
    ;;
  autostart)
    case "$2" in on|off) ;; *) echo '[!] Expected on or off.' >&2; exit 1 ;; esac
    printf '%s\n' "$2" > "$DIR/autostart.tmp" && chmod 600 "$DIR/autostart.tmp" && mv "$DIR/autostart.tmp" "$DIR/autostart" || exit 1
    echo "[+] Automatic startup $2."
    ;;
  set-mode)
    case "$2" in light|balanced|strict) ;; *) echo '[!] Invalid blocking profile.' >&2; exit 1 ;; esac
    printf '%s\n' "$2" > "$DIR/blocking-mode.tmp" && mv "$DIR/blocking-mode.tmp" "$DIR/blocking-mode" || exit 1
    echo "[+] Blocking profile set to $2; run an update to apply it."
    ;;
  set-source)
    valid_custom_url "$2" || { echo '[!] Invalid HTTPS source.' >&2; exit 1; }
    case "$3" in on|off) ;; *) echo '[!] Source state must be on or off.' >&2; exit 1 ;; esac
    init_profiles || exit 1
    read_mode
    profile=${4:-$mode}
    valid_profile "$profile" || { echo '[!] Invalid profile.' >&2; exit 1; }
    case "$2" in "$REWARD"|"$AWA_ADS") [ "$3" = on ] && exit 0; echo '[!] This source is part of the fixed base.' >&2; exit 1 ;; esac
    if [ "$3" = off ]; then
      remove_line "$(profile_file "$profile")" "$2" || exit 1
    else
      remove_line "$DIR/disabled-sources.txt" "$2" || exit 1
      if ! is_builtin "$2"; then
        "$BB" touch "$DIR/custom-sources.txt" || exit 1
        "$BB" grep -Fxq "$2" "$DIR/custom-sources.txt" || {
          count=$(wc -l < "$DIR/custom-sources.txt")
          [ "$count" -lt 10 ] || { echo '[!] At most 10 custom sources are supported.' >&2; exit 1; }
          append_line "$DIR/custom-sources.txt" "$2" || exit 1
        }
      fi
      append_line "$(profile_file "$profile")" "$2" || exit 1
    fi
    echo "[+] Source assignment saved for $profile; run an update to apply it."
    ;;
  add-source)
    valid_custom_url "$2" || { echo '[!] Enter a valid HTTPS source URL.' >&2; exit 1; }
    init_profiles || exit 1
    read_mode
    profile=${3:-$mode}
    valid_profile "$profile" || { echo '[!] Invalid profile.' >&2; exit 1; }
    case "$2" in "$REWARD"|"$AWA_ADS") echo '[+] This source is already included in the fixed base.'; exit 0 ;; esac
    if ! is_builtin "$2"; then
      "$BB" touch "$DIR/custom-sources.txt" || exit 1
      if ! "$BB" grep -Fxq "$2" "$DIR/custom-sources.txt"; then
        count=$(wc -l < "$DIR/custom-sources.txt")
        [ "$count" -lt 10 ] || { echo '[!] At most 10 custom sources are supported.' >&2; exit 1; }
        append_line "$DIR/custom-sources.txt" "$2" || exit 1
      fi
    fi
    remove_line "$DIR/disabled-sources.txt" "$2" || exit 1
    append_line "$(profile_file "$profile")" "$2" || exit 1
    echo "[+] $(source_label "$2") assigned to $profile; run an update to apply it."
    ;;
  remove-source)
    valid_custom_url "$2" || { echo '[!] Invalid HTTPS source.' >&2; exit 1; }
    init_profiles || exit 1
    case "$2" in "$REWARD"|"$AWA_ADS") echo '[!] Fixed base sources cannot be deleted.' >&2; exit 1 ;; esac
    remove_from_profiles "$2" || exit 1
    if ! is_builtin "$2"; then
      remove_line "$DIR/custom-sources.txt" "$2" || exit 1
    fi
    remove_line "$DIR/sources.txt" "$2" || exit 1
    echo '[+] Source deleted from every profile; run an update to apply it.'
    ;;
  list-sources)
    read_mode
    profile=${2:-$mode}
    valid_profile "$profile" || { echo '[!] Invalid profile.' >&2; exit 1; }
    catalog="$DIR/.abp-catalog.$$"; configured="$DIR/.abp-configured.$$"
    printf '%s\n' "$REWARD" "$AWAVENUE" "$AWA_ADS" "$ANTIAD" "$ADRULES" "$ADGUARD" > "$catalog"
    mode_sources "$profile" > "$configured"
    [ ! -f "$DIR/custom-sources.txt" ] || cat "$DIR/custom-sources.txt" >> "$catalog"
    for item in light balanced strict; do
      [ ! -f "$(profile_file "$item")" ] || cat "$(profile_file "$item")" >> "$catalog"
    done
    "$BB" sort -u "$configured" -o "$configured" || { rm -f "$catalog" "$configured"; exit 1; }
    "$BB" sort -u "$catalog" -o "$catalog" || { rm -f "$catalog" "$configured"; exit 1; }
    printf 'mode\t%s\n' "$profile"
    # One awk process replaces two grep processes per catalog entry. This
    # avoids repeated fork/exec overhead when the WebUI opens Rule Management.
    "$BB" awk \
      -v reward="$REWARD" -v awavenue="$AWAVENUE" -v awa_ads="$AWA_ADS" \
      -v antiad="$ANTIAD" -v adrules="$ADRULES" -v adguard="$ADGUARD" '
      FILENAME == ARGV[1] { if ($0 != "") selected[$0] = 1; next }
      $0 != "" {
        url = $0
        enabled = (url in selected) ? "enabled" : "disabled"
        configured = (url in selected) ? "configured" : "catalog"
        if (url == reward) {
          id="10007"; label="10007 基础广告规则"; removable="base"
        } else if (url == awavenue) {
          id="awa"; label="秋风完整规则（旧订阅）"; removable="profile"
        } else if (url == awa_ads) {
          id="awa"; label="秋风纯广告（约 655 条）"; removable="base"
        } else if (url == antiad) {
          id="antiad"; label="anti-AD EasyList（约 9.5 万条）"; removable="profile"
        } else if (url == adrules) {
          id="adrules"; label="AdRules DNS（约 20 万条 · 高内存）"; removable="profile"
        } else if (url == adguard) {
          id="adguard"; label="AdGuard DNS"; removable="profile"
        } else {
          id="custom"; label="自定义规则源"; removable="removable"
        }
        printf "source\t%s\t%s\t%s\t%s\t%s\t%s\n", id, label, url, enabled, configured, removable
      }
    ' "$configured" "$catalog"
    result=$?
    rm -f "$catalog" "$configured"
    [ "$result" -eq 0 ] || exit "$result"
    ;;
  *) echo '[!] Unsupported configuration action.' >&2; exit 1 ;;
esac
