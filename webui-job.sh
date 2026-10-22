#!/system/bin/sh
MODDIR=${0%/*}
DIR=/data/adb/bindhosts_personal/webui-jobs
AGH=/data/adb/adblockpro
CONFIG=$MODDIR/webui-config.sh
umask 077
. "$MODDIR/scripts/compat.sh" || exit 1

prepare_worker_cgroup() {
  local worker_groups
  [ -f /proc/self/cgroup ] || return 0
  worker_groups=$("$BB" cat /proc/self/cgroup) || return 1
  if printf '%s\n' "$worker_groups" | "$BB" grep -Eq '^0::/(apps/)?uid_[0-9]+(/|$)'; then
    # nohup keeps the manager's freezer membership; move before spawning children.
    { printf '%s\n' "$$" > /sys/fs/cgroup/cgroup.procs; } 2>/dev/null || return 1
    worker_groups=$("$BB" cat /proc/self/cgroup) || return 1
    printf '%s\n' "$worker_groups" | "$BB" grep -qx '0::/' || return 1
  fi
  return 0
}

# Keep only the last 200 completed operations. In-progress jobs have no .done.
prune_jobs() {
  for file in "$DIR"/*.done; do
    [ -f "$file" ] || continue
    id=${file##*/}; id=${id%.done}
    case "$id" in ''|*[!0-9]*) continue ;; esac
    printf '%s\n' "$id"
  done | "$BB" sort -r | "$BB" tail -n +201 | while IFS= read -r id; do
    case "$id" in ''|*[!0-9]*) continue ;; esac
    rm -f "$DIR/$id.log" "$DIR/$id.done" "$DIR/$id.action"
  done
}

case "$1" in
 dns-info|dns-test)
  dns_helper="$AGH/bin/adblock-bootstrap"
  [ -x "$dns_helper" ] || { echo '[!] DNS 管理组件不可用。' >&2; exit 1; }
  if [ "$1" = dns-info ]; then exec "$dns_helper" dns info; fi
  case "$2" in ''|*[!A-Za-z0-9+/=]*) exit 1;; esac
  [ ${#2} -le 24000 ] || exit 1
  printf '%s' "$2" | "$BB" base64 -d | "$dns_helper" dns test
  exit "$?"
  ;;
 ai-status|ai-config|ai-clear|ai-start|ai-poll)
  if [ -e "$AGH/factory-reset.active" ]; then
   reset_pid=$(cat "$AGH/factory-reset.active" 2>/dev/null)
   case "$reset_pid" in ''|*[!0-9]*) reset_pid='' ;; esac
   if [ -n "$reset_pid" ] && kill -0 "$reset_pid" 2>/dev/null; then
    if [ ! -r "/proc/$reset_pid/cmdline" ] || "$BB" tr '\000' ' ' < "/proc/$reset_pid/cmdline" | "$BB" grep -Fq "$AGH/scripts/factory-reset.sh"; then
     echo '[!] 默认设置恢复正在执行，请等待完成后重试。' >&2; exit 1
    fi
   fi
   rm -f "$AGH/factory-reset.active"
  fi
  ai=/data/adb/adblockpro/bin/adblock-ai
  [ -x "$ai" ] || { echo 'AI 分析组件不可用，请安装包含此功能的测试包。' >&2; exit 1; }
  case "$1" in
   ai-status) exec "$ai" status ;;
   ai-clear) exec "$ai" clear ;;
   ai-poll) case "$2" in ''|*[!0-9]*) exit 1;; esac; [ ${#2} -le 20 ] || exit 1; exec "$ai" poll "$2" ;;
   ai-config) payload=$2; operation=configure ;;
   ai-start) case "$2" in ''|*[!0-9]*) exit 1;; esac; [ ${#2} -le 20 ] || exit 1; payload=$3; operation=start ;;
  esac
  case "$payload" in ''|*[!A-Za-z0-9+/=]*) exit 1;; esac
  [ ${#payload} -le 24000 ] || exit 1
  # AI credentials and domain payloads must never enter operation logs.
  if [ "$operation" = start ]; then
   printf '%s' "$payload" | "$BB" base64 -d | "$ai" start "$2"
  else
   printf '%s' "$payload" | "$BB" base64 -d | "$ai" configure
  fi
  exit "$?"
  ;;
 config)
  case "$2" in
   list-whitelist|list-blacklist|shared-rules) ;;
   import-lists) case "$3" in ''|*[!A-Za-z0-9+/=]*) exit 1 ;; esac; [ ${#3} -le 98304 ] || exit 1 ;;
   export-rules) case "$3" in local|shared) ;; *) exit 1 ;; esac ;;
   export-file) case "$3" in operation-logs|observed-domains) ;; *) exit 1 ;; esac; case "$4" in ''|*[!0-9]*) exit 1 ;; esac; [ ${#4} -le 20 ] || exit 1; case "$5" in ''|*[!A-Za-z0-9+/=]*) exit 1 ;; esac; [ ${#5} -le 90000 ] || exit 1 ;;
   list-sources) case "$3" in ''|light|balanced|strict) ;; *) exit 1;; esac ;;
   add-whitelist|add-blacklist|remove-whitelist|remove-blacklist) echo "$3" | "$BB" grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' || exit 1 ;;
   auto-update|autostart) case "$3" in on|off) ;; *) exit 1;; esac ;;
   set-mode) case "$3" in light|balanced|strict) ;; *) exit 1;; esac ;;
   set-source) case "$4" in on|off) ;; *) exit 1;; esac; case "$5" in ''|light|balanced|strict) ;; *[!0-9]*) exit 1;; esac; [ ${#5} -le 20 ] || exit 1; case "$3" in shared) ;; https://*) [ ${#3} -le 2048 ] || exit 1 ;; *) exit 1;; esac ;;
   add-source) case "$3" in https://*) [ ${#3} -le 2048 ] || exit 1 ;; *) exit 1;; esac; name_bytes=$(printf '%s' "$4" | wc -c | tr -d '[:space:]'); [ "$name_bytes" -ge 1 ] && [ "$name_bytes" -le 192 ] || exit 1; name_lines=$(printf '%s' "$4" | wc -l | tr -d '[:space:]'); [ "$name_lines" -eq 0 ] || exit 1; clean_bytes=$(printf '%s' "$4" | "$BB" tr -d '[:cntrl:]' | wc -c | tr -d '[:space:]'); [ "$clean_bytes" -eq "$name_bytes" ] || exit 1 ;;
   rename-source) case "$3" in shared) ;; https://*) [ ${#3} -le 2048 ] || exit 1 ;; *) exit 1;; esac; name_bytes=$(printf '%s' "$4" | wc -c | tr -d '[:space:]'); [ "$name_bytes" -ge 1 ] && [ "$name_bytes" -le 192 ] || exit 1; name_lines=$(printf '%s' "$4" | wc -l | tr -d '[:space:]'); [ "$name_lines" -eq 0 ] || exit 1; clean_bytes=$(printf '%s' "$4" | "$BB" tr -d '[:cntrl:]' | wc -c | tr -d '[:space:]'); [ "$clean_bytes" -eq "$name_bytes" ] || exit 1 ;;
   edit-source) case "$3" in https://*) [ ${#3} -le 2048 ] || exit 1 ;; *) exit 1;; esac; case "$4" in https://*) [ ${#4} -le 2048 ] || exit 1 ;; *) exit 1;; esac; case "$5" in ''|*[!0-9]*) exit 1;; esac; [ ${#5} -le 20 ] || exit 1 ;;
   set-source|remove-source) case "$3" in shared) ;; https://*) [ ${#3} -le 2048 ] || exit 1 ;; *) exit 1;; esac ;;
   *) exit 1;;
  esac
  # Serialize configuration writes with DNS worker operations across WebUI
  # sessions. Reads intentionally remain non-blocking.
  case "$2" in
   list-whitelist|list-blacklist|list-sources|shared-rules|export-file) ;;
   *)
    if [ "${ABP_JOB_CONFIG_LOCKED:-0}" != 1 ]; then
     mkdir -p "$DIR" || exit 1
     export ABP_JOB_CONFIG_LOCKED=1
     exec "$BB" flock -n "$DIR/worker.lock" "$BB" sh "$0" "$@"
    fi
    ;;
  esac
  case "$2" in
    set-source)
     case "$5" in ''|light|balanced|strict) result=$(sh "$CONFIG" "$2" "$3" "$4" "$5" 2>&1); event_id=$6 ;; *) result=$(sh "$CONFIG" "$2" "$3" "$4" 2>&1); event_id=$5 ;; esac
     ;;
   add-source) result=$(sh "$CONFIG" "$2" "$3" "$4" 2>&1); event_id=$5 ;;
   rename-source) result=$(sh "$CONFIG" "$2" "$3" "$4" 2>&1); event_id=$5 ;;
   edit-source) result=$(sh "$CONFIG" "$2" "$3" "$4" 2>&1); event_id=$5 ;;
   list-sources) result=$(sh "$CONFIG" "$2" "$3" 2>&1); event_id='' ;;
   shared-rules) result=$(sh "$CONFIG" "$2" 2>&1); event_id='' ;;
   export-rules) result=$(sh "$CONFIG" "$2" "$3" "$4" 2>&1); event_id=$4 ;;
   export-file) result=$(sh "$CONFIG" "$2" "$3" "$4" "$5" 2>&1); event_id='' ;;
   *) result=$(sh "$CONFIG" "$2" "$3" 2>&1); event_id=$4 ;;
  esac
  code=$?
  printf '%s\n' "$result"
  case "$2" in
   add-whitelist|add-blacklist|remove-whitelist|remove-blacklist|import-lists|export-rules|auto-update|autostart|set-mode|set-source|add-source|remove-source|rename-source|edit-source) loggable=1 ;;
   *) loggable=0 ;;
  esac
  case "$event_id" in ''|*[!0-9]*) loggable=0 ;; esac
  if [ "$loggable" = 1 ] && [ ${#event_id} -le 20 ]; then
   mkdir -p "$DIR" || exit "$code"
   argument=$3; [ "$2" != import-lists ] || argument=''
   printf '%s\n%s\n' "$2" "$argument" > "$DIR/$event_id.action.tmp" && mv "$DIR/$event_id.action.tmp" "$DIR/$event_id.action" || exit "$code"
   printf '%s\n' "$result" > "$DIR/$event_id.log.tmp" && mv "$DIR/$event_id.log.tmp" "$DIR/$event_id.log" || exit "$code"
   printf '%s\n' "$code" > "$DIR/$event_id.done.tmp" && mv "$DIR/$event_id.done.tmp" "$DIR/$event_id.done" || exit "$code"
  fi
  [ "$loggable" != 1 ] || prune_jobs
  exit "$code"
  ;;
 diagnose)
  case "$2" in ''|*[!0-9]*) exit 1;; esac
  [ ${#2} -le 20 ] || exit 1
  mkdir -p "$DIR" || exit 1
  [ ! -e "$DIR/$2.log" ] || exit 1
  printf '%s\n\n' diagnose > "$DIR/$2.action.tmp" && mv "$DIR/$2.action.tmp" "$DIR/$2.action" || exit 1
  echo '正在执行环境诊断…' > "$DIR/$2.log"
  sh "$MODDIR/bindhosts.sh" --diagnose >> "$DIR/$2.log" 2>&1
  code=$?
  [ "$code" = 0 ] && echo '[结果] 环境诊断完成' >> "$DIR/$2.log" || echo '[结果] 环境诊断未完成' >> "$DIR/$2.log"
  printf '%s\n' "$code" > "$DIR/$2.done.tmp" && mv "$DIR/$2.done.tmp" "$DIR/$2.done" || exit 1
  cat "$DIR/$2.log"
  exit "$code"
  ;;
 list)
  mkdir -p "$DIR"
  for file in "$DIR"/*.done; do [ -f "$file" ] || continue; key=${file##*/}; key=${key%.done}; printf '%s\n' "$key"; done | "$BB" sort -r | "$BB" head -n 8
  ;;
 recent)
  mkdir -p "$DIR" || exit 1
  keys="$DIR/.recent-keys.$$"
  for file in "$DIR"/*.log; do [ -f "$file" ] || continue; key=${file##*/}; key=${key%.log}; printf '%s\n' "$key"; done |
   "$BB" sort -r | "$BB" head -n 120 > "$keys" || { rm -f "$keys"; exit 1; }
  while IFS= read -r key; do
   case "$key" in ''|*[!0-9]*) continue ;; esac
   if [ -f "$DIR/$key.done" ]; then code=$(cat "$DIR/$key.done"); [ "$code" = 0 ] && status=success || status=failure; else status=running; fi
   action=unknown; argument=''
   if [ -f "$DIR/$key.action" ]; then action=$(sed -n '1p' "$DIR/$key.action"); argument=$(sed -n '2p' "$DIR/$key.action"); fi
   summary=$(tail -n 1 "$DIR/$key.log" 2>/dev/null | tr '\t\r\n' '   ' | cut -c 1-240)
   printf '%s\t%s\t%s\t%s\t%s\n' "$key" "$status" "$action" "$argument" "$summary"
  done < "$keys"
  rm -f "$keys"
  ;;
 recent-full)
  mkdir -p "$DIR" || exit 1
  keys="$DIR/.recent-full-keys.$$"
  for file in "$DIR"/*.log; do [ -f "$file" ] || continue; key=${file##*/}; key=${key%.log}; printf '%s\n' "$key"; done |
   "$BB" sort -r | "$BB" head -n 20 > "$keys" || { rm -f "$keys"; exit 1; }
  printf '最近操作日志（最多 20 条；每条命令输出最多保留末尾 4 KiB）\n'
  while IFS= read -r key; do
   case "$key" in ''|*[!0-9]*) continue ;; esac
   action=unknown; argument=''; status=running
   if [ -f "$DIR/$key.action" ]; then action=$(sed -n '1p' "$DIR/$key.action"); argument=$(sed -n '2p' "$DIR/$key.action"); fi
   if [ -f "$DIR/$key.done" ]; then code=$(cat "$DIR/$key.done"); [ "$code" = 0 ] && status=success || status=failure; fi
   printf '\n===== %s | %s | %s | %s =====\n' "$key" "$status" "$action" "$argument"
   bytes=$(wc -c < "$DIR/$key.log" 2>/dev/null); case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
   [ "$bytes" -le 4096 ] || printf '[日志较长，仅复制末尾 4 KiB]\n'
   tail -c 4096 "$DIR/$key.log" 2>/dev/null
   printf '\n'
  done < "$keys"
  rm -f "$keys"
  ;;
 detail)
  case "$2" in ''|*[!0-9]*) exit 1;; esac
  [ ${#2} -le 20 ] || exit 1
  [ -f "$DIR/$2.log" ] || exit 1
  tail -c 12000 "$DIR/$2.log"
  ;;
 clear)
  mkdir -p "$DIR" || exit 1
  # Never delete an in-progress job's .log: poll needs that file even
  # when another WebUI session clears completed records.
  for file in "$DIR"/*.done; do
   [ -f "$file" ] || continue
   key=${file##*/}; key=${key%.done}
   case "$key" in ''|*[!0-9]*) continue ;; esac
   rm -f "$DIR/$key.log" "$DIR/$key.done" "$DIR/$key.action" || exit 1
  done
  echo '已清空已完成任务日志；进行中任务、规则历史与当前规则未更改。'
  ;;
 start)
  case "$2" in ''|*[!0-9]* ) exit 1;; esac
  [ ${#2} -le 20 ] || exit 1
  case "$3" in --update|--sync-shared|--apply-personal|--pause|--resume|--rollback|--rollback-history|--filtering|--takeover|--restart|--factory-reset|--diagnose|--observe|--dns-save|--dns-restore) ;; *) exit 1;; esac
  case "$3" in --dns-save|--dns-restore) case "$4" in ''|*[!A-Za-z0-9+/=]*) exit 1;; esac; [ ${#4} -le 24000 ] || exit 1;; esac
  case "$3" in --filtering|--takeover) case "$4" in on|off) ;; *) exit 1;; esac ;; esac
  if [ "$3" = --observe ]; then case "$4" in 5|10|15|30|60|90) ;; *) exit 1;; esac; fi
  if [ "$3" = --rollback-history ]; then echo "$4" | "$BB" grep -Eq '^[0-9]{14}-[0-9]+$' || exit 1; fi
  mkdir -p "$DIR" || exit 1
  # Atomic exclusive creation rejects a duplicate job ID.
  ( set -C; : > "$DIR/$2.log" ) 2>/dev/null || exit 1
  log_argument=$4
  case "$3" in --dns-save|--dns-restore) log_argument='' ;; esac
  printf '%s\n%s\n' "$3" "$log_argument" > "$DIR/$2.action.tmp" && mv "$DIR/$2.action.tmp" "$DIR/$2.action" || exit 1
  case "$3" in --apply-personal) echo "正在应用个人名单，无需下载订阅…" > "$DIR/$2.log" ;; --observe) echo "准备临时观察 $4 秒 DNS 域名…" > "$DIR/$2.log" ;; *) echo '任务已提交，正在等待下载或校验结果…' > "$DIR/$2.log" ;; esac
  "$BB" nohup "$BB" sh "$0" worker "$2" "$3" "$4" "${5:-}" </dev/null >/dev/null 2>&1 &
  echo started
  ;;
 worker)
  case "$2" in ''|*[!0-9]* ) exit 1;; esac
  [ ${#2} -le 20 ] || exit 1
  case "$3" in --update|--sync-shared|--apply-personal|--pause|--resume|--rollback|--rollback-history|--filtering|--takeover|--restart|--factory-reset|--diagnose|--observe|--dns-save|--dns-restore) ;; *) exit 1;; esac
  case "$3" in --dns-save|--dns-restore) case "$4" in ''|*[!A-Za-z0-9+/=]*) exit 1;; esac; [ ${#4} -le 24000 ] || exit 1;; esac
  case "$3" in --filtering|--takeover) case "$4" in on|off) ;; *) exit 1;; esac ;; esac
  if [ "$3" = --observe ]; then case "$4" in 5|10|15|30|60|90) ;; *) exit 1;; esac; fi
  # Serialize privileged mutations from multiple WebUI sessions.
  if prepare_worker_cgroup; then
    "$BB" flock -n "$DIR/worker.lock" "$BB" sh "$0" execute "$2" "$3" "$4" "${5:-}" >> "$DIR/$2.log" 2>&1
    result=$?
  else
    echo '[!] Cannot leave the app freezer; operation was not started.' >> "$DIR/$2.log"
    result=1
  fi
  if [ "$result" != 0 ]; then
    echo "[!] 任务执行失败（退出码 $result）；请查看上方具体错误。" >> "$DIR/$2.log"
  fi
  printf '%s\n' "$result" > "$DIR/$2.tmp" && mv "$DIR/$2.tmp" "$DIR/$2.done"
  bytes=$(wc -c < "$DIR/$2.log" 2>/dev/null)
  if [ "${bytes:-0}" -gt 65536 ] 2>/dev/null; then
    "$BB" tail -c 65536 "$DIR/$2.log" > "$DIR/$2.trim" && mv "$DIR/$2.trim" "$DIR/$2.log"
  fi
  prune_jobs
  ;;
 execute)
  case "$2" in ''|*[!0-9]* ) exit 1;; esac
  [ ${#2} -le 20 ] || exit 1
  case "$3" in --update|--sync-shared|--apply-personal|--pause|--resume|--rollback|--rollback-history|--filtering|--takeover|--restart|--factory-reset|--diagnose|--observe|--dns-save|--dns-restore) ;; *) exit 1 ;; esac
  case "$3" in --dns-save|--dns-restore) case "$4" in ''|*[!A-Za-z0-9+/=]*) exit 1;; esac; [ ${#4} -le 24000 ] || exit 1;; esac
  if [ "$3" = --observe ]; then
    exec /system/bin/sh "$MODDIR/bindhosts.sh" "$3" "$4" "$2" "${5:-}"
  elif [ "$3" = --factory-reset ]; then
    exec /system/bin/sh "$MODDIR/bindhosts.sh" "$3" "$2"
  else
    exec /system/bin/sh "$MODDIR/bindhosts.sh" "$3" "$4"
  fi
  ;;
 poll)
  case "$2" in ''|*[!0-9]* ) exit 1;; esac
  [ ${#2} -le 20 ] || exit 1
  [ -f "$DIR/$2.log" ] || exit 1
  tail -c 12000 "$DIR/$2.log"
  if [ -f "$DIR/$2.done" ]; then printf '\nJOB_DONE='; cat "$DIR/$2.done"; fi
  ;;
 observe-result)
  case "$2" in ''|*[!0-9]*) exit 1 ;; esac
  [ ${#2} -le 20 ] || exit 1
  result="/data/adb/bindhosts_personal/observations/$2.result"
  [ -f "$result" ] || { echo '[!] Observation result is missing or has expired.' >&2; exit 1; }
  cat "$result"
  ;;
 observe-clean)
  case "$2" in ''|*[!0-9]*) exit 1 ;; esac
  [ ${#2} -le 20 ] || exit 1
  rm -f "/data/adb/bindhosts_personal/observations/$2.result" "/data/adb/bindhosts_personal/observations/$2.result.tmp" "/data/adb/bindhosts_personal/observations/$2.page.tmp" "/data/adb/bindhosts_personal/observations/$2.meta"
  ;;
 debug-save)
  # Debug packages retain only the already-aggregated domain summary, never raw query logs.
  [ -f "$MODDIR/debug-build" ] || exit 0
  encoded=$2
  [ -n "$encoded" ] && [ ${#encoded} -le 100000 ] || exit 1
  case "$encoded" in *[!A-Za-z0-9+/=]*) exit 1 ;; esac
  debug_dir=/data/adb/bindhosts_personal/debug
  mkdir -p "$debug_dir" || exit 1
  chmod 700 "$debug_dir" || exit 1
  tmp="$debug_dir/observation.tmp.$$"
  printf '%s' "$encoded" | "$BB" base64 -d > "$tmp" || { rm -f "$tmp"; exit 1; }
  "$BB" awk -F '\t' '
    function numeric(value) { return value ~ /^[0-9]+$/ }
    NR == 1 { if ($1 != "captured_at" || NF != 2 || !numeric($2) || length($2) < 9 || length($2) > 11) bad=1; next }
    NR == 2 { if ($1 != "started_at" || NF != 2 || !numeric($2) || length($2) < 9 || length($2) > 11) bad=1; next }
    NR == 3 { if ($1 != "domain_count" || NF != 2 || !numeric($2) || $2 > 2000) bad=1; total=$2; next }
    NR == 4 { if ($1 != "included_count" || NF != 2 || !numeric($2) || $2 > 200) bad=1; expected=$2; if (expected != (total > 200 ? 200 : total)) bad=1; next }
    NR == 5 { if ($1 != "source_truncated" || NF != 2 || ($2 != "0" && $2 != "1")) bad=1; next }
    NR == 6 { if ($0 != "domain\trequests\tlast_seen\treason\tfilter_id") bad=1; next }
    NR > 206 { bad=1; exit }
    NR > 6 {
      rows++
      if (NF != 5 || $1 !~ /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/ || length($1) > 253 || !numeric($2) || !numeric($3) || $4 !~ /^[A-Za-z0-9_-]*$/ || ($5 != "" && !numeric($5)) || seen[$1]++) bad=1
    }
    END { if (NR < 6 || rows != expected || bad) exit 1 }
  ' "$tmp" || { rm -f "$tmp"; echo '[!] Invalid debug observation summary.' >&2; exit 1; }
  chmod 600 "$tmp" && mv -f "$tmp" "$debug_dir/latest-observation.tsv" || { rm -f "$tmp"; exit 1; }
  ;;
 *) exit 1;;
esac
