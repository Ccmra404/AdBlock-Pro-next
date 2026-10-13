#!/system/bin/sh
# Quick polls never scan memory maps. Explicit diagnostics sample one rollup
# and cache it with the process start time; the UI labels that sample's age.
AGH_DIR=${ABP_AGH_DIR:-/data/adb/adblockpro}
STATE_DIR=${ABP_STATE_DIR:-/data/adb/bindhosts_personal}
PROC_DIR=${ABP_PROC_DIR:-/proc}
mode=$1
pid=$2
rss=unavailable; pss=unavailable; source=unavailable; sampled_at=unavailable
cache="$STATE_DIR/dns-memory.sample"
umask 077

positive() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -gt 0 ] 2>/dev/null
}
identity() {
  positive "$pid" || return 1
  [ "$(cat "$AGH_DIR/bin/agh.pid" 2>/dev/null)" = "$pid" ] || return 1
  [ "$(tr '\000' '\n' < "$PROC_DIR/$pid/cmdline" 2>/dev/null | head -n 1)" = "$AGH_DIR/bin/AdGuardHome" ] || return 1
  # stat field 22 is starttime. Strip the parenthesised name first, since it
  # can contain spaces; PID alone is not sufficient after a process restart.
  awk '{ sub(/^.*\) /, ""); if ($20 ~ /^[0-9]+$/) print $20 }' "$PROC_DIR/$pid/stat" 2>/dev/null
}

start=$(identity) || start=''
if positive "$start"; then
  if [ "$mode" = quick ] && [ -r "$cache" ]; then
    read -r old_pid old_start old_rss old_pss old_time extra < "$cache"
    if [ "$old_pid" = "$pid" ] && [ "$old_start" = "$start" ] && [ -z "$extra" ] &&
       positive "$old_rss" && positive "$old_pss" && positive "$old_time" && [ "$old_rss" -ge "$old_pss" ]; then
      rss=$old_rss; pss=$old_pss; sampled_at=$old_time; source=rollup_sample
    fi
  elif [ "$mode" = sample ]; then
    # Parse RSS and PSS from one successful read, not two different snapshots.
    values=$(awk '
      /^Rss:/ && $2 ~ /^[0-9]+$/ && $3 == "kB" { r=$2 }
      /^Pss:/ && $2 ~ /^[0-9]+$/ && $3 == "kB" { p=$2 }
      END { print r+0, p+0 }
    ' "$PROC_DIR/$pid/smaps_rollup" 2>/dev/null) || values=''
    set -- $values
    if [ "$#" = 2 ] && positive "$1" && positive "$2" && [ "$1" -ge "$2" ]; then
      rss=$1; pss=$2; source=smaps_rollup; sampled_at=$(date +%s)
    fi
  fi
  if [ "$source" = unavailable ]; then
    value=$(awk '/^VmRSS:/ && $2 ~ /^[0-9]+$/ && $3 == "kB" { print $2; exit }' "$PROC_DIR/$pid/status" 2>/dev/null) || value=''
    if positive "$value"; then rss=$value; source=status_estimate; sampled_at=$(date +%s); fi
  fi
  # A stopped/replaced process invalidates the entire snapshot, including PSS.
  end=$(identity) || end=''
  if [ "$end" != "$start" ]; then
    rss=unavailable; pss=unavailable; source=unavailable; sampled_at=unavailable
  elif [ "$source" = smaps_rollup ]; then
    tmp="$cache.tmp.$$"
    printf '%s %s %s %s %s\n' "$pid" "$start" "$rss" "$pss" "$sampled_at" > "$tmp" &&
      chmod 600 "$tmp" && mv -f "$tmp" "$cache" || rm -f "$tmp"
  fi
fi
printf 'mem_rss_kb=%s\nmem_pss_kb=%s\nmem_source=%s\nmem_sampled_at=%s\nmem_pid=%s\n' "$rss" "$pss" "$source" "$sampled_at" "$pid"
