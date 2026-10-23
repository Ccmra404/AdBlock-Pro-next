#!/system/bin/sh
DIR=/data/adb/bindhosts_personal
MODDIR=${0%/*}
. "$MODDIR/scripts/compat.sh" || exit 1
REWARD=https://edgeone.gh-proxy.org/https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward
AWAVENUE=https://cdn.uura.cn/AWAvenue/AWAvenue-Ads-Rule.txt
LEGACY_REWARD=https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward
LEGACY_REWARD_CDN=https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward
LEGACY_REWARD_GCORE=https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward
LEGACY_AWAVENUE=https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt
LEGACY_AWAVENUE_GCORE=https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/AWAvenue-Ads-Rule.txt
LEGACY_AWA_ADS=https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Adguard-Only.Ads.txt
LEGACY_AWA_ADS_GCORE=https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/Filters/AWAvenue-Ads-Rule-Adguard-Only.Ads.txt
ANTIAD=https://anti-ad.net/easylist.txt
ADRULES=https://adguardteam.github.io/HostlistsRegistry/assets/filter_29.txt
ADGUARD=https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt
PROFILE_DIR=$DIR/profiles
SOURCES_V2=$DIR/sources-v2.txt
SOURCE_NAMES=$DIR/source-names.tsv
REMOVED_SOURCES=$DIR/removed-sources.txt
SOURCE_MIGRATION=$DIR/source-url-migration-v1
SHARED_SOURCE=shared
umask 077

case "$1" in list-whitelist|list-blacklist|list-sources|shared-rules|export-file) ;; *)
  if [ "${ABP_CONFIG_LOCKED:-0}" != 1 ]; then
    export ABP_CONFIG_LOCKED=1
    exec "$BB" flock -n "$DIR/update.lock" "$BB" sh "$0" "$@"
  fi
  ;;
esac

valid_domain() {
  [ ${#1} -le 253 ] && printf '%s\n' "$1" | "$BB" grep -Eiq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
}
valid_custom_url() {
  [ ${#1} -ge 12 ] && [ ${#1} -le 2048 ] || return 1
  case "$1" in https://*) ;; *) return 1 ;; esac
  case "$1" in *[[:space:]]*|*'|'*|*'"'*|*"'"*|*'`'*|*'$('* ) return 1 ;; esac
  authority=${1#https://}; authority=${authority%%/*}
  case "$authority" in ''|*@*) return 1 ;; esac
}
is_builtin() {
  case "$1" in "$REWARD"|"$AWAVENUE") return 0 ;; *) return 1 ;; esac
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
  case "$1" in "$REWARD") printf '10007' ;; "$AWAVENUE") printf 'awa-full' ;; "$ANTIAD") printf 'antiad' ;; "$ADRULES") printf 'adrules' ;; "$ADGUARD") printf 'adguard' ;; "$SHARED_SOURCE") printf 'shared' ;; *) printf 'custom' ;; esac
}
source_label() {
  if [ -f "$SOURCE_NAMES" ]; then
    custom_name=$("$BB" awk -F '\t' -v url="$1" '$1==url { print substr($0,index($0,"\t")+1); exit }' "$SOURCE_NAMES")
    [ -z "$custom_name" ] || { printf '%s' "$custom_name"; return; }
  fi
  case "$1" in
    "$REWARD") printf '10007 基础广告规则' ;;
    "$AWAVENUE") printf '秋风 AdGuard 全规则' ;;
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
save_personal_domain() {
  local target=$1 domain=$2 work="$DIR/.personal-edit.$$" kind file restored=1
  mkdir "$work" || return 1
  for kind in blacklist whitelist; do
    file="$DIR/$kind.txt"
    if [ -e "$file" ]; then
      cp -p "$file" "$work/$kind.before" || { rm -rf "$work"; return 1; }
    else : > "$work/$kind.before"; : > "$work/$kind.absent"; fi
    "$BB" awk -v domain="$domain" -v selected="$target" -v kind="$kind" '
      { d=tolower($0); gsub(/^[[:space:]]+|[[:space:]]+$/, "", d)
        if(d==domain) { if(kind==selected && !seen++) print domain; next }
        print
      }
      END { if(kind==selected && !seen) print domain }
    ' "$work/$kind.before" > "$work/$kind.next" || { rm -rf "$work"; return 1; }
  done
  if ! chmod 600 "$work/blacklist.next" "$work/whitelist.next" ||
     ! mv "$work/blacklist.next" "$DIR/blacklist.txt" || ! mv "$work/whitelist.next" "$DIR/whitelist.txt"; then
    for kind in blacklist whitelist; do
      if [ -f "$work/$kind.absent" ]; then rm -f "$DIR/$kind.txt" || restored=0;
      else cp -p "$work/$kind.before" "$DIR/$kind.txt" || restored=0; fi
    done
    if [ "$restored" = 1 ]; then rm -rf "$work";
    else echo "[!] 名单自动恢复未完成；原名单备份保留在 $work，请勿删除。" >&2; fi
    return 1
  fi
  rm -rf "$work"
}
mode_sources() {
  case "$1" in
    light|balanced|strict)
      printf '%s\n' "$REWARD" "$AWAVENUE"
      [ ! -f "$PROFILE_DIR/$1.txt" ] || cat "$PROFILE_DIR/$1.txt"
      ;;
  esac
}
migrate_source_url_file() {
  file=$1
  [ -f "$file" ] || return 0
  if ! "$BB" grep -Fqx "$LEGACY_REWARD" "$file" && ! "$BB" grep -Fqx "$LEGACY_REWARD_CDN" "$file" &&
    ! "$BB" grep -Fqx "$LEGACY_REWARD_GCORE" "$file" && ! "$BB" grep -Fqx "$LEGACY_AWAVENUE" "$file" &&
    ! "$BB" grep -Fqx "$LEGACY_AWAVENUE_GCORE" "$file" && ! "$BB" grep -Fqx "$LEGACY_AWA_ADS" "$file" &&
    ! "$BB" grep -Fqx "$LEGACY_AWA_ADS_GCORE" "$file"; then return 0; fi
  tmp="$file.migrate.$$"
  raw="$tmp.raw"
  "$BB" awk -v old_reward="$LEGACY_REWARD" -v old_reward_cdn="$LEGACY_REWARD_CDN" -v old_reward_gcore="$LEGACY_REWARD_GCORE" -v reward="$REWARD" \
    -v old_awa="$LEGACY_AWAVENUE" -v old_awa_gcore="$LEGACY_AWAVENUE_GCORE" -v old_ads="$LEGACY_AWA_ADS" -v old_ads_gcore="$LEGACY_AWA_ADS_GCORE" -v awa="$AWAVENUE" '
    $0 == old_reward || $0 == old_reward_cdn || $0 == old_reward_gcore { print reward; next }
    $0 == old_awa || $0 == old_awa_gcore || $0 == old_ads || $0 == old_ads_gcore { print awa; next }
    $0 != "" { print }
  ' "$file" > "$raw" || { rm -f "$raw" "$tmp"; return 1; }
  "$BB" sort -u "$raw" -o "$tmp" || { rm -f "$raw" "$tmp"; return 1; }
  rm -f "$raw"
  chmod 600 "$tmp" && mv "$tmp" "$file"
}
migrate_source_names() {
  [ -f "$SOURCE_NAMES" ] || return 0
  if ! "$BB" awk -F '\t' -v old_reward="$LEGACY_REWARD" -v old_reward_cdn="$LEGACY_REWARD_CDN" -v old_reward_gcore="$LEGACY_REWARD_GCORE" \
    -v old_awa="$LEGACY_AWAVENUE" -v old_awa_gcore="$LEGACY_AWAVENUE_GCORE" -v old_ads="$LEGACY_AWA_ADS" -v old_ads_gcore="$LEGACY_AWA_ADS_GCORE" \
    '$1 == old_reward || $1 == old_reward_cdn || $1 == old_reward_gcore || $1 == old_awa || $1 == old_awa_gcore || $1 == old_ads || $1 == old_ads_gcore { found=1 } END { exit !found }' "$SOURCE_NAMES"; then return 0; fi
  tmp="$SOURCE_NAMES.migrate.$$"
  "$BB" awk -F '\t' -v old_reward="$LEGACY_REWARD" -v old_reward_cdn="$LEGACY_REWARD_CDN" -v old_reward_gcore="$LEGACY_REWARD_GCORE" -v reward="$REWARD" \
    -v old_awa="$LEGACY_AWAVENUE" -v old_awa_gcore="$LEGACY_AWAVENUE_GCORE" -v old_ads="$LEGACY_AWA_ADS" -v old_ads_gcore="$LEGACY_AWA_ADS_GCORE" -v awa="$AWAVENUE" '
    BEGIN { OFS="\t" }
    {
      original=$1; url=original; name=substr($0, index($0, "\t") + 1)
      if (url == old_reward || url == old_reward_cdn || url == old_reward_gcore) url=reward
      else if (url == old_awa || url == old_awa_gcore || url == old_ads || url == old_ads_gcore) url=awa
      if (!(url in names) || (original == url && !preferred[url])) { names[url]=name; preferred[url]=(original == url) }
    }
    END { for (url in names) print url, names[url] }
  ' "$SOURCE_NAMES" > "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp" && mv "$tmp" "$SOURCE_NAMES"
}
migrate_source_state() {
  [ ! -f "$SOURCE_MIGRATION" ] || return 0
  for file in "$SOURCES_V2" "$DIR/custom-sources.txt" "$DIR/sources.txt" "$DIR/disabled-sources.txt" "$REMOVED_SOURCES" \
    "$PROFILE_DIR/light.txt" "$PROFILE_DIR/balanced.txt" "$PROFILE_DIR/strict.txt"; do
    migrate_source_url_file "$file" || return 1
  done
  migrate_source_names
}
init_sources() {
  migrate_source_state || return 1
  if [ -f "$SOURCES_V2" ]; then
    [ -f "$SOURCE_MIGRATION" ] || : > "$SOURCE_MIGRATION"
    return $?
  fi
  init_profiles || return 1
  migrate_source_state || return 1
  read_mode
  tmp="$SOURCES_V2.tmp.$$"
  mode_sources "$mode" > "$tmp" || { rm -f "$tmp"; return 1; }
  printf '%s\n' "$SHARED_SOURCE" >> "$tmp" || { rm -f "$tmp"; return 1; }
  "$BB" sort -u "$tmp" -o "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp" && mv "$tmp" "$SOURCES_V2" || return 1
  : > "$SOURCE_MIGRATION"
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
  [ -f "$PROFILE_DIR/balanced.txt" ] || printf '%s\n' "$AWAVENUE" > "$PROFILE_DIR/balanced.txt"
  [ -f "$PROFILE_DIR/strict.txt" ] || : > "$PROFILE_DIR/strict.txt"
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
  export-file)
    "$BB" sh /data/adb/adblockpro/scripts/rule-store.sh write "$2" "$3" "$4"
    ;;
  add-whitelist|add-blacklist)
    domain=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
    valid_domain "$domain" || { echo '[!] Invalid domain.' >&2; exit 1; }
    save_personal_domain "${1#add-}" "$domain" || { echo '[!] 名单保存失败，已尝试恢复原名单。' >&2; exit 1; }
    echo "[+] 已将 $domain 设为 ${1#add-}；已移除相反名单中的同名条目，其他域名保留。"
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
  vpn-compat)
    case "$2" in on|off) ;; *) echo '[!] Expected on or off.' >&2; exit 1 ;; esac
    "$BB" sh /data/adb/adblockpro/scripts/vpn-compat.sh set-mode "$2"
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
      remove_line "$REMOVED_SOURCES" "$2" || exit 1
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
    remove_line "$REMOVED_SOURCES" "$2" || exit 1
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
    append_line "$REMOVED_SOURCES" "$2" || exit 1
    echo '[+] Source removed; current DNS rules will change after the next update.'
    ;;
  rename-source)
    valid_source_ref "$2" && valid_source_name "$3" || { echo '[!] Invalid source name.' >&2; exit 1; }
    init_sources || exit 1
    save_source_names "$2" "$3" || exit 1
    echo "[+] Source renamed to $(source_label "$2"); run a rule update to apply it."
    ;;
  edit-source)
    valid_custom_url "$2" && valid_custom_url "$3" && [ "$2" != "$3" ] || { echo '[!] Enter two different valid HTTPS source URLs.' >&2; exit 1; }
    init_sources || exit 1
    if ! is_builtin "$2" && ! source_is_selected "$2" && ! "$BB" grep -Fxq "$2" "$DIR/custom-sources.txt" 2>/dev/null; then
      echo '[!] The current source does not exist.' >&2; exit 1
    fi
    source_is_selected "$3" && { echo '[!] The new URL is already enabled.' >&2; exit 1; }
    was_selected=0; source_is_selected "$2" && was_selected=1
    custom_tmp="$DIR/custom-sources.txt.tmp.$$"
    sources_tmp="$SOURCES_V2.tmp.$$"
    names_tmp="$SOURCE_NAMES.tmp.$$"
    old_name=''
    [ ! -f "$SOURCE_NAMES" ] || old_name=$("$BB" awk -F '\t' -v url="$2" '$1==url { print substr($0,index($0,"\t")+1); exit }' "$SOURCE_NAMES")
    if [ -f "$DIR/custom-sources.txt" ]; then
      "$BB" grep -Fvx "$2" "$DIR/custom-sources.txt" > "$custom_tmp"; grep_rc=$?
      [ "$grep_rc" -le 1 ] || { rm -f "$custom_tmp"; exit 1; }
    fi
    [ -f "$custom_tmp" ] || : > "$custom_tmp"
    if ! is_builtin "$3" && ! "$BB" grep -Fxq "$3" "$custom_tmp"; then
      count=$(wc -l < "$custom_tmp" 2>/dev/null); [ -n "$count" ] || count=0
      [ "$count" -lt 10 ] || { rm -f "$custom_tmp"; echo '[!] At most 10 custom sources are supported.' >&2; exit 1; }
      printf '%s\n' "$3" >> "$custom_tmp" || { rm -f "$custom_tmp"; exit 1; }
    fi
    "$BB" grep -Fvx "$2" "$SOURCES_V2" > "$sources_tmp"; grep_rc=$?
    [ "$grep_rc" -le 1 ] || { rm -f "$custom_tmp" "$sources_tmp"; exit 1; }
    if [ "$was_selected" = 1 ]; then printf '%s\n' "$3" >> "$sources_tmp" || { rm -f "$custom_tmp" "$sources_tmp"; exit 1; }; fi
    if [ -f "$SOURCE_NAMES" ]; then
      "$BB" awk -F '\t' -v url="$2" '$1 != url { print }' "$SOURCE_NAMES" > "$names_tmp" || { rm -f "$custom_tmp" "$sources_tmp" "$names_tmp"; exit 1; }
    else : > "$names_tmp"; fi
    if [ -n "$old_name" ]; then
      "$BB" awk -F '\t' -v url="$3" '$1 != url { print }' "$names_tmp" > "$names_tmp.next" && mv "$names_tmp.next" "$names_tmp" || { rm -f "$custom_tmp" "$sources_tmp" "$names_tmp" "$names_tmp.next"; exit 1; }
      printf '%s\t%s\n' "$3" "$old_name" >> "$names_tmp" || { rm -f "$custom_tmp" "$sources_tmp" "$names_tmp"; exit 1; }
    fi
    chmod 600 "$custom_tmp" "$sources_tmp" "$names_tmp" && mv "$custom_tmp" "$DIR/custom-sources.txt" && mv "$sources_tmp" "$SOURCES_V2" && mv "$names_tmp" "$SOURCE_NAMES" || { rm -f "$custom_tmp" "$sources_tmp" "$names_tmp"; echo '[!] Could not save the updated source.' >&2; exit 1; }
    echo "[+] Source URL updated to $(source_label "$3"); run a rule update to apply it."
    ;;
  source-name)
    valid_source_ref "$2" || exit 1
    source_label "$2"
    ;;
  list-sources)
    init_sources || exit 1
    catalog="$DIR/.abp-catalog.$$"; selected="$DIR/.abp-selected.$$"; visible="$DIR/.abp-visible.$$"
    printf '%s\n' "$REWARD" "$AWAVENUE" "$SHARED_SOURCE" > "$catalog"
    [ ! -f "$DIR/custom-sources.txt" ] || cat "$DIR/custom-sources.txt" >> "$catalog"
    cat "$SOURCES_V2" >> "$catalog"
    cp "$SOURCES_V2" "$selected" || { rm -f "$catalog" "$selected"; exit 1; }
    "$BB" sort -u "$catalog" -o "$catalog" || { rm -f "$catalog" "$selected"; exit 1; }
    "$BB" sort -u "$selected" -o "$selected" || { rm -f "$catalog" "$selected"; exit 1; }
    if [ -f "$REMOVED_SOURCES" ]; then
      "$BB" awk '
        FILENAME == ARGV[1] { if ($0 != "") removed[$0] = 1; next }
        FILENAME == ARGV[2] { if ($0 != "") selected[$0] = 1; next }
        $0 != "" && (!($0 in removed) || ($0 in selected)) { print }
      ' "$REMOVED_SOURCES" "$selected" "$catalog" > "$visible" || { rm -f "$catalog" "$selected" "$visible"; exit 1; }
      mv "$visible" "$catalog" || { rm -f "$catalog" "$selected" "$visible"; exit 1; }
    fi
    printf 'mode\tbalanced\n'
    "$BB" awk \
      -v reward="$REWARD" -v awavenue="$AWAVENUE" \
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
    rm -f "$catalog" "$selected" "$visible"
    [ "$result" -eq 0 ] || exit "$result"
    ;;
  *) echo '[!] Unsupported configuration action.' >&2; exit 1 ;;
esac
