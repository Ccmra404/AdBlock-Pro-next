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
SOURCES_V2=$DIR/sources-v2.txt
SOURCE_NAMES=$DIR/source-names.tsv
SHARED_SOURCE=shared
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
valid_source_ref() {
  [ "$1" = "$SHARED_SOURCE" ] || valid_custom_url "$1"
}
valid_source_name() {
  name_length=$(printf '%s' "$1" | wc -c | tr -d '[:space:]')
  [ "$name_length" -ge 1 ] && [ "$name_length" -le 192 ] || return 1
  line_count=$(printf '%s' "$1" | wc -l | tr -d '[:space:]'); [ "$line_count" -eq 0 ] || return 1
  clean_length=$(printf '%s' "$1" | "$BB" tr -d '[:cntrl:]' | wc -c | tr -d '[:space:]'); [ "$clean_length" -eq "$name_length" ] || return 1
  return 0
}
source_id() {
  case "$1" in "$REWARD") printf '10007' ;; "$AWAVENUE") printf 'awa-full' ;; "$AWA_ADS") printf 'awa-ads' ;; "$ANTIAD") printf 'antiad' ;; "$ADRULES") printf 'adrules' ;; "$ADGUARD") printf 'adguard' ;; "$SHARED_SOURCE") printf 'shared' ;; *) printf 'custom' ;; esac
}
source_label() {
  if [ -f "$SOURCE_NAMES" ]; then
    custom_name=$("$BB" awk -F '\t' -v url="$1" '$1==url { print substr($0,index($0,"\t")+1); exit }' "$SOURCE_NAMES")
    [ -z "$custom_name" ] || { printf '%s' "$custom_name"; return; }
  fi
  case "$1" in
    "$REWARD") printf '10007 基础广告规则' ;;
    "$AWAVENUE") printf '秋风完整规则（旧订阅）' ;;
    "$AWA_ADS") printf '秋风纯广告（约 655 条）' ;;
    "$ANTIAD") printf 'anti-AD EasyList（约 9.5 万条）' ;;
    "$ADRULES") printf 'AdRules DNS（约 20 万条 · 高内存）' ;;
    "$ADGUARD") printf 'AdGuard DNS' ;;
    "$SHARED_SOURCE") printf '共享抓包规则' ;;
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
init_sources() {
  [ -f "$SOURCES_V2" ] && return 0
  init_profiles || return 1
  read_mode
  tmp="$SOURCES_V2.tmp.$$"
  mode_sources "$mode" > "$tmp" || { rm -f "$tmp"; return 1; }
  printf '%s\n' "$SHARED_SOURCE" >> "$tmp" || { rm -f "$tmp"; return 1; }
  "$BB" sort -u "$tmp" -o "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp" && mv "$tmp" "$SOURCES_V2"
}
source_is_selected() {
  [ -f "$SOURCES_V2" ] && "$BB" grep -Fxq "$1" "$SOURCES_V2"
}
save_source_names() {
  names_tmp="$SOURCE_NAMES.tmp.$$"
  { [ ! -f "$SOURCE_NAMES" ] || "$BB" awk -F '\t' -v url="$1" '$1 != url { print }' "$SOURCE_NAMES"; printf '%s\t%s\n' "$1" "$2"; } > "$names_tmp" || { rm -f "$names_tmp"; return 1; }
  chmod 600 "$names_tmp" && mv "$names_tmp" "$SOURCE_NAMES"
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
  init-sources)
    init_sources || { echo '[!] Could not initialize editable rule sources.' >&2; exit 1; }
    echo '[+] Editable rule sources initialized; existing preferences and personal lists are preserved.'
    ;;
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
    valid_source_ref "$2" || { echo '[!] Invalid rule source.' >&2; exit 1; }
    case "$3" in on|off) ;; *) echo '[!] Source state must be on or off.' >&2; exit 1 ;; esac
    init_sources || exit 1
    if [ "$3" = off ]; then
      remove_line "$SOURCES_V2" "$2" || exit 1
    else
      if [ "$2" != "$SHARED_SOURCE" ] && ! is_builtin "$2"; then append_line "$DIR/custom-sources.txt" "$2" || exit 1; fi
      append_line "$SOURCES_V2" "$2" || exit 1
    fi
    echo "[+] $(source_label "$2") source state saved; run a rule update to apply it."
    ;;
  add-source)
    valid_custom_url "$2" || { echo '[!] Enter a valid HTTPS source URL.' >&2; exit 1; }
    init_sources || exit 1
    name=$3
    case "$name" in light|balanced|strict|'') name=$(source_label "$2") ;; esac
    valid_source_name "$name" || { echo '[!] Source name must be 1–64 characters without control characters.' >&2; exit 1; }
    if ! is_builtin "$2" && ! "$BB" grep -Fxq "$2" "$DIR/custom-sources.txt" 2>/dev/null; then
      count=$(wc -l < "$DIR/custom-sources.txt" 2>/dev/null); [ -n "$count" ] || count=0
      [ "$count" -lt 10 ] || { echo '[!] At most 10 custom sources are supported.' >&2; exit 1; }
      append_line "$DIR/custom-sources.txt" "$2" || exit 1
    fi
    save_source_names "$2" "$name" || exit 1
    append_line "$SOURCES_V2" "$2" || exit 1
    echo "[+] $(source_label "$2") imported; run a rule update to apply it."
    ;;
  remove-source)
    valid_source_ref "$2" || { echo '[!] Invalid rule source.' >&2; exit 1; }
    init_sources || exit 1
    remove_line "$SOURCES_V2" "$2" || exit 1
    if [ "$2" != "$SHARED_SOURCE" ] && ! is_builtin "$2"; then
      remove_line "$DIR/custom-sources.txt" "$2" || exit 1
      if [ -f "$SOURCE_NAMES" ]; then "$BB" awk -F '\t' -v url="$2" '$1 != url { print }' "$SOURCE_NAMES" > "$SOURCE_NAMES.tmp.$$" && chmod 600 "$SOURCE_NAMES.tmp.$$" && mv "$SOURCE_NAMES.tmp.$$" "$SOURCE_NAMES" || exit 1; fi
    fi
    echo '[+] Source removed; current DNS rules will change after the next update.'
    ;;
  rename-source)
    valid_source_ref "$2" && valid_source_name "$3" || { echo '[!] Invalid source name.' >&2; exit 1; }
    init_sources || exit 1
    save_source_names "$2" "$3" || exit 1
    echo "[+] Source renamed to $(source_label "$2"); run a rule update to apply it."
    ;;
  source-name)
    valid_source_ref "$2" || exit 1
    source_label "$2"
    ;;
  list-sources)
    init_sources || exit 1
    catalog="$DIR/.abp-catalog.$$"; selected="$DIR/.abp-selected.$$"
    printf '%s\n' "$REWARD" "$AWAVENUE" "$AWA_ADS" "$ANTIAD" "$ADRULES" "$ADGUARD" "$SHARED_SOURCE" > "$catalog"
    [ ! -f "$DIR/custom-sources.txt" ] || cat "$DIR/custom-sources.txt" >> "$catalog"
    cat "$SOURCES_V2" >> "$catalog"
    cp "$SOURCES_V2" "$selected" || { rm -f "$catalog" "$selected"; exit 1; }
    "$BB" sort -u "$catalog" -o "$catalog" || { rm -f "$catalog" "$selected"; exit 1; }
    "$BB" sort -u "$selected" -o "$selected" || { rm -f "$catalog" "$selected"; exit 1; }
    printf 'mode\tbalanced\n'
    "$BB" awk \
      -v reward="$REWARD" -v awavenue="$AWAVENUE" -v awa_ads="$AWA_ADS" \
      -v antiad="$ANTIAD" -v adrules="$ADRULES" -v adguard="$ADGUARD" -v shared="$SHARED_SOURCE" '
      FILENAME == ARGV[1] { if ($0 != "") selected[$0] = 1; next }
      $0 != "" {
        url = $0
        enabled = (url in selected) ? "enabled" : "disabled"
        configured = (url in selected) ? "configured" : "catalog"
        if (url == reward) {
          id="10007"
        } else if (url == awavenue) {
          id="awa-full"
        } else if (url == awa_ads) {
          id="awa-ads"
        } else if (url == antiad) {
          id="antiad"
        } else if (url == adrules) {
          id="adrules"
        } else if (url == adguard) {
          id="adguard"
        } else if (url == shared) {
          id="shared"
        } else {
          id="custom"
        }
        printf "source\t%s\t%s\t%s\t%s\t%s\n", id, url, enabled, configured, "removable"
      }
    ' "$selected" "$catalog" | while IFS="$(printf '\t')" read -r kind id url enabled configured removable; do
      [ "$kind" = source ] || continue
      label=$(source_label "$url")
      printf 'source\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$label" "$url" "$enabled" "$configured" "$removable"
    done
    result=$?
    rm -f "$catalog" "$selected"
    [ "$result" -eq 0 ] || exit "$result"
    ;;
  *) echo '[!] Unsupported configuration action.' >&2; exit 1 ;;
esac
