#!/system/bin/sh
# Shared tool discovery for installers, boot scripts and WebUI root shells.
abp_root_family() {
  local installed_family
  if [ "${APATCH:-false}" = true ]; then printf 'APatch'
  elif [ "${KSU:-false}" = true ]; then printf 'KernelSU'
  elif [ -n "${MAGISK_VER_CODE:-}" ]; then printf 'Magisk'
  else
    if [ -r /data/adb/bindhosts_personal/root-family ]; then
      IFS= read -r installed_family < /data/adb/bindhosts_personal/root-family
      case "$installed_family" in KernelSU|Magisk|APatch) printf '%s' "$installed_family"; return 0 ;; esac
    fi
    case "${BB:-}" in
      /data/adb/ap/*) printf 'APatch' ;;
      /data/adb/ksu/*) printf 'KernelSU' ;;
      /data/adb/magisk/*) printf 'Magisk' ;;
      *) printf 'unknown' ;;
    esac
  fi
}

abp_find_busybox() {
  local preferred candidate applets applet complete
  case "$(abp_root_family)" in
    APatch) preferred=/data/adb/ap/bin/busybox ;;
    KernelSU) preferred=/data/adb/ksu/bin/busybox ;;
    Magisk) preferred=/data/adb/magisk/busybox ;;
  esac
  for candidate in "$preferred" "${BB:-}" /data/adb/ksu/bin/busybox \
    /data/adb/magisk/busybox /data/adb/ap/bin/busybox "$(command -v busybox 2>/dev/null)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    applets=$("$candidate" --list 2>/dev/null) || continue
    complete=1
    for applet in sh awk flock nohup setuidgid inotifyd; do
      case "
$applets
" in *"
$applet
"*) ;; *) complete=0; break ;; esac
    done
    [ "$complete" = 1 ] || continue
    BB=$candidate
    export BB ASH_STANDALONE=1
    PATH="${BB%/*}:$PATH"
    export PATH
    return 0
  done
  echo '[AdBlock Pro] A complete BusyBox is required (sh, awk, flock, nohup, setuidgid, inotifyd).' >&2
  return 1
}

abp_find_curl() {
  local candidate
  for candidate in "${CURL:-}" /data/adb/adblockpro/bin/curl /system/bin/curl "$(command -v curl 2>/dev/null)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  echo '[AdBlock Pro] curl is missing; local DNS management needs curl.' >&2
  return 1
}

# Some Android kernels incorrectly reject BusyBox mkdir -p when it probes /.
abp_mkdir_one() {
  local dir parent
  dir=$1
  [ -n "$dir" ] || { echo 'mkdir: empty directory name' >&2; return 1; }
  while [ "$dir" != / ] && [ "${dir%/}" != "$dir" ]; do dir=${dir%/}; done
  [ -d "$dir" ] && return 0
  case "$dir" in
    */*) parent=${dir%/*}; [ -n "$parent" ] || parent=/ ;;
    *) parent=. ;;
  esac
  [ "$parent" != "$dir" ] || return 1
  abp_mkdir_one "$parent" || return 1
  [ -d "$dir" ] && return 0
  case "$dir" in .|..|*/.|*/..) return 1 ;; esac
  "$BB" mkdir -- "$dir" || [ -d "$dir" ]
}

abp_mkdir_p() {
  local dir
  [ "$#" -gt 0 ] || { echo 'mkdir: missing directory name' >&2; return 1; }
  for dir do abp_mkdir_one "$dir" || return 1; done
}

# Keep module history storage bounded while serializing every writer with the
# rotation itself. Preserve the newest complete log lines across two files.
abp_append_history() {
  [ "$#" -eq 3 ] || return 2
  "$BB" sh "${ABP_HISTORY_LOG_SCRIPT:-/data/adb/adblockpro/scripts/history-log.sh}" "$@"
}

abp_find_busybox || return 1
