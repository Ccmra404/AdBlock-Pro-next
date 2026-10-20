#!/system/bin/sh
MODDIR=${0%/*}
AGH=/data/adb/adblockpro
STATE=/data/adb/bindhosts_personal
API=http://127.0.0.1:3000/control
AUTH_FILE=$AGH/admin.auth
HISTORY=$STATE/dns-history
OBS_DIR=$STATE/observations
. "$MODDIR/scripts/compat.sh" || exit 1
USER_FILTER=$AGH/bin/userfilters/adblock-pro-user-rules.txt
SHARED_FILTER=$AGH/bin/userfilters/adblock-pro-shared-app-rules.txt
RULE_STORE=$AGH/scripts/rule-store.sh
umask 077
. "$AGH/settings.conf" 2>/dev/null
redir_port=${redir_port:-5591}

is_protocol_listening() {
  files=$1
  expected_state=$2
  port_hex=$(printf '%04X' "$redir_port")
  for file in $files; do
    [ -r "$file" ] || continue
    "$BB" awk -v pat=":$port_hex\$" -v expected="$expected_state" \
      'NR > 1 && $2 ~ pat && $4 == expected { found=1 } END { exit !found }' "$file" && return 0
  done
  return 1
}

is_dns_listening() {
  is_protocol_listening '/proc/net/udp /proc/net/udp6' 07 &&
    is_protocol_listening '/proc/net/tcp /proc/net/tcp6' 0A
}

is_our_process() {
  pid=$1
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ -r "/proc/$pid/cmdline" ] || return 1
  "$BB" tr '\000' ' ' < "/proc/$pid/cmdline" | "$BB" grep -Fq "$AGH/bin/AdGuardHome"
}

api() {
  method=$1; path=$2; body=${3-}; timeout=${4:-20}
  [ "$method" != GET ] || timeout=${3:-20}
  if [ -z "${CURL:-}" ]; then CURL=$(abp_find_curl) || return 1; fi
  [ -r "$AUTH_FILE" ] || { echo '[!] Local API credentials are missing.' >&2; return 1; }
  if [ "$method" = GET ]; then
    "$CURL" --basic --silent --show-error --fail --connect-timeout 3 --max-time "$timeout" \
      --user "$(cat "$AUTH_FILE")" "$API$path"
  else
    "$CURL" --basic --silent --show-error --fail --connect-timeout 3 --max-time "$timeout" \
      --user "$(cat "$AUTH_FILE")" -H 'Content-Type: application/json' -X "$method" \
      --data-binary "$body" "$API$path"
  fi
}

json_top_bool() {
  # Subscription objects also contain enabled; only read the API's root field.
  "$BB" awk -v key="$1" '
    { json=json $0 "\n" }
    END {
      for (i=1; i<=length(json); i++) {
        c=substr(json,i,1)
        if (quoted) {
          if (escaped) { escaped=0; continue }
          if (c=="\\") { escaped=1; continue }
          if (c!="\"") continue
          quoted=0
          if (depth==1 && substr(json,start,i-start)==key) {
            rest=substr(json,i+1)
            if (rest ~ /^[[:space:]]*:[[:space:]]*(true|false)[[:space:]]*[,}]/) {
              sub(/^[[:space:]]*:[[:space:]]*/, "", rest)
              value=(rest ~ /^true/) ? "true" : "false"; found++
            }
          }
        } else if (c=="\"") { quoted=1; start=i+1 }
        else if (c=="{" || c=="[") depth++
        else if (c=="}" || c=="]") depth--
      }
      if (found!=1 || quoted || depth!=0) exit 1
      print value
    }'
}

querylog_config() {
  querylog_json=$(api GET /querylog_info 5) || return 1
  querylog_interval=$(printf '%s' "$querylog_json" | "$BB" grep -Eo '"interval"[[:space:]]*:[[:space:]]*[0-9]+' | "$BB" head -n 1 | "$BB" cut -d: -f2 | "$BB" tr -d '[:space:]')
  querylog_enabled=$(printf '%s' "$querylog_json" | "$BB" grep -Eo '"enabled"[[:space:]]*:[[:space:]]*(true|false)' | "$BB" head -n 1 | "$BB" cut -d: -f2 | "$BB" tr -d '[:space:]')
  querylog_anonymize=$(printf '%s' "$querylog_json" | "$BB" grep -Eo '"anonymize_client_ip"[[:space:]]*:[[:space:]]*(true|false)' | "$BB" head -n 1 | "$BB" cut -d: -f2 | "$BB" tr -d '[:space:]')
  case "$querylog_interval" in ''|*[!0-9]*) return 1 ;; esac
  case "$querylog_enabled" in true|false) ;; *) return 1 ;; esac
  case "$querylog_anonymize" in true|false) ;; *) return 1 ;; esac
}

set_querylog_config() {
  api POST /querylog_config "{\"interval\":$1,\"enabled\":$2,\"anonymize_client_ip\":$3}" 8 >/dev/null
}

restore_querylog_yaml() {
  yaml_enabled=$1
  case "$yaml_enabled" in true|false) ;; *) return 1 ;; esac
  yaml="$AGH/bin/AdGuardHome.yaml"
  [ -f "$yaml" ] || return 1
  tmp="$yaml.observe.$$"
  awk -v value="$yaml_enabled" '
    /^querylog:[[:space:]]*$/ { in_querylog=1; print; next }
    in_querylog && /^[^[:space:]]/ { in_querylog=0 }
    in_querylog && /^  enabled:[[:space:]]*/ { print "  enabled: " value; seen=1; next }
    { print }
    END { if (!seen) exit 2 }
  ' "$yaml" > "$tmp" || { rm -f "$tmp"; return 1; }
  chmod 600 "$tmp" && mv "$tmp" "$yaml"
}

observe_restore() {
  observe_id=$1
  case "$observe_id" in ''|*[!0-9]*) return 1 ;; esac
  observe_meta="$OBS_DIR/$observe_id.meta"
  [ -r "$observe_meta" ] || return 0
  observe_interval=$(sed -n '1p' "$observe_meta")
  observe_enabled=$(sed -n '2p' "$observe_meta")
  observe_anonymize=$(sed -n '3p' "$observe_meta")
  case "$observe_interval" in ''|*[!0-9]*) return 1 ;; esac
  case "$observe_enabled" in true|false) ;; *) return 1 ;; esac
  case "$observe_anonymize" in true|false) ;; *) return 1 ;; esac
  [ "$observe_enabled" = true ] && return 0
  if set_querylog_config "$observe_interval" false "$observe_anonymize"; then return 0; fi
  pid=''; [ ! -r "$AGH/bin/agh.pid" ] || pid=$(cat "$AGH/bin/agh.pid")
  is_our_process "$pid" && return 1
  restore_querylog_yaml false
}

observe_abort() {
  [ "${observe_restored:-0}" = 1 ] || observe_restore "${observe_id:-}" || return 1
  rm -f "$OBS_DIR/active" "$OBS_DIR/${observe_id:-}.result" "$OBS_DIR/${observe_id:-}.result.tmp" "$OBS_DIR/${observe_id:-}.page.tmp" "$OBS_DIR/${observe_id:-}.meta"
  rmdir "$OBS_DIR/lock" 2>/dev/null
}

observe_capture() {
  observe_seconds=$1
  observe_id=$2
  observe_package=${3:-}
  case "$observe_seconds" in 5|10|15|30|60|90) ;; *) echo '[!] Invalid observation duration.' >&2; return 1 ;; esac
  case "$observe_id" in ''|*[!0-9]*) echo '[!] Invalid observation ID.' >&2; return 1 ;; esac
  [ ${#observe_id} -le 20 ] || { echo '[!] Invalid observation ID.' >&2; return 1; }
  if [ -n "$observe_package" ]; then
    [ ${#observe_package} -le 255 ] && printf '%s\n' "$observe_package" | "$BB" grep -Eq '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$' || {
      echo '[!] Invalid application package.' >&2; return 1;
    }
    observe_activity=$(cmd package resolve-activity --brief --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER "$observe_package" 2>/dev/null | "$BB" tail -n 1)
    case "$observe_activity" in "$observe_package/"*) ;; *) echo '[!] 应用未安装或没有可启动入口，请重新选择。' >&2; return 1 ;; esac
  fi
  mkdir -p "$OBS_DIR" || return 1
  chmod 700 "$OBS_DIR" 2>/dev/null
  if ! mkdir "$OBS_DIR/lock" 2>/dev/null; then echo '[!] A DNS observation is already active.' >&2; return 1; fi
  # The module normally keeps query logs in memory only. Refuse to start if
  # file logging was enabled separately in AdGuard Home's native settings.
  file_logging=$(awk '
    /^querylog:[[:space:]]*$/ { in_querylog=1; next }
    in_querylog && /^[^[:space:]]/ { exit }
    in_querylog && /^  file_enabled:/ { print $2; exit }
  ' "$AGH/bin/AdGuardHome.yaml" 2>/dev/null)
  if [ "$file_logging" != false ]; then
    rmdir "$OBS_DIR/lock" 2>/dev/null
    echo '[!] 查询日志正在写入磁盘。请在 AdGuard Home 后台关闭磁盘存储后，再使用临时观察。' >&2
    return 1
  fi
  querylog_config || { rmdir "$OBS_DIR/lock" 2>/dev/null; echo '[!] Cannot read the current DNS query-log settings.' >&2; return 1; }
  observe_meta="$OBS_DIR/$observe_id.meta"
  printf '%s\n%s\n%s\n%s\n%s\n' "$querylog_interval" "$querylog_enabled" "$querylog_anonymize" "$(date +%s)" "$observe_seconds" > "$observe_meta.tmp" || { rmdir "$OBS_DIR/lock" 2>/dev/null; return 1; }
  chmod 600 "$observe_meta.tmp" && mv "$observe_meta.tmp" "$observe_meta" || { rm -f "$observe_meta.tmp"; rmdir "$OBS_DIR/lock" 2>/dev/null; return 1; }
  printf '%s\n' "$observe_id" > "$OBS_DIR/active.tmp" && chmod 600 "$OBS_DIR/active.tmp" && mv "$OBS_DIR/active.tmp" "$OBS_DIR/active" || { rm -f "$observe_meta"; rmdir "$OBS_DIR/lock" 2>/dev/null; return 1; }
  if [ "$querylog_enabled" = false ]; then
    # Keep the temporary query-log client field anonymized even if the
    # user's normal query-log preference is not; restore it on every exit.
    set_querylog_config "$querylog_interval" true true || {
      rm -f "$OBS_DIR/active" "$observe_meta"
      rmdir "$OBS_DIR/lock" 2>/dev/null
      echo '[!] Could not temporarily enable DNS query logging.' >&2
      return 1
    }
  fi
  observe_started_at=$(date +%s)
  observe_restored=0
  trap 'observe_abort >/dev/null 2>&1' EXIT
  trap 'exit 1' HUP INT TERM
  # Only keep a short, private API snapshot for the WebUI to parse locally.
  # The normal operation log never receives DNS queries or client addresses.
  echo "[进度] OBSERVE_START_EPOCH=$observe_started_at"
  if [ -n "$observe_package" ]; then
    echo "[进度] 正在打开选定应用，共观察 $observe_seconds 秒。"
    # Android's activity service may reject a Root-private file descriptor.
    # Capture both streams through a pipe, not the worker's on-disk log.
    if ! observe_launch_output=$(am force-stop --user 0 "$observe_package" 2>&1) ||
       ! observe_launch_output=$(am start --user 0 -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$observe_activity" 2>&1) ||
       printf '%s\n' "$observe_launch_output" | "$BB" grep -q '^Error:'; then
      echo '[!] 应用启动失败，正在恢复原查询日志设置。' >&2; return 1;
    fi
  else
    echo "[进度] 正在观察设备 DNS 域名，共 $observe_seconds 秒；请现在打开目标应用。"
  fi
  sleep "$observe_seconds"
  observe_result="$OBS_DIR/$observe_id.result"
  observe_page="$OBS_DIR/$observe_id.page.tmp"
  # Bound WebView memory use while reading a busy device's query log.
  observe_page_size=200
  observe_max_pages=10
  observe_offset=0
  observe_cursor=''
  observe_last_cursor=''
  observe_requested_cursor=''
  observe_pages=0
  observe_truncated=0
  : > "$observe_result.tmp" || return 1
  while [ "$observe_pages" -lt "$observe_max_pages" ]; do
    observe_requested_cursor=''
    if [ "$observe_pages" -gt 0 ] && [ -n "$observe_cursor" ] && [ "$observe_cursor" != "$observe_last_cursor" ]; then
      observe_encoded_cursor=$(printf '%s' "$observe_cursor" | sed 's/+/%2B/g')
      observe_query_path="/querylog?limit=$observe_page_size&older_than=$observe_encoded_cursor"
      observe_requested_cursor=$observe_cursor
      observe_last_cursor=$observe_cursor
    else
      observe_query_path="/querylog?limit=$observe_page_size&offset=$observe_offset"
    fi
    if ! api GET "$observe_query_path" 8 > "$observe_page"; then
      if [ "$observe_pages" -eq 0 ]; then
        rm -f "$observe_result.tmp" "$observe_page"
        observe_restore "$observe_id" || { echo '[!] Query-log restoration failed; it will be retried after service startup.' >&2; return 1; }
        observe_restored=1
        rm -f "$OBS_DIR/active"
        rmdir "$OBS_DIR/lock" 2>/dev/null
        echo '[!] Could not read the DNS query log.' >&2
        return 1
      fi
      observe_truncated=1
      break
    fi
    if ! "$BB" grep -q '"data"' "$observe_page"; then
      if [ "$observe_pages" -eq 0 ]; then
        rm -f "$observe_result.tmp" "$observe_page"
        observe_restore "$observe_id" || { echo '[!] Query-log restoration failed; it will be retried after service startup.' >&2; return 1; }
        observe_restored=1
        rm -f "$OBS_DIR/active"
        rmdir "$OBS_DIR/lock" 2>/dev/null
        echo '[!] AdGuard Home returned an unexpected query-log response.' >&2
        return 1
      fi
      observe_truncated=1
      break
    fi
    observe_entries=$("$BB" grep -Eo '"question"[[:space:]]*:' "$observe_page" | wc -l | tr -d '[:space:]')
    case "$observe_entries" in ''|*[!0-9]*) observe_entries=0 ;; esac
    observe_next_cursor=$("$BB" grep -Eo '"oldest"[[:space:]]*:[[:space:]]*"[^"]*"' "$observe_page" | "$BB" head -n 1 | "$BB" sed -E 's/^"oldest"[[:space:]]*:[[:space:]]*"([^"]*)".*$/\1/')
    if [ "$observe_entries" -ge "$observe_page_size" ] && [ -n "$observe_requested_cursor" ] && { [ -z "$observe_next_cursor" ] || [ "$observe_next_cursor" = "$observe_requested_cursor" ]; }; then
      observe_truncated=1
      break
    fi
    [ -n "$observe_next_cursor" ] && observe_cursor=$observe_next_cursor
    if [ "$observe_pages" -gt 0 ]; then printf '\n__ABP_PAGE__\n' >> "$observe_result.tmp" || return 1; fi
    cat "$observe_page" >> "$observe_result.tmp" || return 1
    observe_pages=$((observe_pages + 1))
    observe_offset=$((observe_offset + observe_page_size))
    rm -f "$observe_page"
    [ "$observe_entries" -ge "$observe_page_size" ] || break
    if [ "$observe_pages" -ge "$observe_max_pages" ]; then
      observe_truncated=1
      break
    fi
  done
  rm -f "$observe_page"
  if [ "$observe_pages" -eq 0 ]; then
    printf '{"data":[]}' > "$observe_result.tmp" || return 1
  fi
  printf '\n__ABP_META__truncated=%s\n' "$observe_truncated" >> "$observe_result.tmp" || return 1
  chmod 600 "$observe_result.tmp" && mv "$observe_result.tmp" "$observe_result" || { rm -f "$observe_result.tmp"; return 1; }
  observe_restore "$observe_id" || { echo '[!] Query-log restoration failed; it will be retried after service startup.' >&2; return 1; }
  observe_restored=1
  rm -f "$OBS_DIR/active"
  rmdir "$OBS_DIR/lock" 2>/dev/null
  trap - EXIT HUP INT TERM
  echo '[结果] DNS 域名观察完成；原查询日志设置已恢复。'
  [ "$observe_truncated" = 0 ] || echo '[提醒] 查询记录已达读取上限或后续分页失败；本次结果可能不完整。'
  # A result that is never opened is removed after ten minutes.
  "$BB" sh "$AGH/scripts/detach.sh" "$BB" "$BB" sh -c 'sleep 600; rm -f "$1" "$2" "$3"' \
    observe-cleanup "$observe_result" "$observe_meta" "$observe_page" >/dev/null 2>&1 &
}

recover_observation() {
  [ -r "$OBS_DIR/active" ] || return 0
  observe_id=$(cat "$OBS_DIR/active" 2>/dev/null)
  case "$observe_id" in ''|*[!0-9]*) rm -f "$OBS_DIR/active"; rmdir "$OBS_DIR/lock" 2>/dev/null; return 1 ;; esac
  observe_restore "$observe_id" || { echo '[!] Could not restore DNS query-log settings after an interrupted observation.' >&2; return 1; }
  rm -f "$OBS_DIR/active" "$OBS_DIR/$observe_id.result" "$OBS_DIR/$observe_id.result.tmp"
  rmdir "$OBS_DIR/lock" 2>/dev/null
  job_log="$STATE/webui-jobs/$observe_id.log"
  if [ -f "$job_log" ] && [ ! -f "$STATE/webui-jobs/$observe_id.done" ]; then
    echo '[!] Observation was interrupted by a device restart; original query-log settings were restored.' >> "$job_log"
    printf '1\n' > "$STATE/webui-jobs/$observe_id.done.tmp" && mv "$STATE/webui-jobs/$observe_id.done.tmp" "$STATE/webui-jobs/$observe_id.done"
  fi
}

valid_domain() {
  [ ${#1} -le 253 ] && printf '%s\n' "$1" | "$BB" grep -Eiq '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
}

rules_count() {
  printf '%s' "$1" | "$BB" grep -Eo '"rules_count"[[:space:]]*:[[:space:]]*[0-9]+' | "$BB" awk -F: '{ n += $2 } END { print n + 0 }'
}

history_text() {
  [ -d "$HISTORY" ] || return 0
  first=1
  for archive in $($BB ls -1t "$HISTORY"/*.tar.gz 2>/dev/null | $BB head -n 3); do
    [ -f "$archive" ] || continue
    key=${archive##*/}; key=${key%.tar.gz}
    count=${key#*-}
    [ "$first" = 1 ] || printf ','
    printf '%s:%s' "$key" "$count"
    first=0
  done
}

read_redirect_status() {
  local redirect_state redirect_rc
  redirect_state=$("$BB" sh "$AGH/scripts/iptables.sh" status-ipv4 2>/dev/null)
  redirect_rc=$?
  # A generic shell/query failure can also exit 1: require both signals.
  case "$redirect_state:$redirect_rc" in
    present:0) redirected=1 ;;
    absent:1) redirected=0 ;;
    *) redirected=unknown ;;
  esac
}

classify_dns_health() {
  state=degraded
  if [ "$running" != 1 ]; then health=stopped; state=paused
  elif [ "$listening" != 1 ]; then health=listener_failed
  elif [ "$api_ok" != 0 ]; then health=api_failed
  elif [ "$redirected" = unknown ]; then health=takeover_state_unknown
  elif [ "$takeover" = off ] && [ "$redirected" = 0 ]; then health=takeover_off; state=bypassed
  elif [ "$takeover" = off ]; then health=takeover_cleanup_pending
  elif [ "$takeover" != on ]; then health=takeover_unknown
  elif [ "$redirected" != 1 ]; then health=takeover_failed
  else health=active; state=active
  fi
}

status() {
  filter_json='{}'; stats_json='{}'
  api_ok=1
  pid=''; [ ! -r "$AGH/bin/agh.pid" ] || pid=$(cat "$AGH/bin/agh.pid")
  running=0
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -r "/proc/$pid/cmdline" ] && "$BB" tr '\000' ' ' < "/proc/$pid/cmdline" | "$BB" grep -Fq "$AGH/bin/AdGuardHome"; then running=1; fi
  if [ "$running" = 1 ]; then
    filter_json=$(api GET /filtering/status 4) && api_ok=0 || filter_json='{}'
    stats_json=$(api GET /stats 3) || stats_json='{}'
  fi
  listening_udp=0; is_protocol_listening '/proc/net/udp /proc/net/udp6' 07 && listening_udp=1
  listening_tcp=0; is_protocol_listening '/proc/net/tcp /proc/net/tcp6' 0A && listening_tcp=1
  listening=0; [ "$listening_udp" = 1 ] && [ "$listening_tcp" = 1 ] && listening=1
  read_redirect_status
  takeover=$(cat "$STATE/dns-takeover" 2>/dev/null); case "$takeover" in on|off) ;; *) takeover=unknown ;; esac
  classify_dns_health
  mode=$(cat "$STATE/blocking-mode" 2>/dev/null); case "$mode" in light|balanced|strict) ;; *) mode=balanced ;; esac
  auto=$(cat "$STATE/auto-update" 2>/dev/null); case "$auto" in on|off) ;; *) auto=on ;; esac
  last_update=$(cat "$STATE/last-update" 2>/dev/null); case "$last_update" in ''|*[!0-9]*) last_update=0 ;; esac
  # The binary version rarely changes, but launching a second AGH process
  # on every WebUI status poll adds avoidable CPU and I/O overhead.
  version_cache="$STATE/engine-version"
  if [ -s "$version_cache" ]; then
    version=$("$BB" head -n 1 "$version_cache")
  else
    version=$("$AGH/bin/AdGuardHome" --version 2>/dev/null | "$BB" head -n 1 | "$BB" tr '\r\n' '  ')
    [ -n "$version" ] || version=unknown
    printf '%s\n' "$version" > "$version_cache.tmp.$" &&
      mv -f "$version_cache.tmp.$" "$version_cache"
  fi
  module_version=$($BB grep '^version=' "$MODDIR/module.prop" | $BB cut -d= -f2-)
  [ -n "$module_version" ] || module_version=unknown
  count=$(rules_count "$filter_json")
  if [ "$count" = 0 ] && [ -d "$AGH/bin/data/filters" ]; then
    count=$(for file in "$AGH/bin/data/filters"/*.txt; do [ -f "$file" ] || continue; "$BB" awk '!/^[[:space:]]*(!|#|$)/ { n++ } END { print n+0 }' "$file"; done | "$BB" awk '{ n += $1 } END { print n+0 }')
  fi
  filtering_enabled=$(printf '%s' "$filter_json" | json_top_bool enabled)
  case "$filtering_enabled" in true|false) ;; *) filtering_enabled=unknown ;; esac
  autostart=$(cat "$STATE/autostart" 2>/dev/null); case "$autostart" in on|off) ;; *) autostart=on ;; esac
  printf 'state=%s blocked=%s mode=%s\n' "$state" "$count" "$mode"
  printf 'filtering_enabled=%s\ndns_takeover=%s\nautostart=%s\n' "$filtering_enabled" "$takeover" "$autostart"
  printf 'dns_core_running=%s\ndns_health=%s\n' "$running" "$health"
  [ "$running" = 1 ] || pid=''
  "$BB" sh "$AGH/scripts/memory.sh" quick "$pid" | "$BB" sed 's/^mem_rss/dns_rss/;s/^mem_pss/dns_pss/;s/^mem_/dns_mem_/'
  printf 'module=version=%s / %s\nupdate_due=no\nauto_update=%s\nlast_update=%s\n' "$module_version" "$version" "$auto" "$last_update"
  printf 'history=%s\n' "$(history_text)"
  printf 'dns_filter_json=%s\n' "$(printf '%s' "$filter_json" | $BB tr '\r\n' '  ')"
  printf 'dns_stats_json=%s\n' "$(printf '%s' "$stats_json" | $BB tr '\r\n' '  ')"
  printf 'dns_listener=%s\ndns_listener_udp=%s\ndns_listener_tcp=%s\ndns_redirect=%s\n' "$listening" "$listening_udp" "$listening_tcp" "$redirected"
}

save_snapshot() {
  filter_json=$(api GET /filtering/status) || return 1
  count=$(rules_count "$filter_json")
  stamp=$(date '+%Y%m%d%H%M%S')
  key="$stamp-$count"
  stage="$HISTORY/.stage.$$"
  mkdir -p "$stage/bin/data" "$stage/state" || return 1
  cp "$AGH/bin/AdGuardHome.yaml" "$stage/bin/AdGuardHome.yaml" || { rm -rf "$stage"; return 1; }
  [ ! -d "$AGH/bin/data/filters" ] || cp -R "$AGH/bin/data/filters" "$stage/bin/data/filters" || { rm -rf "$stage"; return 1; }
  [ ! -d "$AGH/bin/userfilters" ] || cp -R "$AGH/bin/userfilters" "$stage/bin/userfilters" || { rm -rf "$stage"; return 1; }
  for file in sources-v2.txt source-names.tsv removed-sources.txt sources-local-v2 sources.txt custom-sources.txt disabled-sources.txt sources-applied.txt user-filter-applied shared-app-domains.txt blocking-mode blacklist.txt whitelist.txt auto-update last-update; do
    [ ! -f "$STATE/$file" ] || cp "$STATE/$file" "$stage/state/$file" || { rm -rf "$stage"; return 1; }
  done
  [ ! -f "$STATE/profiles-initialized" ] || cp "$STATE/profiles-initialized" "$stage/state/profiles-initialized" || { rm -rf "$stage"; return 1; }
  [ ! -d "$STATE/profiles" ] || cp -R "$STATE/profiles" "$stage/state/profiles" || { rm -rf "$stage"; return 1; }
  mkdir -p "$HISTORY" || { rm -rf "$stage"; return 1; }
  tar -czf "$HISTORY/$key.tar.gz" -C "$stage" . || { rm -rf "$stage"; return 1; }
  rm -rf "$stage"
  LAST_SNAPSHOT=$key
  old=$($BB ls -1t "$HISTORY"/*.tar.gz 2>/dev/null | $BB tail -n +4)
  [ -z "$old" ] || printf '%s\n' "$old" | while IFS= read -r file; do [ -z "$file" ] || rm -f "$file"; done
}

restore_snapshot() {
  key=$1
  archive="$HISTORY/$key.tar.gz"
  [ -f "$archive" ] || { echo '[!] Snapshot not found.' >&2; return 1; }
  restore="$HISTORY/.restore.$$"
  mkdir -p "$restore" || return 1
  tar -xzf "$archive" -C "$restore" || { rm -rf "$restore"; return 1; }
  # Never overwrite a live resolver's configuration if safe stop failed.
  "$AGH/scripts/tool.sh" stop || { rm -rf "$restore"; echo '[!] Cannot stop DNS safely; rollback aborted.' >&2; return 1; }
  cp "$restore/bin/AdGuardHome.yaml" "$AGH/bin/AdGuardHome.yaml" || { rm -rf "$restore"; return 1; }
  rm -rf "$AGH/bin/data/filters" "$AGH/bin/userfilters"
  [ ! -d "$restore/bin/data/filters" ] || cp -R "$restore/bin/data/filters" "$AGH/bin/data/filters" || { rm -rf "$restore"; return 1; }
  [ ! -d "$restore/bin/userfilters" ] || cp -R "$restore/bin/userfilters" "$AGH/bin/userfilters" || { rm -rf "$restore"; return 1; }
  for file in sources-v2.txt source-names.tsv removed-sources.txt sources-local-v2 sources.txt custom-sources.txt disabled-sources.txt sources-applied.txt user-filter-applied shared-app-domains.txt blocking-mode blacklist.txt whitelist.txt auto-update last-update; do
    rm -f "$STATE/$file"
    [ ! -f "$restore/state/$file" ] || cp "$restore/state/$file" "$STATE/$file" || { rm -rf "$restore"; return 1; }
  done
  rm -f "$STATE/profiles-initialized"
  [ ! -f "$restore/state/profiles-initialized" ] || cp "$restore/state/profiles-initialized" "$STATE/profiles-initialized" || { rm -rf "$restore"; return 1; }
  rm -rf "$STATE/profiles"
  [ ! -d "$restore/state/profiles" ] || cp -R "$restore/state/profiles" "$STATE/profiles" || { rm -rf "$restore"; return 1; }
  rm -rf "$restore"
  "$AGH/scripts/tool.sh" start
}

update_failed() {
  message=$1
  printf '%s\n' "$message" >&2
  if [ "${AUTO_UPDATE:-0}" = 1 ] && { [ -f "$MODDIR/disable" ] || [ -f "$MODDIR/remove" ] ||
     ! is_our_process "$(cat "$AGH/bin/agh.pid" 2>/dev/null)"; }; then
    echo '[提醒] 自动更新期间核心已停止或模块已禁用；保留规则快照，不自动重启核心。' >&2
    return 1
  fi
  if [ -n "${LAST_SNAPSHOT:-}" ]; then
    echo '[恢复] 更新未完成，正在恢复更新前的规则与配置。' >&2
    restore_snapshot "$LAST_SNAPSHOT" || { echo '[!] 自动恢复失败；请从规则管理中手动恢复历史版本。' >&2; return 1; }
    echo '[恢复] 已恢复更新前的规则与配置。' >&2
  fi
  return 1
}

source_name() {
  custom_name=''
  [ ! -f "$STATE/source-names.tsv" ] || custom_name=$($BB awk -F '\t' -v url="$1" '$1==url { print substr($0,index($0,"\t")+1); exit }' "$STATE/source-names.tsv")
  [ -z "$custom_name" ] || { printf '%s' "$custom_name"; return; }
  case "$1" in
    https://edgeone.gh-proxy.org/https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward) printf '10007 保留广告奖励（EdgeOne）' ;;
    https://lingeringsound.github.io/10007_auto/reward|https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward|https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward|https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward) printf '10007 保留广告奖励' ;;
    https://lingeringsound.github.io/10007_auto/adb.txt|https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/adb.txt|https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/adb.txt) printf '10007 基础广告规则' ;;
    https://raw.githubusercontent.com/lingeringsound/10007_auto/master/adb.txt) printf '10007 基础广告规则' ;;
    https://cdn.uura.cn/AWAvenue/AWAvenue-Ads-Rule.txt) printf '秋风 AdGuard 全规则（王富贵镜像）' ;;
    https://script.cx.ms/awavenue/AWAvenue-Ads-Rule-Adguard.txt) printf '秋风 AdGuard 全规则（CXPLAY 镜像）' ;;
    https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/AWAvenue-Ads-Rule.txt) printf '秋风 AdGuard 全规则' ;;
    https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt) printf '秋风广告规则' ;;
    https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Adguard-Only.Ads.txt) printf '秋风纯广告' ;;
    https://anti-ad.net/easylist.txt) printf 'anti-AD EasyList' ;;
    https://adguardteam.github.io/HostlistsRegistry/assets/filter_29.txt) printf 'AdRules DNS' ;;
    https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt) printf 'AdGuard DNS' ;;
    shared) printf '共享抓包规则' ;;
    *) host=${1#https://}; host=${host%%/*}; printf '%s' "$host" ;;
  esac
}
source_mirror_urls() {
  case "$1" in
    https://edgeone.gh-proxy.org/https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward)
      printf '%s\n' 'https://lingeringsound.github.io/10007_auto/reward' 'https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward' 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward' 'https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward' ;;
    https://lingeringsound.github.io/10007_auto/reward)
      printf '%s\n' 'https://edgeone.gh-proxy.org/https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward' 'https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward' 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward' 'https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward' ;;
    https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward)
      printf '%s\n' 'https://edgeone.gh-proxy.org/https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward' 'https://lingeringsound.github.io/10007_auto/reward' 'https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward' 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward' 'https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward' ;;
    https://lingeringsound.github.io/10007_auto/adb.txt)
      printf '%s\n' 'https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/adb.txt' 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/adb.txt' 'https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/adb.txt' ;;
    https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/adb.txt)
      printf '%s\n' 'https://lingeringsound.github.io/10007_auto/adb.txt' 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/adb.txt' 'https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/adb.txt' ;;
    https://raw.githubusercontent.com/lingeringsound/10007_auto/master/adb.txt|https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/adb.txt)
      printf '%s\n' 'https://lingeringsound.github.io/10007_auto/adb.txt' 'https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/adb.txt' ;;
    https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward)
      printf '%s\n' 'https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward' 'https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward' ;;
    https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward)
      printf '%s\n' 'https://cdn.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward' 'https://gcore.jsdelivr.net/gh/lingeringsound/10007_auto@master/reward' ;;
    https://cdn.uura.cn/AWAvenue/AWAvenue-Ads-Rule.txt)
      printf '%s\n' 'https://script.cx.ms/awavenue/AWAvenue-Ads-Rule-Adguard.txt' 'https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/AWAvenue-Ads-Rule.txt' 'https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt' 'https://ghfast.top/https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt' ;;
    https://script.cx.ms/awavenue/AWAvenue-Ads-Rule-Adguard.txt)
      printf '%s\n' 'https://cdn.uura.cn/AWAvenue/AWAvenue-Ads-Rule.txt' 'https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/AWAvenue-Ads-Rule.txt' 'https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt' 'https://ghfast.top/https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt' ;;
    https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/AWAvenue-Ads-Rule.txt)
      printf '%s\n' 'https://script.cx.ms/awavenue/AWAvenue-Ads-Rule-Adguard.txt' 'https://cdn.uura.cn/AWAvenue/AWAvenue-Ads-Rule.txt' 'https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt' ;;
    https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/AWAvenue-Ads-Rule.txt)
      printf '%s\n' 'https://script.cx.ms/awavenue/AWAvenue-Ads-Rule-Adguard.txt' 'https://cdn.uura.cn/AWAvenue/AWAvenue-Ads-Rule.txt' 'https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/AWAvenue-Ads-Rule.txt' ;;
    https://raw.githubusercontent.com/TG-Twilight/AWAvenue-Ads-Rule/main/Filters/AWAvenue-Ads-Rule-Adguard-Only.Ads.txt)
      printf 'https://gcore.jsdelivr.net/gh/TG-Twilight/AWAvenue-Ads-Rule@main/Filters/AWAvenue-Ads-Rule-Adguard-Only.Ads.txt' ;;
    https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt) printf 'https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/gh-pages/Filters/filter.txt' ;;
    *) return 1 ;;
  esac
}
source_cache_key() {
  key=$(printf '%s' "$1" | "$BB" sha256sum 2>/dev/null | "$BB" awk '{print $1}')
  case "$key" in ''|*[!a-fA-F0-9]*) key=$(printf '%s' "$1" | cksum | "$BB" awk '{print $1 "-" $2}') ;; esac
  printf '%s' "$key"
}
source_file() {
  if [ "$1" = shared ]; then printf '%s' "$SHARED_FILTER"; return; fi
  key=$(source_cache_key "$1")
  printf '%s/adblock-pro-source-%s.txt' "$AGH/bin/userfilters" "$key"
}
post_remove_source() {
  url=$1
  escaped=$(printf '%s' "$url" | "$BB" sed 's/\\/\\\\/g; s/"/\\"/g')
  body=$(printf '{"url":"%s","whitelist":false}' "$escaped")
  result=$(api POST /filtering/remove_url "$body" 8 2>&1) && return 0
  case "$result" in *"not found"*|*"does not exist"*) return 0 ;; esac
  status=$(api GET /filtering/status 8 2>/dev/null) || { printf '%s\n' "$result" >&2; return 1; }
  if printf '%s' "$status" | "$BB" grep -Eo '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | "$BB" cut -d '"' -f4 | "$BB" grep -Fxq "$url"; then printf '%s\n' "$result" >&2; return 1; fi
  return 0
}
download_candidate() {
  candidate_url=$1; candidate_output=$2
  if [ ! -s "$AGH/certs/cacert.pem" ]; then echo '[!] 模块 CA 证书包缺失，无法安全下载 HTTPS 规则。' >&2; return 1; fi
  if "$CURL" --cacert "$AGH/certs/cacert.pem" --silent --show-error --fail --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 20 --max-filesize 52428800 "$candidate_url" -o "$candidate_output"; then
    :
  else
    curl_status=$?
    rm -f "$candidate_output"
    if [ "$curl_status" -eq 60 ] && [ "${ABP_TLS_WARNING_SHOWN:-0}" != 1 ]; then
      echo '[!] HTTPS 证书链验证失败（curl 60）；未关闭证书校验。请确认设备时间、模块 CA 证书包和当前网络是否进行 HTTPS 解密。' >&2
      ABP_TLS_WARNING_SHOWN=1
    fi
    return 1
  fi
  bytes=$(wc -c < "$candidate_output" 2>/dev/null); case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
  [ "$bytes" -gt 0 ] && [ "$bytes" -le 52428800 ] || { rm -f "$candidate_output"; return 1; }
  first=$(head -c 512 "$candidate_output" | "$BB" tr '[:upper:]' '[:lower:]')
  case "$first" in *'<!doctype html'*|*'<html'*|*'<head'*) rm -f "$candidate_output"; return 1 ;; esac
}
download_source() {
  url=$1; output=$2; name=$3
  [ -n "${CURL:-}" ] || CURL=$(abp_find_curl) || return 1
  echo "[进度] 下载规则源：$name"
  candidate_host=${url#https://}; candidate_host=${candidate_host%%/*}
  echo "[进度] 尝试规则源：$candidate_host"
  if download_candidate "$url" "$output"; then return 0; fi
  for mirror in $(source_mirror_urls "$url" 2>/dev/null); do
    [ -n "$mirror" ] && [ "$mirror" != "$url" ] || continue
    candidate_host=${mirror#https://}; candidate_host=${candidate_host%%/*}
    echo "[提醒] 原地址失败，正在尝试 HTTPS 镜像：$candidate_host"
    if download_candidate "$mirror" "$output"; then echo "[+] 已通过 HTTPS 镜像下载：$name"; return 0; fi
  done
  echo "[!] 下载失败：$name。原地址和可用镜像均未成功；现有规则会保留。" >&2
  rm -f "$output"
  return 1
}
sync_sources() {
  config="$MODDIR/webui-config.sh"
  desired="$STATE/.desired-sources.$$"
  raw="$STATE/.sources-raw.$$"
  work="$STATE/.source-downloads.$$"
  live_urls="$work/.live-urls"
  entries="$STATE/.source-entries.$$"
  applied="$STATE/sources-applied.txt"
  marker="$STATE/sources-local-v2"
  "$BB" sh "$config" list-sources > "$raw" || { rm -f "$raw" "$desired"; return 1; }
  "$BB" awk -F '\t' '$1=="source" && $5=="enabled" { print $4 "\t" $3 }' "$raw" > "$desired" || { rm -f "$raw" "$desired"; return 1; }
  rm -f "$raw"
  mkdir -p "$work" "$AGH/bin/userfilters" || { rm -f "$desired"; return 1; }
  : > "$entries"
  while IFS="$(printf '\t')" read -r url name; do
    [ -n "$url" ] || continue
    filter=$(source_file "$url")
    temp=''
    if [ "$url" != shared ]; then
      key=$(source_cache_key "$url")
      temp="$work/$key.txt"
      download_source "$url" "$temp" "$name" || { rm -rf "$work"; rm -f "$desired" "$entries"; return 2; }
    elif [ ! -s "$filter" ]; then
      echo '[!] 随包或本地共享规则文件缺失；现有规则保留。' >&2
      rm -rf "$work"; rm -f "$desired" "$entries"; return 1
    fi
    printf '%s\t%s\t%s\t%s\n' "$url" "$filter" "$name" "$temp" >> "$entries" || { rm -rf "$work"; rm -f "$desired" "$entries"; return 1; }
  done < "$desired"
  live_status=$(api GET /filtering/status 8) || { rm -rf "$work"; rm -f "$desired" "$entries"; return 1; }
  printf '%s' "$live_status" | "$BB" grep -q '"filters"[[:space:]]*:' || { rm -rf "$work"; rm -f "$desired" "$entries"; echo '[!] AdGuard Home returned an invalid filter list.' >&2; return 1; }
  printf '%s' "$live_status" | "$BB" grep -Eo '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | "$BB" cut -d '"' -f4 > "$live_urls" || { rm -rf "$work"; rm -f "$desired" "$entries" "$live_urls"; return 1; }
  [ -f "$applied" ] || : > "$applied"
  if [ ! -f "$marker" ]; then
    # Older releases registered remote URLs in AdGuard Home itself. Remove only
    # those module-owned subscriptions before replacing them with local files.
    while IFS= read -r url; do
      [ -n "$url" ] || continue
      post_remove_source "$url" || { rm -rf "$work"; rm -f "$desired" "$entries"; return 1; }
    done < "$applied"
    if ! "$BB" awk -F '\t' '$1=="shared" { found=1 } END { exit !found }' "$desired"; then post_remove_source "$SHARED_FILTER" || { rm -rf "$work"; rm -f "$desired" "$entries"; return 1; }; fi
  else
    while IFS= read -r url; do
      [ -n "$url" ] || continue
      if ! "$BB" awk -F '\t' -v url="$url" '$1==url { found=1 } END { exit !found }' "$desired"; then
        filter=$(source_file "$url")
        post_remove_source "$filter" || { rm -rf "$work"; rm -f "$desired" "$entries"; return 1; }
        [ "$filter" = "$SHARED_FILTER" ] || rm -f "$filter"
      fi
    done < "$applied"
  fi
  while IFS="$(printf '\t')" read -r url filter name temp; do
    [ -n "$url" ] || continue
    if [ -n "$temp" ]; then chmod 600 "$temp" && mv -f "$temp" "$filter" || { rm -rf "$work"; rm -f "$desired" "$entries"; return 1; }; fi
    escaped=$(printf '%s' "$filter" | "$BB" sed 's/\\/\\\\/g; s/"/\\"/g')
    safe_name=$(printf '%s' "$name" | "$BB" sed 's/\\/\\\\/g; s/"/\\"/g')
    if ! "$BB" grep -Fxq "$filter" "$live_urls"; then
      echo "[进度] 注册本地规则：$name"
      body=$(printf '{"name":"%s","url":"%s","whitelist":false}' "$safe_name" "$escaped")
      result=$(api POST /filtering/add_url "$body" 20 2>&1) || {
        case "$result" in *"already added"*|*"already exists"*) ;; *) printf '%s\n' "$result" >&2; rm -rf "$work"; rm -f "$desired" "$entries"; return 1 ;; esac
      }
      printf '%s\n' "$filter" >> "$live_urls" || { rm -rf "$work"; rm -f "$desired" "$entries" "$live_urls"; return 1; }
    else
      echo "[进度] 更新本地规则：$name"
    fi
    body=$(printf '{"url":"%s","whitelist":false,"data":{"name":"%s","url":"%s","enabled":true}}' "$escaped" "$safe_name" "$escaped")
    api POST /filtering/set_url "$body" 20 >/dev/null || { rm -rf "$work"; rm -f "$desired" "$entries"; return 1; }
  done < "$entries"
  "$BB" awk -F '\t' 'NF { print $1 }' "$desired" > "$applied.tmp" && chmod 600 "$applied.tmp" && mv "$applied.tmp" "$applied" || { rm -rf "$work"; rm -f "$desired" "$entries"; return 1; }
  printf 'local-v2\n' > "$marker.tmp" && chmod 600 "$marker.tmp" && mv "$marker.tmp" "$marker" || { rm -rf "$work"; rm -f "$desired" "$entries"; return 1; }
  rm -rf "$work"; rm -f "$desired" "$entries" "$live_urls"
}
write_personal_filter() {
  filter_dir="$AGH/bin/userfilters"
  mkdir -p "$filter_dir" || return 1
  tmp="$USER_FILTER.tmp.$$"
  printf '! AdBlock Pro personal allow and block rules\n' > "$tmp" || return 1
  for kind in blacklist whitelist; do
    [ ! -f "$STATE/$kind.txt" ] || while IFS= read -r domain; do
      domain=$(printf '%s' "$domain" | $BB tr '[:upper:]' '[:lower:]')
      case "$domain" in ''|\#*) continue ;; esac
      valid_domain "$domain" || { rm -f "$tmp"; echo "[!] Invalid domain in $kind.txt: $domain" >&2; return 1; }
      if [ "$kind" = blacklist ]; then rule="||$domain^"; else rule="@@||$domain^"; fi
      printf '%s\n' "$rule" >> "$tmp" || { rm -f "$tmp"; return 1; }
    done < "$STATE/$kind.txt"
  done
  rules_tmp="$tmp.sorted"
  $BB awk '!/^[[:space:]]*(!|#|$)/ { print }' "$tmp" | $BB sort -u > "$rules_tmp" || { rm -f "$tmp" "$rules_tmp"; return 1; }
  printf '! AdBlock Pro personal allow and block rules\n' > "$tmp" || { rm -f "$tmp" "$rules_tmp"; return 1; }
  cat "$rules_tmp" >> "$tmp" || { rm -f "$tmp" "$rules_tmp"; return 1; }
  rm -f "$rules_tmp"
  chmod 600 "$tmp" && mv "$tmp" "$USER_FILTER" || { rm -f "$tmp"; return 1; }
  USER_RULE_COUNT=$($BB awk '!/^[[:space:]]*(!|#|$)/ { n++ } END { print n+0 }' "$USER_FILTER")
}

ensure_shared_filter() {
  selected=$("$BB" sh "$MODDIR/webui-config.sh" list-sources 2>/dev/null) || return 1
  if ! printf '%s\n' "$selected" | "$BB" awk -F '\t' '$1=="source" && $4=="shared" && $5=="enabled" { found=1 } END { exit !found }'; then
    post_remove_source "$SHARED_FILTER"
    return $?
  fi
  "$BB" sh "$RULE_STORE" init || return 1
  shared_json=$(api GET /filtering/status 4) || return 1
  if ! printf '%s' "$shared_json" | "$BB" grep -Eo '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | "$BB" cut -d '"' -f4 | "$BB" grep -Fxq "$SHARED_FILTER"; then
    body=$(printf '{"name":"AdBlock Pro 共享抓包规则","url":"%s","whitelist":false}' "$SHARED_FILTER")
    result=$(api POST /filtering/add_url "$body" 8 2>&1) || {
      case "$result" in *"already added"*|*"already exists"*) ;; *) printf '%s\n' "$result" >&2; return 1 ;; esac
    }
  fi
  # This is a fixed base filter, so reconcile its enabled state on startup and update.
  body=$(printf '{"url":"%s","whitelist":false,"data":{"name":"AdBlock Pro 共享抓包规则","url":"%s","enabled":true}}' "$SHARED_FILTER" "$SHARED_FILTER")
  api POST /filtering/set_url "$body" 8 >/dev/null || { echo '[!] Cannot enable the bundled shared rule filter.' >&2; return 1; }
}

sync_shared_rules() {
  LAST_SNAPSHOT=
  api GET /status 4 >/dev/null || return 1
  save_snapshot || return 1
  echo '[进度] 同步公开共享抓包规则'
  "$BB" sh "$RULE_STORE" sync || return 1
  ensure_shared_filter && api POST /filtering/refresh '{"whitelist":false}' 30 >/dev/null || {
    update_failed '[!] 共享规则应用失败，正在保留上一版配置。'; return 1;
  }
  echo '[成功] 共享抓包规则已同步并应用；本机个人名单保留。'
}

sync_personal_filter() {
  marker="$STATE/user-filter-applied"
  write_personal_filter || return 1
  rule_count=$USER_RULE_COUNT
  if [ "$rule_count" -eq 0 ]; then
    if [ -f "$marker" ]; then
      post_remove_source "$USER_FILTER" || return 1
      rm -f "$marker"
    fi
    return 0
  fi

  escaped=$(printf '%s' "$USER_FILTER" | $BB sed 's/\\/\\\\/g; s/"/\\"/g')
  name='AdBlock Pro 个人黑白名单'
  if [ ! -f "$marker" ]; then
    body=$(printf '{"name":"%s","url":"%s","whitelist":false}' "$name" "$escaped")
    result=$(api POST /filtering/add_url "$body" 20 2>&1)
    rc=$?
    if [ "$rc" -ne 0 ]; then
      case "$result" in *"already added"*|*"already exists"*) ;; *) printf '%s\n' "$result" >&2; return 1 ;; esac
    fi
  fi
  body=$(printf '{"url":"%s","whitelist":false,"data":{"name":"%s","url":"%s","enabled":true}}' "$escaped" "$name" "$escaped")
  api POST /filtering/set_url "$body" 20 >/dev/null || return 1
  printf '%s\n' "$USER_FILTER" > "$marker.tmp" && chmod 600 "$marker.tmp" && mv "$marker.tmp" "$marker"
}

set_personal_filter_enabled() {
  body=$(printf '{"url":"%s","whitelist":false,"data":{"name":"AdBlock Pro 个人黑白名单","url":"%s","enabled":%s}}' "$USER_FILTER" "$USER_FILTER" "$1")
  api POST /filtering/set_url "$body" 20 >/dev/null
}

apply_personal_rules() {
  local personal_json personal_present personal_backup personal_had_file personal_added personal_removed
  personal_json=$(api GET /filtering/status 4) || {
    echo '[!] DNS 服务未响应；名单已保存，启动服务后可重试应用。' >&2; return 1;
  }
  personal_present=0
  if printf '%s' "$personal_json" | "$BB" grep -Eo '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | "$BB" cut -d '"' -f4 | "$BB" grep -Fxq "$USER_FILTER"; then personal_present=1; fi
  personal_backup="$USER_FILTER.previous.$$"
  personal_had_file=0; personal_added=0; personal_removed=0
  if [ -f "$USER_FILTER" ]; then
    cp -p "$USER_FILTER" "$personal_backup" || return 1
    personal_had_file=1
  elif [ "$personal_present" = 1 ]; then
    echo '[!] 现有个人规则文件缺失，未更改正在使用的过滤器。' >&2; return 1
  fi
  if apply_personal_filter_change; then
    rm -f "$personal_backup"
    echo '[成功] 个人名单已应用；未下载或更新其他订阅，未更改过滤开关。'
    return 0
  fi
  echo '[!] 个人名单应用失败；保留已保存的名单供重试，正在恢复原过滤器。' >&2
  if [ "$personal_had_file" = 1 ]; then
    mv "$personal_backup" "$USER_FILTER" || { echo '[!] 原规则文件恢复失败，请查看日志后重试。' >&2; return 1; }
  else
    rm -f "$USER_FILTER"
  fi
  rm -f "$STATE/user-filter-applied.tmp"
  if [ "$personal_present" = 1 ]; then
    if [ "$personal_removed" = 1 ]; then
      api POST /filtering/add_url "{\"name\":\"AdBlock Pro 个人黑白名单\",\"url\":\"$USER_FILTER\",\"whitelist\":false}" 20 >/dev/null || return 1
    fi
    set_personal_filter_enabled false && set_personal_filter_enabled true || {
      echo '[!] 原个人过滤器未能重新加载；DNS 核心仍保留，请重试应用。' >&2; return 1;
    }
  elif [ "$personal_added" = 1 ]; then
    post_remove_source "$USER_FILTER" || return 1
  fi
  return 1
}

apply_personal_filter_change() {
  write_personal_filter || return 1
  if [ "$USER_RULE_COUNT" -eq 0 ]; then
    if [ "$personal_present" = 1 ]; then
      post_remove_source "$USER_FILTER" || return 1
      personal_removed=1
    fi
    rm -f "$STATE/user-filter-applied"
    return $?
  fi
  if [ "$personal_present" = 1 ]; then
    # AGH only rereads this local file when its enabled state changes.
    set_personal_filter_enabled false || return 1
  else
    api POST /filtering/add_url "{\"name\":\"AdBlock Pro 个人黑白名单\",\"url\":\"$USER_FILTER\",\"whitelist\":false}" 20 >/dev/null || return 1
    personal_added=1
  fi
  set_personal_filter_enabled true || return 1
  printf '%s\n' "$USER_FILTER" > "$STATE/user-filter-applied.tmp" &&
    chmod 600 "$STATE/user-filter-applied.tmp" && mv "$STATE/user-filter-applied.tmp" "$STATE/user-filter-applied"
}

update_rules() {
  local sync_result
  LAST_SNAPSHOT=
  echo '[进度] 检查 AdGuard Home 服务状态'
  api GET /status 4 >/dev/null || { echo '[!] DNS 服务没有响应；现有规则未更改。' >&2; return 1; }
  save_snapshot || { echo '[!] 无法保存更新前的规则快照。' >&2; return 1; }
  echo '[进度] 应用来源与黑白名单配置'
  selected_sources=$("$BB" sh "$MODDIR/webui-config.sh" list-sources) || { update_failed '[!] 无法读取已选规则来源。'; return 1; }
  if printf '%s\n' "$selected_sources" | "$BB" awk -F '\t' '$1=="source" && $4=="shared" && $5=="enabled" { found=1 } END { exit !found }'; then
    "$BB" sh "$RULE_STORE" sync || echo '[提醒] 共享库同步失败，继续使用随包或上次有效快照。'
  fi
  sync_sources
  sync_result=$?
  if [ "$sync_result" -ne 0 ]; then
    if [ "$sync_result" -eq 2 ]; then
      echo '[!] 规则源下载失败；订阅配置未更改，DNS 核心保持运行。' >&2
      return 1
    fi
    update_failed '[!] 规则来源配置失败。'
    return 1
  fi
  sync_personal_filter || { update_failed '[!] 个人黑白名单同步失败。'; return 1; }
  echo '[进度] 下载并校验规则源'
  api POST /filtering/refresh '{"whitelist":false}' 180 || { update_failed '[!] 规则下载或校验失败。'; return 1; }
  filter_json=$(api GET /filtering/status) || { update_failed '[!] 无法读取更新后的规则状态。'; return 1; }
  count=$(rules_count "$filter_json")
  if [ "$count" -eq 0 ]; then
    # Removing every source and personal rule is a valid user choice.
    if printf '%s\n' "$selected_sources" | "$BB" awk -F '\t' '$1=="source" && $5=="enabled" { found=1 } END { exit !found }' ||
       [ "${USER_RULE_COUNT:-0}" -gt 0 ] ||
       ! printf '%s' "$filter_json" | "$BB" tr '\r\n' '  ' | "$BB" grep -Eq '"filters"[[:space:]]*:[[:space:]]*(\[[[:space:]]*\]|null)[[:space:]]*[,}]'; then
      update_failed '[!] 更新后没有可用过滤规则。'; return 1
    fi
  fi
  date '+%s' > "$STATE/last-update.tmp" && mv "$STATE/last-update.tmp" "$STATE/last-update" || { update_failed '[!] 无法记录规则更新时间。'; return 1; }
  echo "[成功] 规则更新完成，规则数：$count"
}

auto_update_rules() {
  local now last attempt selected
  [ ! -f "$MODDIR/disable" ] && [ ! -f "$MODDIR/remove" ] || return 0
  [ ! -f "$STATE/auto-update" ] || [ "$(cat "$STATE/auto-update")" = on ] || return 0
  is_our_process "$(cat "$AGH/bin/agh.pid" 2>/dev/null)" && is_dns_listening || return 0
  now=$(date '+%s')
  case "$now" in ''|*[!0-9]*) return 1 ;; esac
  last=$(cat "$STATE/last-update" 2>/dev/null)
  attempt=$(cat "$STATE/auto-update-attempt" 2>/dev/null)
  case "$last" in ''|*[!0-9]*|0[0-9]*) last=0 ;; esac
  case "$attempt" in ''|*[!0-9]*|0[0-9]*) attempt=0 ;; esac
  [ ${#last} -le 11 ] || last=0
  [ ${#attempt} -le 11 ] || attempt=0
  [ "$last" -le "$now" ] || last=0
  [ "$attempt" -le "$now" ] || attempt=0
  [ $((now - last)) -ge 86400 ] && [ $((now - attempt)) -ge 3600 ] || return 0
  selected=$("$BB" sh "$MODDIR/webui-config.sh" list-sources) || return 1
  printf '%s\n' "$selected" | "$BB" awk -F '\t' '$1=="source" && $5=="enabled" { found=1 } END { exit !found }' || return 0
  printf '%s\n' "$now" > "$STATE/auto-update-attempt.tmp" &&
    chmod 600 "$STATE/auto-update-attempt.tmp" && mv "$STATE/auto-update-attempt.tmp" "$STATE/auto-update-attempt" || return 1
  printf '%s [自动更新] 下载已启用的规则来源。\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$AGH/history.log"
  AUTO_UPDATE=1 update_rules >> "$AGH/history.log" 2>&1
}

diagnose() {
  root_uid=$(id -u 2>/dev/null); case "$root_uid" in ''|*[!0-9]*) root_uid=unknown ;; esac
  pid=''; [ ! -r "$AGH/bin/agh.pid" ] || pid=$(cat "$AGH/bin/agh.pid")
  running=0
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -r "/proc/$pid/cmdline" ] && "$BB" tr '\000' ' ' < "/proc/$pid/cmdline" | "$BB" grep -Fq "$AGH/bin/AdGuardHome"; then running=1; fi
  listening_udp=0; is_protocol_listening '/proc/net/udp /proc/net/udp6' 07 && listening_udp=1
  listening_tcp=0; is_protocol_listening '/proc/net/tcp /proc/net/tcp6' 0A && listening_tcp=1
  listening=0; [ "$listening_udp" = 1 ] && [ "$listening_tcp" = 1 ] && listening=1
  read_redirect_status
  api GET /status 4 >/dev/null 2>&1; api_ok=$?
  filter_json=$(api GET /filtering/status 4 2>/dev/null); filter_ok=$?
  count=0; [ "$filter_ok" -ne 0 ] || count=$(rules_count "$filter_json")
  takeover=$(cat "$STATE/dns-takeover" 2>/dev/null); case "$takeover" in on|off) ;; *) takeover=unknown ;; esac
  classify_dns_health
  case "$state" in active) state=ready ;; paused) state=stopped ;; esac
  printf 'diag_root_uid=%s\ndiag_service_state=%s\ndiag_agh_binary_readable=%s\ndiag_loaded_rule_count=%s\n' \
    "$root_uid" "$state" "$([ -x "$AGH/bin/AdGuardHome" ] && echo yes || echo no)" "$count"
  printf 'diag_dns_listener=%s\ndiag_dns_listener_udp=%s\ndiag_dns_listener_tcp=%s\ndiag_dns_api=%s\ndiag_dns_takeover=%s\ndiag_dns_redirect=%s\n' \
    "$listening" "$listening_udp" "$listening_tcp" "$([ "$api_ok" = 0 ] && echo yes || echo no)" "$takeover" "$redirected"
  printf 'diag_ipv6_mode=passthrough\ndiag_private_dns=not-overridden\ndiag_vpn=may-bypass-or-intercept\n'
  printf 'diag_root_family=%s\ndiag_busybox=%s\n' "$(abp_root_family)" "$BB"
  printf 'diag_dns_core_running=%s\ndiag_dns_health=%s\n' "$running" "$health"
  # Only during explicit diagnosis; no additional overhead in 30s status polls.
  [ "$running" = 1 ] || pid=''
  [ ! -f "$AGH/scripts/footprint.sh" ] || "$BB" sh "$AGH/scripts/footprint.sh" "$pid"
}

case "$1" in
  --render-user-rules)
    write_personal_filter || exit 1
    printf '[+] Rendered %s personal rules.\n' "$USER_RULE_COUNT"
    ;;
  --ensure-shared) ensure_shared_filter ;;
  --apply-personal)
    if [ "${ABP_UPDATE_LOCKED:-0}" != 1 ]; then
      export ABP_UPDATE_LOCKED=1
      exec "$BB" flock -n "$STATE/update.lock" /system/bin/sh "$0" --apply-personal
    fi
    apply_personal_rules
    ;;
  --sync-shared)
    if [ "${ABP_UPDATE_LOCKED:-0}" != 1 ]; then
      export ABP_UPDATE_LOCKED=1
      exec "$BB" flock -n "$STATE/update.lock" /system/bin/sh "$0" --sync-shared
    fi
    sync_shared_rules
    ;;
  --status) status ;;
  --pause) "$AGH/scripts/tool.sh" stop ;;
  --resume)
    # start now reconciles a running resolver's listener and firewall state;
    # avoid an unnecessary DNS interruption when merely resuming.
    "$AGH/scripts/tool.sh" start && ensure_shared_filter
    ;;
  --auto-update)
    if [ "${ABP_UPDATE_LOCKED:-0}" != 1 ]; then
      mkdir -p "$STATE/webui-jobs" || exit 1
      export ABP_UPDATE_LOCKED=1
      exec "$BB" flock -n "$STATE/webui-jobs/worker.lock" "$BB" flock -n "$STATE/update.lock" "$BB" sh "$0" --auto-update
    fi
    auto_update_rules
    ;;
  --update)
    if [ "${ABP_UPDATE_LOCKED:-0}" != 1 ]; then
      export ABP_UPDATE_LOCKED=1
      exec "$BB" flock -n "$STATE/update.lock" /system/bin/sh "$0" --update
    fi
    update_rules
    ;;
  --rollback-history)
    key=$2
    case "$key" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9]*) ;; *) echo '[!] Invalid history key.' >&2; exit 1 ;; esac
    restore_snapshot "$key"
    ;;
  --rollback)
    latest=$($BB ls -1t "$HISTORY"/*.tar.gz 2>/dev/null | $BB head -n 1)
    [ -n "$latest" ] || { echo '[!] No saved snapshot.' >&2; exit 1; }
    key=${latest##*/}; key=${key%.tar.gz}
    exec /system/bin/sh "$0" --rollback-history "$key"
    ;;
  --diagnose) diagnose ;;
  --storage-report) "$BB" sh "$AGH/scripts/footprint.sh" ;;
  --observe) observe_capture "$2" "$3" "${4:-}" ;;
  --recover-observation) recover_observation ;;
  --filtering)
    case "$2" in on) enabled=true ;; off) enabled=false ;; *) echo '[!] Expected on or off.' >&2; exit 1 ;; esac
    filtering=$(api GET /filtering/status 4) || { echo '[!] AdGuard Home API is unavailable.' >&2; exit 1; }
    interval=$(printf '%s' "$filtering" | "$BB" grep -Eo '"interval"[[:space:]]*:[[:space:]]*[0-9]+' | "$BB" head -n 1 | "$BB" cut -d: -f2 | "$BB" tr -d '[:space:]')
    case "$interval" in ''|*[!0-9]*) echo '[!] Cannot read filter update interval.' >&2; exit 1 ;; esac
    api POST /filtering/config "{\"enabled\":$enabled,\"interval\":$interval}" 8 || exit 1
    echo "[+] DNS filtering $2; DNS resolver remains available."
    ;;
  --takeover)
    case "$2" in
      off)
        "$AGH/scripts/iptables.sh" disable || exit 1
        printf 'off\n' > "$STATE/dns-takeover.tmp" && chmod 600 "$STATE/dns-takeover.tmp" && mv "$STATE/dns-takeover.tmp" "$STATE/dns-takeover" || exit 1
        echo '[+] DNS redirection disabled; AdGuard Home remains available.'
        ;;
      on)
        pid=''; [ ! -r "$AGH/bin/agh.pid" ] || pid=$(cat "$AGH/bin/agh.pid")
        is_our_process "$pid" || { echo '[!] AdGuard Home is not running.' >&2; exit 1; }
        is_dns_listening || { echo '[!] Both TCP and UDP DNS listeners must be ready before redirecting.' >&2; exit 1; }
        "$AGH/scripts/iptables.sh" enable || { "$AGH/scripts/iptables.sh" disable >/dev/null 2>&1; exit 1; }
        printf 'on\n' > "$STATE/dns-takeover.tmp" && chmod 600 "$STATE/dns-takeover.tmp" && mv "$STATE/dns-takeover.tmp" "$STATE/dns-takeover" || { "$AGH/scripts/iptables.sh" disable >/dev/null 2>&1; exit 1; }
        echo '[+] DNS redirection enabled after TCP and UDP listener checks.'
        ;;
    esac
    ;;
  --restart)
    "$AGH/scripts/tool.sh" stop || exit 1
    "$AGH/scripts/tool.sh" start
    ;;
  --factory-reset)
    exec "$BB" sh "$AGH/scripts/factory-reset.sh" "${2:-}"
    ;;
  --check-domain)
    domain=$(printf '%s' "$2" | $BB tr '[:upper:]' '[:lower:]')
    valid_domain "$domain" || { echo '[!] Invalid domain.' >&2; exit 1; }
    api GET "/filtering/check_host?name=$domain" 15
    ;;
  --set-auto-update)
    case "$2" in on) interval=24 ;; off) interval=0 ;; *) exit 1 ;; esac
    pid=''; [ ! -r "$AGH/bin/agh.pid" ] || pid=$(cat "$AGH/bin/agh.pid")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -r "/proc/$pid/cmdline" ] && "$BB" tr '\000' ' ' < "/proc/$pid/cmdline" | "$BB" grep -Fq "$AGH/bin/AdGuardHome"; then
      filtering=$(api GET /filtering/status 4) || exit 1
      enabled=$(printf '%s' "$filtering" | json_top_bool enabled)
      case "$enabled" in true|false) ;; *) echo '[!] Cannot read the current filtering state.' >&2; exit 1 ;; esac
      api POST /filtering/config "{\"enabled\":$enabled,\"interval\":$interval}" 5
    else
      sed -i "s/^[[:space:]]*filters_update_interval:.*/  filters_update_interval: $interval/" "$AGH/bin/AdGuardHome.yaml"
    fi
    ;;
  *) echo '[!] Unsupported action.' >&2; exit 1 ;;
esac
