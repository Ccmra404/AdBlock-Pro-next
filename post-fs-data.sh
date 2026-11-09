#!/system/bin/sh

# The active module is loaded before this hook runs.  Until then the old
# module can keep using the original state directory during an upgrade.
AGH_DIR=/data/adb/adblockpro
BOOTSTRAP="$AGH_DIR/bin/adblock-bootstrap"

[ -x "$BOOTSTRAP" ] || exit 0
if ! result=$("$BOOTSTRAP" migrate-state 2>&1); then
  history_message=$(printf '%s [AdBlock Pro] State directory migration notice: %s' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$result")
  if [ -r "$AGH_DIR/scripts/compat.sh" ] && . "$AGH_DIR/scripts/compat.sh" 2>/dev/null; then
    abp_append_history "$AGH_DIR/history.log" line "$history_message" || true
  else
    printf '%s\n' "$history_message" >&2
  fi
fi
exit 0
