#!/system/bin/sh
# Package/user -> UID lookup follows AndroidTProxyShell's find_packages_uid.
# Adapted from CHIZI-0618/AndroidTProxyShell (GPL-3.0), commit 4b6ddd8.
# We query Package Manager so removed apps and UID reuse cannot exclude strangers.
AGH_DIR=${ABP_AGH_DIR:-/data/adb/adblockpro}
STATE_DIR=${ABP_STATE_DIR:-/data/adb/bindhosts_personal}
FILE=$STATE_DIR/app-exclusions.txt
umask 077
[ -n "${BB:-}" ] || . "$AGH_DIR/scripts/compat.sh" || exit 1

valid_key() {
  [ ${#1} -le 265 ] || return 1
  printf '%s\n' "$1" | "$BB" grep -Eq '^(0|[1-9][0-9]{0,4}):[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$' || return 1
  [ "${1%%:*}" -le 21473 ]
}

selections() {
  local input key count=0
  input=$1
  [ -e "$input" ] || return 0
  [ -f "$input" ] && [ -r "$input" ] || return 1
  [ "$(wc -c < "$input")" -le 140000 ] || return 1
  while IFS= read -r key || [ -n "$key" ]; do
    valid_key "$key" || { echo '[!] 应用排除配置无效；未更改 DNS 接管。' >&2; return 1; }
    count=$((count + 1))
    [ "$count" -le 512 ] || { echo '[!] 应用排除最多保存 512 项。' >&2; return 1; }
    printf '%s\n' "$key"
  done < "$input"
}

resolve_uids() {
  local selected users user packages resolved user_snapshot user_status
  selected=$(selections "$1") || return 1
  [ -n "$selected" ] || return 0
  users=$(printf '%s\n' "$selected" | "$BB" cut -d: -f1 | "$BB" sort -u) || return 1
  for user in $users; do
    if [ "$user" != 0 ]; then
      user_snapshot=$(pm list users) || { echo '[!] 无法查询工作资料用户。' >&2; return 1; }
      printf '%s\n' "$user_snapshot" | "$BB" awk -v user="$user" '
        /^[[:space:]]*Users:[[:space:]]*$/ { next }
        /^[[:space:]]*UserInfo\{[0-9]+:/ {
          id=$0; sub(/^[[:space:]]*UserInfo\{/, "", id); sub(/:.*/, "", id)
          if(id==0) primary=1
          if(id==user) found=1
          next
        }
        NF { bad=1 }
        END { if(bad || !primary) exit 2; exit !found }
      '
      user_status=$?
      # A confirmed removed profile is inactive; unreadable state is not absence.
      case "$user_status" in 0) ;; 1) continue ;; *) echo '[!] 工作资料用户查询结果无效。' >&2; return 1 ;; esac
    fi
    packages=$(pm list packages -U --user "$user") || {
      echo '[!] 无法读取系统应用 UID；原设置保留。' >&2; return 1;
    }
    # Reject an error printed with exit=0 and conflicting/malformed UID rows.
    resolved=$(printf '%s\n' "$packages" | "$BB" awk -v selected="$selected" -v user="$user" '
      BEGIN { n=split(selected, keys, "\n"); for(i=1;i<=n;i++) wanted[keys[i]]=1 }
      NF {
        rows++
        if(NF!=2 || $1 !~ /^package:[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/ || $2 !~ /^uid:[0-9]+$/) exit 1
        pkg=substr($1,9); uid=substr($2,5)
        if(length(uid)>10 || uid+0>2147483647 || int(uid/100000)!=user+0) exit 1
        if(pkg in seen && seen[pkg]!=uid) exit 1
        seen[pkg]=uid
        if((user ":" pkg) in wanted) printf "%.0f\n", uid+0
      }
      END { if(!rows) exit 1 }
    ') || { echo '[!] 系统应用 UID 查询结果无效；原设置保留。' >&2; return 1; }
    [ -z "$resolved" ] || printf '%s\n' "$resolved"
  done
}

set_filter() {
  local key mode next before selected existed=0 result
  key=$1 mode=$2
  valid_key "$key" || { echo '[!] 应用标识无效。' >&2; return 1; }
  case "$mode" in on|off) ;; *) echo '[!] Expected on or off.' >&2; return 1 ;; esac
  selected=$(selections "$FILE") || return 1
  next=$STATE_DIR/.app-exclusions.next.$$
  before=$STATE_DIR/.app-exclusions.before.$$
  [ ! -e "$FILE" ] || { cp -p "$FILE" "$before" || return 1; existed=1; }
  { [ -z "$selected" ] || printf '%s\n' "$selected"; [ "$mode" != off ] || printf '%s\n' "$key"; } |
    "$BB" awk -v key="$key" -v mode="$mode" 'NF && !(mode=="on" && $0==key) && !seen[$0]++' > "$next" || {
      rm -f "$next" "$before"; return 1;
    }
  # Validate every selected package before committing or touching firewall rules.
  if ! resolve_uids "$next" >/dev/null || ! chmod 600 "$next" || ! mv -f "$next" "$FILE"; then
    rm -f "$next" "$before"; return 1
  fi
  "$BB" sh "$AGH_DIR/scripts/vpn-compat.sh" refresh
  result=$?
  if [ "$result" -ne 0 ]; then
    if { [ "$existed" = 1 ] && mv -f "$before" "$FILE"; } || { [ "$existed" = 0 ] && rm -f "$FILE"; }; then
      "$BB" sh "$AGH_DIR/scripts/vpn-compat.sh" refresh || echo '[!] 原设置已恢复，但 DNS 接管未恢复；请查看运行状态。' >&2
      echo '[!] 应用设置未应用，已恢复原排除名单。' >&2
    else
      echo "[!] 自动恢复失败，原名单保留在 $before；请勿删除。" >&2
      return 1
    fi
    rm -f "$before"
    return 1
  fi
  rm -f "$before"
  echo '[+] 应用过滤设置已保存；接管状态见上方结果。已有 DNS 缓存或连接可能稍后更新。'
}

case "$1" in
  list)
    rows=$(selections "$FILE") || exit 1
    [ -z "$rows" ] || printf '%s\n' "$rows" | "$BB" awk '{ print "excluded\t" $0 }'
    ;;
  uids)
    rows=$(resolve_uids "$FILE") || exit 1
    [ -z "$rows" ] || printf '%s\n' "$rows" | "$BB" sort -nu
    ;;
  set)
    if [ "${ABP_CONFIG_LOCKED:-0}" != 1 ]; then
      export ABP_CONFIG_LOCKED=1
      exec "$BB" flock -n "$STATE_DIR/update.lock" "$BB" sh "$0" "$@"
    fi
    if [ "${ABP_DNS_TRANSITION_LOCKED:-0}" != 1 ]; then
      export ABP_DNS_TRANSITION_LOCKED=1
      exec "$BB" flock "$STATE_DIR/dns-transition.lock" "$BB" sh "$0" "$@"
    fi
    set_filter "$2" "$3"
    ;;
  *) echo "Usage: $0 {list|uids|set user:package on|off}" >&2; exit 2 ;;
esac
