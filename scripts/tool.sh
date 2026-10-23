#!/system/bin/sh
. /data/adb/adblockpro/settings.conf
. /data/adb/adblockpro/scripts/base.sh

# An upgrade keeps the user's existing settings.conf, so a key added to that
# file after the user installed is simply missing here and arrives empty.
startup_timeout="${startup_timeout:-120}"
RUNTIME_STATE=/data/adb/bindhosts_personal
RUNTIME_REQUEST=$RUNTIME_STATE/runtime-request

# Autostart is a boot preference, not the user's current run/pause intent.
# Publish requests before waiting for the lifecycle lock so a queued pause
# can cancel a slow start. A newer request always supersedes an older one.
record_runtime_request() {
  umask 077
  mkdir -p "$RUNTIME_STATE" || return 1
  runtime_request="$1:$(date +%s):$$"
  printf '%s\n' "$runtime_request" > "$RUNTIME_REQUEST.$$.tmp" &&
    mv -f "$RUNTIME_REQUEST.$$.tmp" "$RUNTIME_REQUEST"
}

start_requested() {
  [ -n "${runtime_request:-}" ] && [ "$(cat "$RUNTIME_REQUEST" 2>/dev/null)" = "$runtime_request" ] &&
    [ -d "$MOD_PATH" ] && [ ! -f "$MOD_PATH/disable" ] && [ ! -f "$MOD_PATH/remove" ]
}

move_to_system_cgroup() {
  echo $$ > /sys/fs/cgroup/cgroup.procs 2>/dev/null
  [ -f /dev/memcg/system/cgroup.procs ] && echo $$ > /dev/memcg/system/cgroup.procs 2>/dev/null
  [ -f /dev/cpuctl/system/cgroup.procs ] && echo $$ > /dev/cpuctl/system/cgroup.procs 2>/dev/null
  [ -f /dev/cpuset/system-background/cgroup.procs ] && echo $$ > /dev/cpuset/system-background/cgroup.procs 2>/dev/null
  [ -f /dev/blkio/cgroup.procs ] && echo $$ > /dev/blkio/cgroup.procs 2>/dev/null
}

move_to_system_cgroup

# Whether AdGuardHome accepts both UDP and TCP DNS queries on $redir_port.
# Parse /proc/net directly so startup checks need neither netstat nor ss.
is_protocol_listening() {
  local files=$1 expected_state=$2 port_hex f
  port_hex=$(printf '%04X' "$redir_port")
  for f in $files; do
    [ -r "$f" ] || continue
    # A TCP TIME_WAIT socket is not a listener. Only accept TCP LISTEN
    # (0A) or UDP UNCONN (07) sockets on the configured local port.
    "$BB" awk -v pat=":$port_hex\$" -v expected="$expected_state" \
      'NR > 1 && $2 ~ pat && $4 == expected { found = 1 } END { exit !found }' "$f" && return 0
  done
  return 1
}

is_dns_listening() {
  is_protocol_listening '/proc/net/udp /proc/net/udp6' 07 &&
    is_protocol_listening '/proc/net/tcp /proc/net/tcp6' 0A
}

# A live PID only proves the process spawned. The DNS listener comes up much
# later, after filter lists are loaded and upstreams are probed -- tens of
# seconds on a slow device or a slow network. Redirecting port 53 during that
# window blackholes every DNS query on the device, so Android's connectivity
# check fails and the network gets flagged as "no internet"; apps that honour
# that flag (browsers, Play Store) then refuse to use it until the network is
# re-validated by hand, e.g. by toggling airplane mode.
wait_for_dns_ready() {
  local waited=0
  while [ "$waited" -lt "$startup_timeout" ]; do
    start_requested || return 1
    is_dns_listening && return 0
    # stop waiting if the process died instead of sitting out the full timeout
    kill -0 "$adg_pid" 2>/dev/null || return 1
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

is_our_adguardhome() {
  candidate=$1
  case "$candidate" in ''|*[!0-9]*) return 1 ;; esac
  [ -r "/proc/$candidate/cmdline" ] || return 1
  "$BB" tr '\000' ' ' < "/proc/$candidate/cmdline" | "$BB" grep -Fq "$BIN_DIR/AdGuardHome"
}

# setuidgid may briefly keep its own cmdline before exec replaces it with AGH.
wait_for_adguardhome() {
  local candidate=$1 waited=0 timeout=10
  while [ "$waited" -lt "$timeout" ]; do
    is_our_adguardhome "$candidate" && return 0
    kill -0 "$candidate" 2>/dev/null || return 1
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

start_adguardhome() {
  start_requested || return 75
  # A live PID is not sufficient: the firewall may have been removed by
  # the crash watchdog or a previous listener timeout.
  if [ -r "$PID_FILE" ] && is_our_adguardhome "$(cat "$PID_FILE")"; then
    adg_pid=$(cat "$PID_FILE")
    log "AdGuardHome is already running; checking DNS takeover" "AdGuardHome 已运行；检查 DNS 接管"
  else
    export SSL_CERT_DIR="/system/etc/security/cacerts/"
    export TZ="$timezone"
    [ ! -f "$AGH_DIR/bin.log" ] || mv "$AGH_DIR/bin.log" "$AGH_DIR/bin.log.bak"
    "$BB" sh "$SCRIPT_DIR/detach.sh" "$BB" "$BB" setuidgid "$adg_user:$adg_group" "$BIN_DIR/AdGuardHome" >"$AGH_DIR/bin.log" 2>&1 &
    adg_pid=$!
    if ! wait_for_adguardhome "$adg_pid"; then
      log "AdGuardHome failed to start" "AdGuardHome 启动失败"
      "$SCRIPT_DIR/iptables.sh" disable >/dev/null 2>&1
      update_description "🔴 DNS startup failed" "🔴 DNS 启动失败"
      "$SCRIPT_DIR/debug.sh"
      return 1
    fi
    printf '%s\n' "$adg_pid" > "$PID_FILE" || return 1
  fi

  start_requested || return 75
  takeover=$(cat /data/adb/bindhosts_personal/dns-takeover 2>/dev/null)
  if [ "$enable_iptables" != true ] || [ "$takeover" = off ]; then
    # A preference change must also remove leftovers from older boots.
    "$SCRIPT_DIR/iptables.sh" disable || {
      log "Could not remove stale DNS redirection" "无法移除旧 DNS 重定向"
      return 1
    }
    update_description "🟡 DNS running (takeover OFF)" "🟡 DNS 运行中（接管关闭）"
    return 0
  fi

  # Never redirect device DNS before the resolver is listening on both
  # UDP and TCP. If it is still unavailable, fail open instead.
  if ! wait_for_dns_ready; then
    "$SCRIPT_DIR/iptables.sh" disable >/dev/null 2>&1
    log "DNS listener unavailable; takeover skipped" "DNS 监听尚未就绪，已跳过接管"
    update_description "🟡 DNS running (listener not ready)" "🟡 DNS 运行中（监听未就绪）"
    return 1
  fi
  start_requested || return 75
  if "$SCRIPT_DIR/iptables.sh" enable; then
    if ! start_requested; then
      "$SCRIPT_DIR/iptables.sh" disable >/dev/null 2>&1
      return 75
    fi
    log "AdGuardHome ready [PID: $adg_pid], DNS redirected" "AdGuardHome 已就绪 [PID: $adg_pid]，DNS 已接管"
    update_description "🟢 DNS filtering [PID: $adg_pid]" "🟢 DNS 防护运行中 [PID: $adg_pid]"
  else
    "$SCRIPT_DIR/iptables.sh" disable >/dev/null 2>&1
    log "Could not activate DNS redirection" "无法启用 DNS 重定向"
    update_description "🔴 DNS redirection error" "🔴 DNS 重定向错误"
    return 1
  fi
}

stop_adguardhome() {
  # Safety first: keep DNS alive if its redirect cannot be removed.
  if ! "$SCRIPT_DIR/iptables.sh" disable; then
    log "Cannot remove DNS redirect; leaving resolver running" "无法移除 DNS 重定向，保留解析服务运行以防断网"
    return 1
  fi
  if [ -r "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE")
    if is_our_adguardhome "$pid"; then
      # SIGTERM is asynchronous. An immediate restart can race the previous
      # process for the DNS listening port, so wait for confirmed exit first.
      kill "$pid" 2>/dev/null || {
        is_our_adguardhome "$pid" && { log "Could not stop resolver" "无法终止 DNS 核心"; return 1; }
      }
      waited=0
      while is_our_adguardhome "$pid" && [ "$waited" -lt 6 ]; do
        sleep 1
        waited=$((waited + 1))
      done
      if is_our_adguardhome "$pid"; then
        kill -9 "$pid" 2>/dev/null || {
          is_our_adguardhome "$pid" && { log "Resolver did not exit" "DNS 核心未退出"; return 1; }
        }
        sleep 1
      fi
      if is_our_adguardhome "$pid"; then
        log "Resolver is still running; keeping PID for recovery" "DNS 核心仍在运行，保留 PID 以便恢复"
        return 1
      fi
      log "AdGuardHome stopped [PID: $pid]" "AdGuardHome 已停止 [PID: $pid]"
    else
      log "Stale PID file; unrelated process untouched" "PID 文件失效，未终止其他进程"
    fi
    rm -f "$PID_FILE"
  fi
  update_description "🔴 Stopped" "🔴 已停止"
}

toggle_adguardhome() {
  if [ -r "$PID_FILE" ] && is_our_adguardhome "$(cat "$PID_FILE")"; then
    printf 'stop\n'
  else
    printf 'start\n'
  fi
}

case "$1" in
start|stop|toggle)
  runtime_action=$1
  [ "$runtime_action" != toggle ] || runtime_action=$(toggle_adguardhome)
  request_mode=stop
  [ "$runtime_action" != start ] || request_mode=run
  record_runtime_request "$request_mode" || exit 1
  exec "$BB" flock "$RUNTIME_STATE/runtime.lock" "$BB" sh "$0" __locked "$runtime_action" "$runtime_request"
  ;;
recover)
  runtime_request=$(cat "$RUNTIME_REQUEST" 2>/dev/null)
  case "$runtime_request" in run:*) ;; *) exit 75 ;; esac
  mkdir -p "$RUNTIME_STATE/webui-jobs" || exit 1
  # Busy maintenance is not a failed recovery attempt. Acquired-lock failures
  # return 2 below, distinct from flock's busy exit 1 and stale request 75.
  exec "$BB" flock -n "$RUNTIME_STATE/webui-jobs/worker.lock" "$BB" flock -n "$RUNTIME_STATE/update.lock" \
    "$BB" flock -n "$RUNTIME_STATE/runtime.lock" "$BB" sh "$0" __locked recover "$runtime_request"
  ;;
protect)
  # Cleanup must not race a manual start that just installed its redirects.
  exec "$BB" flock -n "$RUNTIME_STATE/runtime.lock" "$BB" sh "$0" __locked protect
  ;;
__locked)
  runtime_action=$2
  runtime_request=$3
  if [ "$runtime_action" != protect ]; then
    [ -n "$runtime_request" ] && [ "$(cat "$RUNTIME_REQUEST" 2>/dev/null)" = "$runtime_request" ] || exit 75
  fi
  case "$runtime_action" in
    start) start_adguardhome ;;
    stop) stop_adguardhome ;;
    protect)
      if [ ! -f "$MOD_PATH/disable" ] && [ ! -f "$MOD_PATH/remove" ] &&
        [ -r "$PID_FILE" ] && is_our_adguardhome "$(cat "$PID_FILE")"; then exit 75; fi
      "$SCRIPT_DIR/iptables.sh" disable >/dev/null 2>&1
      redirect_state=$("$SCRIPT_DIR/iptables.sh" status 2>/dev/null)
      case "$redirect_state" in present|absent|unknown) ;; *) redirect_state=unknown ;; esac
      printf '%s\n' "$redirect_state"
      ;;
    recover)
      start_requested || exit 75
      if [ -r "$PID_FILE" ] && is_our_adguardhome "$(cat "$PID_FILE")"; then exit 75; fi
      # Unknown is never permission to reattach DNS. Cleanup is the watchdog's
      # first job; recovery only starts after positively verified absence.
      [ "$("$SCRIPT_DIR/iptables.sh" status 2>/dev/null)" = absent ] || exit 75
      log "Attempting automatic DNS core recovery" "[恢复] 尝试自动恢复 DNS 核心"
      start_adguardhome && exit 0
      exit 2
      ;;
    *) exit 1 ;;
  esac
  ;;
*)
  echo "Usage: $0 {start|stop|toggle|recover}"
  exit 1
  ;;
esac
