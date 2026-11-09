#!/system/bin/sh
# Append module history and retain a bounded, readable tail.
umask 077

[ -n "${BB:-}" ] || exit 1
locked=0
if [ "${1:-}" = --locked ]; then
  locked=1
  shift
fi
[ "$#" -eq 3 ] || exit 2
log=$1
mode=$2
payload=$3
case "$mode" in line|file) ;; *) exit 2 ;; esac
lock=$log.lock

if [ "$locked" = 0 ]; then
  exec "$BB" flock "$lock" "$BB" sh "$0" --locked "$log" "$mode" "$payload"
fi

window=$log.rotate-window.tmp
aligned=$log.rotate-aligned.tmp
old_raw=$log.rotate-old-raw.tmp
old_log=$log.rotate-old.tmp
new_raw=$log.rotate-new-raw.tmp
new_log=$log.rotate-new.tmp
cleanup() {
  "$BB" rm -f "$window" "$aligned" "$old_raw" "$old_log" "$new_raw" "$new_log"
}
trap cleanup 0
# A prior forced shutdown may have left temporary rotation files behind.
cleanup

rotate_history() {
  [ -f "$log" ] || return 0
  set -- $("$BB" wc -c < "$log")
  size=${1:-0}
  case "$size" in ''|*[!0-9]*) return 0 ;; esac
  rotate=$("$BB" awk -v size="$size" 'BEGIN { if (size > 1048576) print 1; else print 0 }') || return 1
  [ "$rotate" = 1 ] || return 0

  # Keep the newest MiB split into two readable files. Drop partial lines at
  # byte boundaries so a rotation never leaves broken UTF-8 in the logs.
  "$BB" tail -c 1048576 "$log" > "$window" || return 1
  "$BB" sed '1d' "$window" > "$aligned" || return 1
  "$BB" head -c 524288 "$aligned" > "$old_raw" || return 1
  "$BB" sed '$d' "$old_raw" > "$old_log" || return 1
  "$BB" tail -c +524289 "$aligned" > "$new_raw" || return 1
  "$BB" sed '1d' "$new_raw" > "$new_log" || return 1
  chmod 600 "$old_log" "$new_log" || return 1
  mv -f "$old_log" "$log.1" && mv -f "$new_log" "$log" || return 1
}

rotate_history || exit 1
case "$mode" in
  line) printf '%s\n' "$payload" >> "$log" || exit 1 ;;
  file) [ -r "$payload" ] && "$BB" cat "$payload" >> "$log" || exit 1 ;;
esac
chmod 600 "$log" || exit 1
rotate_history || exit 1
