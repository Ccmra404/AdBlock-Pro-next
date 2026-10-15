#!/system/bin/sh
MODDIR=${0%/*}
DIR=/data/adb/bindhosts_personal/webui-jobs
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
 config)
  case "$2" in
   list-whitelist|list-blacklist|shared-rules) ;;
   import-lists) case "$3" in ''|*[!A-Za-z0-9+/=]*) exit 1 ;; esac; [ ${#3} -le 98304 ] || exit 1 ;;
   export-rules) case "$3" in local|shared) ;; *) exit 1 ;; esac ;;
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
   list-whitelist|list-blacklist|list-sources|shared-rules) ;;
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
  case "$3" in --update|--sync-shared|--pause|--resume|--rollback|--rollback-history|--filtering|--takeover|--restart|--diagnose|--observe) ;; *) exit 1;; esac
  case "$3" in --filtering|--takeover) case "$4" in on|off) ;; *) exit 1;; esac ;; esac
  if [ "$3" = --observe ]; then case "$4" in 5|10|15|30|60|90) ;; *) exit 1;; esac; fi
  if [ "$3" = --rollback-history ]; then echo "$4" | "$BB" grep -Eq '^[0-9]{14}-[0-9]+$' || exit 1; fi
  mkdir -p "$DIR" || exit 1
  # Atomic exclusive creation rejects a duplicate job ID.
  ( set -C; : > "$DIR/$2.log" ) 2>/dev/null || exit 1
  printf '%s\n%s\n' "$3" "$4" > "$DIR/$2.action.tmp" && mv "$DIR/$2.action.tmp" "$DIR/$2.action" || exit 1
  case "$3" in --observe) echo "准备临时观察 $4 秒 DNS 域名…" > "$DIR/$2.log" ;; *) echo '任务已提交，正在等待下载或校验结果…' > "$DIR/$2.log" ;; esac
  "$BB" nohup "$BB" sh "$0" worker "$2" "$3" "$4" "${5:-}" </dev/null >/dev/null 2>&1 &
  echo started
  ;;
 worker)
  case "$2" in ''|*[!0-9]* ) exit 1;; esac
  [ ${#2} -le 20 ] || exit 1
  case "$3" in --update|--sync-shared|--pause|--resume|--rollback|--rollback-history|--filtering|--takeover|--restart|--diagnose|--observe) ;; *) exit 1;; esac
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
    echo "[!] Task failed or another DNS operation is already running (exit $result)." >> "$DIR/$2.log"
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
  case "$3" in --update|--sync-shared|--pause|--resume|--rollback|--rollback-history|--filtering|--takeover|--restart|--diagnose|--observe) ;; *) exit 1 ;; esac
  if [ "$3" = --observe ]; then
    exec /system/bin/sh "$MODDIR/bindhosts.sh" "$3" "$4" "$2" "${5:-}"
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
  rm -f "/data/adb/bindhosts_personal/observations/$2.result" "/data/adb/bindhosts_personal/observations/$2.meta"
  ;;
 *) exit 1;;
esac
