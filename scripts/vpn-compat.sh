#!/system/bin/sh
# Optional VPN/TUN compatibility for module-owned DNS interception.
AGH_DIR=${ABP_AGH_DIR:-/data/adb/adblockpro}
STATE_DIR=${ABP_STATE_DIR:-/data/adb/bindhosts_personal}
MOD_PATH=${ABP_MODULE_DIR:-/data/adb/modules/bindhosts_personal}
SYS_CLASS_NET=${ABP_SYS_CLASS_NET:-/sys/class/net}
PROC_ROOT=${ABP_PROC_ROOT:-/proc}
umask 077

if [ -z "${BB:-}" ]; then
  . "$AGH_DIR/scripts/compat.sh" || exit 1
fi

# Serialize takeover transitions with tool.sh start/stop and explicit user
# changes. The five-second service monitor must never wait behind boot startup.
if [ "${ABP_DNS_TRANSITION_LOCKED:-0}" != 1 ]; then
  export ABP_DNS_TRANSITION_LOCKED=1
  if [ "$1" = watch ]; then
    "$BB" flock -n "$STATE_DIR/dns-transition.lock" "$BB" sh "$0" "$@" >/dev/null 2>&1 || exit 0
    exit 0
  fi
  exec "$BB" flock "$STATE_DIR/dns-transition.lock" "$BB" sh "$0" "$@"
fi

STATE_FILE=$STATE_DIR/vpn-compat-state
COUNT_FILE=$STATE_DIR/vpn-clear-count
FIREWALL=$AGH_DIR/scripts/iptables.sh
HISTORY=$AGH_DIR/history.log

read_switch() {
  local value
  value=$(cat "$1" 2>/dev/null)
  case "$value" in on|off) printf '%s' "$value" ;; *) printf 'unknown' ;; esac
}

write_atomic() {
  local file value
  file=$1 value=$2
  printf '%s\n' "$value" > "$file.tmp.$$" && chmod 600 "$file.tmp.$$" && mv -f "$file.tmp.$$" "$file"
}

current_state() {
  local state
  state=$(cat "$STATE_FILE" 2>/dev/null)
  case "$state" in vpn|unknown|resume_wait|error) printf '%s' "$state" ;; *) printf 'none' ;; esac
}

log_transition() {
  local message
  message=$1
  printf '%s [VPN 兼容] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$message" >> "$HISTORY" 2>/dev/null || true
}

# Android VpnService normally exposes a tun* interface; kernel WireGuard
# exposes wg*. No VPN-specific address, package name or proxy is assumed.
# Return codes: 0 active, 1 absent, 2 unknown (sysfs could not be read).
detect_tunnel() {
  local names name flags unknown
  [ -d "$SYS_CLASS_NET" ] || return 2
  names=$(ls -1 "$SYS_CLASS_NET" 2>/dev/null) || return 2
  unknown=0
  for name in $names; do
    case "$name" in
      tun*|wg*)
        # The kernel exposes tunl0 even when no VPN is running. Only treat a
        # tunnel as active when its sysfs flags include IFF_UP; if the state
        # cannot be read, fail open instead of assuming the VPN is absent.
        flags=$(cat "$SYS_CLASS_NET/$name/flags" 2>/dev/null) || { unknown=1; continue; }
        case "$flags" in 0x[0-9a-fA-F]*|0X[0-9a-fA-F]*) ;; *) unknown=1; continue ;; esac
        [ $((flags & 1)) -ne 0 ] && return 0
        ;;
    esac
  done
  [ "$unknown" -eq 1 ] && return 2
  return 1
}

set_pause() {
  local reason previous firewall_state count
  reason=$1
  previous=$(current_state)
  # Avoid rewriting state and rebuilding firewall chains every five seconds
  # when the interface and bypass are already in the expected state.
  if [ "$previous" = "$reason" ]; then
    "$BB" sh "$FIREWALL" status >/dev/null 2>&1
    firewall_state=$?
    if [ "$firewall_state" -eq 1 ]; then
      count=$(cat "$COUNT_FILE" 2>/dev/null)
      [ "$count" = 0 ] || write_atomic "$COUNT_FILE" 0 || return 1
      return 0
    fi
  fi
  write_atomic "$COUNT_FILE" 0 || return 1
  if ! write_atomic "$STATE_FILE" "$reason"; then
    log_transition '无法保存自动暂停状态；未确认 DNS 重定向状态。'
    "$BB" sh "$FIREWALL" disable >/dev/null 2>&1 || true
    return 1
  fi
  if ! "$BB" sh "$FIREWALL" disable >/dev/null; then
    write_atomic "$STATE_FILE" error || true
    [ "$previous" = error ] || log_transition '移除 DNS 重定向失败；兼容状态异常，请检查防火墙。'
    return 1
  fi
  if [ "$reason" != "$previous" ]; then
    case "$reason" in
      vpn) log_transition '检测到 TUN/VPN 接口，已暂停本模块 DNS 重定向；过滤核心继续运行。' ;;
      unknown) log_transition '无法确认 VPN 接口状态，已暂时旁路 DNS 重定向以保持联网。' ;;
    esac
  fi
}

clear_pause() {
  local reason previous
  reason=${1:-auto}
  previous=$(current_state)
  rm -f "$STATE_FILE" "$COUNT_FILE"
  case "$reason:$previous" in
    auto:vpn|auto:unknown|auto:resume_wait|auto:error) log_transition 'VPN 接口状态已连续稳定，已按用户偏好恢复 DNS 重定向。' ;;
    manual:vpn|manual:unknown|manual:resume_wait|manual:error) log_transition '已按用户设置关闭 VPN 自动旁路，并按 DNS 接管偏好应用规则。' ;;
    takeover-off:vpn|takeover-off:unknown|takeover-off:resume_wait|takeover-off:error) log_transition '已按用户设置关闭 DNS 接管；VPN 自动恢复状态已清除。' ;;
  esac
}

dns_listener_ready() {
  local port_hex
  [ -r "$AGH_DIR/settings.conf" ] || return 1
  # The configured port is sourced from the trusted module settings file.
  . "$AGH_DIR/settings.conf"
  case "${redir_port:-}" in ''|*[!0-9]*) return 1 ;; esac
  [ "$redir_port" -ge 1 ] && [ "$redir_port" -le 65535 ] || return 1
  port_hex=$(printf '%04X' "$redir_port") || return 1
  "$BB" awk -v pat=":$port_hex\$" 'NR > 1 && $2 ~ pat && $4 == "07" { found=1 } END { exit !found }' \
    "$PROC_ROOT/net/udp" "$PROC_ROOT/net/udp6" 2>/dev/null || return 1
  "$BB" awk -v pat=":$port_hex\$" 'NR > 1 && $2 ~ pat && $4 == "0A" { found=1 } END { exit !found }' \
    "$PROC_ROOT/net/tcp" "$PROC_ROOT/net/tcp6" 2>/dev/null
}

core_ready() {
  local pid
  pid=$(cat "$AGH_DIR/bin/agh.pid" 2>/dev/null)
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ -r "$PROC_ROOT/$pid/cmdline" ] || return 1
  "$BB" tr '\000' ' ' < "$PROC_ROOT/$pid/cmdline" | "$BB" grep -Fq "$AGH_DIR/bin/AdGuardHome" || return 1
  dns_listener_ready
}

apply_redirect() {
  [ ! -f "$MOD_PATH/disable" ] && [ ! -f "$MOD_PATH/remove" ] || return 1
  core_ready || return 1
  "$BB" sh "$FIREWALL" enable || {
    "$BB" sh "$FIREWALL" disable >/dev/null 2>&1 || true
    write_atomic "$STATE_FILE" error || true
    log_transition '恢复 DNS 重定向失败；核心保持运行，等待后续重试。'
    return 1
  }
  clear_pause "${1:-auto}"
}

start_guard() {
  local detected previous
  [ "$(read_switch "$STATE_DIR/vpn-compat")" = on ] || { echo ready; return 0; }
  [ "$(read_switch "$STATE_DIR/dns-takeover")" = on ] || { echo ready; return 0; }
  detect_tunnel; detected=$?
  case "$detected" in
    0) set_pause vpn || return 1; echo paused-vpn ;;
    1)
      previous=$(current_state)
      case "$previous" in
        vpn|unknown|resume_wait|error)
          write_atomic "$STATE_FILE" resume_wait || return 1
          write_atomic "$COUNT_FILE" 0 || return 1
          echo resume-wait
          ;;
        *) echo ready ;;
      esac
      ;;
    *) set_pause unknown || return 1; echo paused-unknown ;;
  esac
}

watch() {
  local detected previous count
  [ "$(read_switch "$STATE_DIR/vpn-compat")" = on ] || exit 0
  [ "$(read_switch "$STATE_DIR/dns-takeover")" = on ] || {
    "$BB" sh "$FIREWALL" disable >/dev/null 2>&1 || exit 1
    clear_pause takeover-off
    exit 0
  }
  detect_tunnel; detected=$?
  case "$detected" in
    0) set_pause vpn ;;
    2) set_pause unknown ;;
    1)
      previous=$(current_state)
      case "$previous" in vpn|unknown|resume_wait|error)
        count=$(cat "$COUNT_FILE" 2>/dev/null)
        case "$count" in ''|*[!0-9]*) count=0 ;; esac
        count=$((count + 1))
        printf '%s\n' "$count" > "$COUNT_FILE.tmp.$$" && chmod 600 "$COUNT_FILE.tmp.$$" && mv -f "$COUNT_FILE.tmp.$$" "$COUNT_FILE" || exit 1
        if [ "$count" -ge 3 ]; then
          apply_redirect || { printf '0\n' > "$COUNT_FILE"; }
        else
          write_atomic "$STATE_FILE" resume_wait
        fi
        ;;
      esac
      ;;
  esac
}

set_mode() {
  local mode
  mode=$1
  case "$mode" in on|off) ;; *) echo '[!] Expected on or off.' >&2; return 1 ;; esac
  write_atomic "$STATE_DIR/vpn-compat" "$mode" || return 1
  if [ "$mode" = on ]; then
    # Keep the opt-in enabled on a transient detection/cleanup failure so the
    # watchdog can retry and avoid restoring redirects under an active VPN.
    start_guard || { write_atomic "$STATE_FILE" error || true; return 1; }
  else
    if [ "$(read_switch "$STATE_DIR/dns-takeover")" = on ]; then
      apply_redirect manual || { write_atomic "$STATE_DIR/vpn-compat" on; return 1; }
    else
      clear_pause manual
    fi
  fi
  echo "[+] VPN/TUN compatibility $mode."
}

set_takeover() {
  local desired previous detected
  desired=$1
  case "$desired" in on|off) ;; *) echo '[!] Expected on or off.' >&2; return 1 ;; esac
  if [ "$desired" = off ]; then
    # Persist explicit user intent first. If firewall cleanup transiently
    # fails, watch() will keep retrying cleanup and must never auto-resume.
    write_atomic "$STATE_DIR/dns-takeover" off || return 1
    "$BB" sh "$FIREWALL" disable || { write_atomic "$STATE_FILE" error || true; return 1; }
    clear_pause takeover-off
    echo '[+] DNS redirection disabled; AdGuard Home remains available.'
    return 0
  fi
  previous=$(read_switch "$STATE_DIR/dns-takeover")
  case "$previous" in on|off) ;; *) echo '[!] DNS takeover preference is unreadable.' >&2; return 1 ;; esac
  core_ready || { echo '[!] AdGuard Home and both DNS listeners must be ready.' >&2; return 1; }
  if [ "$(read_switch "$STATE_DIR/vpn-compat")" = on ]; then
    detect_tunnel; detected=$?
    case "$detected" in
      0) set_pause vpn || return 1; write_atomic "$STATE_DIR/dns-takeover" on || return 1; echo '[+] DNS takeover preference saved; redirection is paused while VPN is active.'; return 0 ;;
      2) set_pause unknown || return 1; write_atomic "$STATE_DIR/dns-takeover" on || return 1; echo '[+] DNS takeover preference saved; redirection is paused until VPN state is readable.'; return 0 ;;
    esac
  fi
  "$BB" sh "$FIREWALL" enable || { "$BB" sh "$FIREWALL" disable >/dev/null 2>&1 || true; return 1; }
  write_atomic "$STATE_DIR/dns-takeover" on || { "$BB" sh "$FIREWALL" disable >/dev/null 2>&1 || true; write_atomic "$STATE_DIR/dns-takeover" "$previous" || true; return 1; }
  clear_pause manual
  echo '[+] DNS redirection enabled after TCP and UDP listener checks.'
}

case "$1" in
  detect)
    detect_tunnel; rc=$?
    case "$rc" in 0) echo active ;; 1) echo absent ;; *) echo unknown ;; esac
    ;;
  start-guard) start_guard ;;
  watch) watch ;;
  set-mode) set_mode "$2" ;;
  set-takeover) set_takeover "$2" ;;
  *) echo "Usage: $0 {detect|start-guard|watch|set-mode on|off|set-takeover on|off}" >&2; exit 2 ;;
esac
