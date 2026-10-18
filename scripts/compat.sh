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

abp_find_busybox || return 1
