#!/system/bin/sh

# The active module is loaded before this hook runs.  Until then the old
# module can keep using the original state directory during an upgrade.
AGH_DIR=/data/adb/adblockpro
BOOTSTRAP="$AGH_DIR/bin/adblock-bootstrap"

[ -x "$BOOTSTRAP" ] || exit 0
if ! result=$("$BOOTSTRAP" migrate-state 2>&1); then
  printf '%s [AdBlock Pro] State directory migration notice: %s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$result" >> "$AGH_DIR/history.log" 2>/dev/null || true
fi
exit 0
