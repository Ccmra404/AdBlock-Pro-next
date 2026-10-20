#!/system/bin/sh
. /data/adb/adblockpro/settings.conf
. /data/adb/adblockpro/scripts/base.sh

iptables_w="iptables -w 64"
ip6tables_w="ip6tables -w 64"

check_ipv6_table_support() {
  # 0: readable, 1: explicitly unsupported, 2: unknown (including missing tools).
  # A generic query failure must never hide legacy IPv6 redirects.
  local table=$1 snapshot
  command -v ip6tables >/dev/null 2>&1 || return 2
  snapshot=$($ip6tables_w -t "$table" -S OUTPUT 2>&1) && return 0
  case "$snapshot" in
    *"-A OUTPUT "*) return 2 ;;
    *"can't initialize ip6tables table "*": Table does not exist"* | \
    *"can't initialize ip6tables table "*": Address family not supported by protocol"* | \
    *"can't initialize ip6tables table "*": Protocol not supported"*) return 1 ;;
    *) return 2 ;;
  esac
}

check_ipv6_nat_support() {
  check_ipv6_table_support nat
}

check_ipv6_filter_support() {
  check_ipv6_table_support filter
}

count_chain_jumps() {
  local command=$1 table=$2 chain=$3 snapshot rule policy=0 count=0
  snapshot=$($command -t "$table" -S OUTPUT 2>/dev/null) || return 1
  # Require a complete, recognisable built-in OUTPUT listing, not empty output
  # from a broken wrapper. -C exit codes cannot prove absence on every backend.
  while IFS= read -r rule; do
    case "$rule" in
      '-P OUTPUT ACCEPT'|'-P OUTPUT DROP')
        [ "$policy" = 0 ] || return 1
        policy=1 ;;
      '-A OUTPUT '*)
        # User-chain targets have no target options and are last in -S output.
        # Matching the suffix avoids mistaking quoted comments for jumps.
        case "$rule" in
          *" -j $chain"|*" --jump $chain"|*" -g $chain"|*" --goto $chain") count=$((count + 1)) ;;
        esac ;;
      '') ;;
      *) return 1 ;;
    esac
  done <<EOF
$snapshot
EOF
  [ "$policy" = 1 ] || return 1
  printf '%s\n' "$count"
}

ipv4_redirect_status() {
  local count
  count=$(count_chain_jumps "$iptables_w" nat ADGUARD_REDIRECT_DNS) || return 2
  [ "$count" -eq 0 ] || return 0
  return 1
}

# Read-only: 0 = an owned jump exists, 1 = confirmed absent, 2 = unknown.
# A visible jump takes precedence over an unreadable table so cleanup is tried.
redirect_status() {
  local count table chain present=0 unknown=0
  ipv4_redirect_status
  case "$?" in 0) present=1 ;; 1) ;; *) unknown=1 ;; esac
  for table in nat filter; do
    if [ "$table" = nat ]; then chain=ADGUARD_REDIRECT_DNS6
    else chain=ADGUARD_BLOCK_DNS; fi
    check_ipv6_table_support "$table"
    case "$?" in
      0)
        count=$(count_chain_jumps "$ip6tables_w" "$table" "$chain") && {
          [ "$count" -eq 0 ] || present=1
        } || unknown=1 ;;
      1) ;; # Explicitly unsupported, not a generic query error.
      *) unknown=1 ;;
    esac
  done
  [ "$present" = 0 ] || return 0
  [ "$unknown" = 0 ] || return 2
  return 1
}

# Remove every jump before rewriting a chain. This also repairs older installs
# that accidentally accumulated duplicate OUTPUT jumps.
remove_chain_jumps() {
  local command=$1 table=$2 chain=$3 count previous=
  while :; do
    count=$(count_chain_jumps "$command" "$table" "$chain") || return 1
    [ "$count" -ne 0 ] || return 0
    # Do not loop forever or claim cleanup if a wrapper reports a no-op delete.
    [ -z "$previous" ] || [ "$count" -lt "$previous" ] || return 1
    previous=$count
    # Delete only our exact unconditional jump. Conditional/goto leftovers
    # require manual recovery; never delete an unrelated OUTPUT rule by index.
    $command -t "$table" -D OUTPUT -j "$chain" >/dev/null 2>&1 || return 1
  done
}

disable_iptables_chain() {
  local command=$1 chain=$2 table=${3:-nat}
  remove_chain_jumps "$command" "$table" "$chain" || return 1
  if $command -t "$table" -L "$chain" >/dev/null 2>&1; then
    $command -t "$table" -F "$chain" >/dev/null 2>&1 || return 1
    $command -t "$table" -X "$chain" >/dev/null 2>&1 || return 1
  fi
  return 0
}

enable_iptables_chain() {
  local command=$1 chain=$2 subnet
  # Always rebuild the chain. An existing chain may contain only a partial
  # rule set left by a failed installation or an interrupted command.
  remove_chain_jumps "$command" nat "$chain" || return 1
  if $command -t nat -L "$chain" >/dev/null 2>&1; then
    $command -t nat -F "$chain" >/dev/null 2>&1 || return 1
  else
    $command -t nat -N "$chain" >/dev/null 2>&1 || return 1
  fi

  if ! $command -t nat -A "$chain" -m owner --uid-owner "$adg_user" --gid-owner "$adg_group" -j RETURN; then
    disable_iptables_chain "$command" "$chain"; return 1
  fi

  for subnet in $ignore_dest_list; do
    if ! $command -t nat -A "$chain" -d "$subnet" -j RETURN >/dev/null 2>&1; then
      log "Cannot bypass destination $subnet" "无法绕过目标网段 $subnet"
      disable_iptables_chain "$command" "$chain"; return 1
    fi
  done
  for subnet in $ignore_src_list; do
    if ! $command -t nat -A "$chain" -s "$subnet" -j RETURN >/dev/null 2>&1; then
      log "Cannot bypass source $subnet" "无法绕过来源网段 $subnet"
      disable_iptables_chain "$command" "$chain"; return 1
    fi
  done

  if ! $command -t nat -A "$chain" -p udp --dport 53 -j REDIRECT --to-ports "$redir_port" ||
     ! $command -t nat -A "$chain" -p tcp --dport 53 -j REDIRECT --to-ports "$redir_port" ||
     ! $command -t nat -I OUTPUT -j "$chain"; then
    disable_iptables_chain "$command" "$chain"
    return 1
  fi
  log "Applied $chain DNS redirection" "已启用 $chain DNS 重定向"
  return 0
}

add_block_ipv6_dns() {
  local chain=ADGUARD_BLOCK_DNS
  # Legacy mode is opt-in. Avoid silently blocking IPv6 when incomplete.
  remove_chain_jumps "$ip6tables_w" filter "$chain" || return 1
  if $ip6tables_w -t filter -L "$chain" >/dev/null 2>&1; then
    $ip6tables_w -t filter -F "$chain" >/dev/null 2>&1 || return 1
  else
    $ip6tables_w -t filter -N "$chain" >/dev/null 2>&1 || return 1
  fi
  # Reject immediately rather than silently waiting for a DROP timeout.
  if ! $ip6tables_w -t filter -A "$chain" -p udp --dport 53 -j REJECT --reject-with icmp6-port-unreachable ||
     ! $ip6tables_w -t filter -A "$chain" -p tcp --dport 53 -j REJECT --reject-with tcp-reset ||
     ! $ip6tables_w -t filter -I OUTPUT -j "$chain"; then
    disable_iptables_chain "$ip6tables_w" "$chain" filter
    return 1
  fi
}

del_block_ipv6_dns() {
  check_ipv6_filter_support
  case "$?" in 0) ;; 1) return 0 ;; *) return 1 ;; esac
  disable_iptables_chain "$ip6tables_w" ADGUARD_BLOCK_DNS filter
}

enable_ipv6_iptables() {
  check_ipv6_nat_support
  case "$?" in
  1)
    log "IPv6 NAT is not supported, skipping IPv6 DNS hijack" "IPv6 NAT 不支持，跳过 IPv6 DNS 劫持"
    return 0 ;;
  0) ;;
  *) return 1 ;;
  esac

  enable_iptables_chain "$ip6tables_w" "ADGUARD_REDIRECT_DNS6"
}

disable_ipv6_iptables() {
  # Only an explicitly unsupported table can be skipped, not a query error.
  check_ipv6_nat_support
  case "$?" in 0) ;; 1) return 0 ;; *) return 1 ;; esac
  disable_iptables_chain "$ip6tables_w" "ADGUARD_REDIRECT_DNS6"
}

# If an opt-in IPv6 mode cannot be installed, tear down partial redirection
# too. Callers should never be left with only half of the requested firewall.
rollback_failed_enable() {
  del_block_ipv6_dns >/dev/null 2>&1
  disable_ipv6_iptables >/dev/null 2>&1
  disable_iptables_chain "$iptables_w" ADGUARD_REDIRECT_DNS >/dev/null 2>&1
  return 1
}

case "$1" in
status|status-ipv4)
  if [ "$1" = status-ipv4 ]; then
    # UI reads must not wait through a long-running firewall writer.
    iptables_w="iptables -w 1"
    ipv4_redirect_status
  else redirect_status; fi
  case "$?" in
    0) echo present; exit 0 ;;
    1) echo absent; exit 1 ;;
    *) echo unknown; exit 2 ;;
  esac
  ;;
enable)
  log "Enabling IPv4 DNS redirection" "启用 IPv4 DNS 重定向"
  enable_iptables_chain "$iptables_w" "ADGUARD_REDIRECT_DNS" || { rollback_failed_enable; exit 1; }

  if [ "$enable_ipv6_dns" = true ]; then
    if [ "$block_ipv6_dns" = true ]; then
      log "IPv6 DNS mode: block (REJECT IPv6 DNS traffic)" "IPv6 DNS 模式: block (拒绝 IPv6 DNS 流量)"
      disable_ipv6_iptables || { rollback_failed_enable; exit 1; }
      add_block_ipv6_dns || { rollback_failed_enable; exit 1; }
    else
      log "IPv6 DNS mode: redirect to AdGuard Home" "IPv6 DNS 模式: 重定向到 AdGuard Home"
      del_block_ipv6_dns || { rollback_failed_enable; exit 1; }
      enable_ipv6_iptables || { rollback_failed_enable; exit 1; }
    fi
  else
    # Remove chains from older settings so disabled IPv6 redirection really passes through.
    del_block_ipv6_dns || { rollback_failed_enable; exit 1; }
    disable_ipv6_iptables || { rollback_failed_enable; exit 1; }
    log "IPv6 DNS left unchanged" "IPv6 DNS 保持系统原样"
  fi
  ;;
disable)
  log "Disabling iptables and ipv6 DNS blocking" "禁用 iptables 和 ipv6 DNS 阻断"
  disable_iptables_chain "$iptables_w" "ADGUARD_REDIRECT_DNS" || exit 1

  del_block_ipv6_dns || exit 1
  disable_ipv6_iptables || exit 1
  ;;
*)
  echo "Usage: $0 {enable|disable|status|status-ipv4}"
  exit 1
  ;;
esac
