#!/system/bin/sh
# Read a short-lived, privacy-filtered report from a Debug build over ADB.
MODDIR=${0%/*}
REPORT=/data/adb/bindhosts_personal/debug/latest-observation.tsv

[ -f "$MODDIR/debug-build" ] || { echo 'This is not an AdBlock Pro Debug build.' >&2; exit 1; }
. "$MODDIR/scripts/compat.sh" || exit 1

case "${1:-collect}" in collect|observation) ;; *) echo 'Usage: adb-debug.sh [collect|observation]' >&2; exit 2 ;; esac

version=$($BB sed -n 's/^version=//p' "$MODDIR/module.prop" | $BB head -n 1)
case "$version" in ''|*[!A-Za-z0-9._+-]*) version=unknown ;; esac
printf 'AdBlock Pro Debug report\nmodule_version=%s\n' "$version"

echo '[Runtime]'
if ! $BB sh "$MODDIR/bindhosts.sh" --diagnose 2>/dev/null | $BB grep -E '^diag_(service_state|loaded_rule_count|dns_listener|dns_listener_udp|dns_listener_tcp|dns_api|dns_takeover|dns_redirect|ipv6_mode|dns_core_running|dns_health|root_family)='; then
  echo 'diagnostics=unavailable'
fi

if [ ! -f "$REPORT" ]; then
  echo '[Observation]'
  echo 'result=not_available'
  exit 0
fi

captured=$($BB awk -F '\t' 'NR == 1 && $1 == "captured_at" { print $2; exit }' "$REPORT")
case "$captured" in ''|*[!0-9]*) echo '[Observation]'; echo 'result=invalid_report' >&2; exit 1 ;; esac
now=$(date +%s 2>/dev/null)
case "$now" in ''|*[!0-9]*) echo '[Observation]'; echo 'result=clock_unavailable'; exit 0 ;; esac
if [ "$captured" -gt "$now" ] 2>/dev/null || [ $((now - captured)) -gt 86400 ] 2>/dev/null; then
  rm -f "$REPORT"
  echo '[Observation]'
  echo 'result=expired'
  exit 0
fi

echo '[Observation]'
$BB awk -F '\t' '
  NR == 1 { printf "captured_at=%s\n", $2; next }
  NR == 2 { printf "started_at=%s\n", $2; next }
  NR == 3 { printf "domain_count=%s\n", $2; next }
  NR == 4 { printf "included_count=%s\n", $2; next }
  NR == 5 { printf "source_truncated=%s\n", $2; next }
  NR == 6 { next }
  NR > 6 { printf "domain=%s\trequests=%s\tlast_seen=%s\treason=%s\tfilter_id=%s\n", $1, $2, $3, $4, $5 }
' "$REPORT"
