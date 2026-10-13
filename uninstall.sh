#!/system/bin/sh

# Keep rc.3's conservative shutdown: failure must leave the resolver available.
AGH_DIR=/data/adb/adblockpro
if ! "$AGH_DIR/scripts/tool.sh" stop; then
  echo '[AdBlock Pro] DNS shutdown failed; runtime files retained for recovery.' >&2
  exit 1
fi
# A successful helper exit is not enough if an owned jump survived cleanup.
# Only a successfully read OUTPUT snapshot can prove that no owned jump remains.
verify_no_jump() {
  local command=$1 table=$2 chain=$3 snapshot rule policy=0 present=0
  if ! snapshot=$("$command" -w 5 -t "$table" -S OUTPUT 2>&1); then
    # Optional IPv6 tables can be genuinely unsupported; generic errors (even
    # exit 1) and missing binaries do not prove the absence of legacy rules.
    if [ "$command" = ip6tables ]; then
      case "$snapshot" in
        *"-A OUTPUT "*) ;;
        *"can't initialize ip6tables table "*": Table does not exist"* | \
        *"can't initialize ip6tables table "*": Address family not supported by protocol"* | \
        *"can't initialize ip6tables table "*": Protocol not supported"*) return 0 ;;
      esac
    fi
    echo "[AdBlock Pro] Cannot verify DNS firewall state: $chain; keeping runtime." >&2
    return 1
  fi
  while IFS= read -r rule; do
    case "$rule" in
      '-P OUTPUT ACCEPT'|'-P OUTPUT DROP') [ "$policy" = 0 ] || return 1; policy=1 ;;
      '-A OUTPUT '*)
        case "$rule" in
          *" -j $chain"|*" --jump $chain"|*" -g $chain"|*" --goto $chain") present=1 ;;
        esac ;;
      '') ;;
      *) echo "[AdBlock Pro] Invalid firewall snapshot; keeping runtime." >&2; return 1 ;;
    esac
  done <<EOF
$snapshot
EOF
  if [ "$policy" != 1 ]; then
    echo '[AdBlock Pro] Incomplete firewall snapshot; keeping runtime.' >&2
    return 1
  fi
  [ "$present" = 0 ] && return 0
  echo "[AdBlock Pro] DNS redirect still active: $chain; keeping runtime." >&2
  return 1
}
command -v iptables >/dev/null 2>&1 || {
  echo '[AdBlock Pro] Cannot verify IPv4 firewall state; keeping runtime.' >&2
  exit 1
}
verify_no_jump iptables nat ADGUARD_REDIRECT_DNS || exit 1
# Explicitly unsupported IPv6 tables do not prevent safe IPv4-only uninstall.
verify_no_jump ip6tables nat ADGUARD_REDIRECT_DNS6 || exit 1
verify_no_jump ip6tables filter ADGUARD_BLOCK_DNS || exit 1
rm -rf "$AGH_DIR"
