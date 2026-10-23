#!/system/bin/sh
MODDIR=${0%/*}
. "$MODDIR/scripts/compat.sh" || exit 1

STATE_DIR=/data/adb/bindhosts_personal
AUTOSTART=$STATE_DIR/autostart
# If a reboot interrupted a temporary query-log observation, restore its
# original setting before honoring the autostart preference.
"$BB" sh "$MODDIR/bindhosts.sh" --recover-observation >/dev/null 2>&1 || true
[ -f "$AUTOSTART" ] || printf 'on\n' > "$AUTOSTART"
# The module's DNS listener should start after Android has finished booting.
# Network readiness is only a bounded hint: no DNS or internet requests here.
# Existing installations keep their old settings.conf, so defaults live here.
BOOT_SETTINGS=/data/adb/adblockpro/settings.conf
boot_start_delay=8
boot_network_wait=20
[ ! -r "$BOOT_SETTINGS" ] || . "$BOOT_SETTINGS"

# Clamp untrusted/malformed settings to prevent accidental endless boot waits.
case "$boot_start_delay" in ''|*[!0-9]*) boot_start_delay=8 ;; esac
case "$boot_network_wait" in ''|*[!0-9]*) boot_network_wait=20 ;; esac
[ "$boot_start_delay" -le 60 ] || boot_start_delay=60
[ "$boot_network_wait" -le 90 ] || boot_network_wait=90

# Android often stores per-network routes in non-main routing tables. Check
# all tables without resolving hostnames or requiring external internet access.
boot_route_ready() {
  ip_cmd=$(command -v ip 2>/dev/null)
  [ -n "$ip_cmd" ] || return 2
  routes=$("$ip_cmd" -4 route show table all 2>/dev/null)
  printf '%s\n' "$routes" | grep -Eq '^[[:space:]]*default[[:space:]]' && return 0
  routes=$("$ip_cmd" -6 route show table all 2>/dev/null)
  printf '%s\n' "$routes" | grep -Eq '^[[:space:]]*default[[:space:]]'
}

wait_for_boot_network() {
  local waited=0
  [ "$boot_network_wait" -gt 0 ] || return 0
  command -v ip >/dev/null 2>&1 || return 0
  while [ "$waited" -lt "$boot_network_wait" ]; do
    boot_route_ready && return 0
    sleep 2
    waited=$((waited + 2))
  done
  printf '%s [提示] 等待网络路由 %s 秒后仍未就绪，将离线启动 DNS 核心。\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$boot_network_wait" >> /data/adb/adblockpro/history.log 2>/dev/null || true
  return 0
}

# Start the module enable/disable watcher even when boot autostart is off.
# A manually resumed DNS service still needs lifecycle hooks and crash safety.
"$BB" inotifyd /data/adb/adblockpro/scripts/inotify.sh "$MODDIR:d,n" &

if [ "$(cat "$AUTOSTART" 2>/dev/null)" = on ]; then
  # Some ROMs do not expose init.svc.bootanim, so never wait forever.
  # Prefer Android's boot-completed flag, with a bounded fallback.
  boot_waited=0
  while [ "$(getprop sys.boot_completed)" != 1 ] &&
        [ "$(getprop init.svc.bootanim)" != stopped ]; do
    [ "$boot_waited" -lt 180 ] || {
      printf '%s [警告] 开机完成信号未返回，继续尝试启动 DNS 服务。\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> /data/adb/adblockpro/history.log
      break
    }
    sleep 5
    boot_waited=$((boot_waited + 5))
  done
  # A short post-boot grace period helps Android bring networking up.
  [ "$boot_start_delay" -eq 0 ] || sleep "$boot_start_delay"
  # No indefinite wait: offline boots must still have a working DNS service.
  wait_for_boot_network
  # The preference or module enabled state may have changed while waiting.
  if [ "$(cat "$AUTOSTART" 2>/dev/null)" = on ] &&
     [ ! -f "$MODDIR/disable" ]; then
    /data/adb/adblockpro/scripts/tool.sh start
  fi
fi

# Fail open if the resolver crashes after DNS redirection was installed.
# This monitor removes only this module's redirect; it does not restart AGH
# repeatedly or alter the user's takeover preference.
(
  AGH=/data/adb/adblockpro
  cleanup_warning=0
  auto_update_ticks=0
  while [ -d "$MODDIR" ]; do
    sleep 5
    [ -d "$MODDIR" ] || break
    pid=$(cat "$AGH/bin/agh.pid" 2>/dev/null)
    alive=0
    case "$pid" in ''|*[!0-9]*) ;; *)
      if [ -r "/proc/$pid/cmdline" ] && "$BB" tr '\000' ' ' < "/proc/$pid/cmdline" | "$BB" grep -Fq "$AGH/bin/AdGuardHome"; then alive=1; fi
      ;;
    esac
    # Leave a healthy enabled core alone, without polling firewall snapshots.
    if [ "$alive" = 1 ] && [ ! -f "$MODDIR/disable" ]; then
      cleanup_warning=0
      if [ "$(cat /data/adb/bindhosts_personal/vpn-compat 2>/dev/null)" = on ]; then
        "$BB" sh "$AGH/scripts/vpn-compat.sh" watch >/dev/null 2>&1 || true
      fi
      auto_update_ticks=$((auto_update_ticks + 1))
      if [ "$auto_update_ticks" -ge 12 ]; then
        auto_update_ticks=0
        # Downloads must not block crash cleanup on a slow network.
        "$BB" sh "$MODDIR/bindhosts.sh" --auto-update >/dev/null 2>&1 &
      fi
      continue
    fi
    # Saved takeover=off cannot prove that a previous redirect was removed.
    # Require the explicit snapshot result: a failed helper can also exit 1.
    redirect_state=$("$AGH/scripts/iptables.sh" status 2>/dev/null)
    if [ "$redirect_state" = absent ]; then
      cleanup_warning=0
      continue
    fi
    "$AGH/scripts/iptables.sh" disable >/dev/null 2>&1
    redirect_state=$("$AGH/scripts/iptables.sh" status 2>/dev/null)
    cleanup_reason='AdGuard Home 进程异常退出'
    [ ! -f "$MODDIR/disable" ] || cleanup_reason='模块已禁用'
    if [ "$redirect_state" = absent ]; then
      printf '%s [恢复] %s，已解除本模块 DNS 重定向。\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$cleanup_reason" >> "$AGH/history.log"
      cleanup_warning=0
    elif [ "$cleanup_warning" = 0 ]; then
      printf '%s [警告] %s，DNS 重定向仍有残留或状态未知，将继续重试。\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$cleanup_reason" >> "$AGH/history.log"
      cleanup_warning=1
    fi
  done
) >/dev/null 2>&1 &

# Register the bundled shared filter on upgrades too, after crash protection
# is running. No GitHub request or private-list migration occurs at boot.
if [ -r /data/adb/adblockpro/bin/agh.pid ]; then
  "$BB" sh "$MODDIR/bindhosts.sh" --ensure-shared >/dev/null 2>&1 ||
    printf '%s [提醒] 共享抓包规则待应用；现有 DNS 核心继续运行。\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> /data/adb/adblockpro/history.log
fi
