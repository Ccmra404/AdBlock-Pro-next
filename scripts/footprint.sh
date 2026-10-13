#!/system/bin/sh
# Read-only storage and memory footprint snapshot. Called by --diagnose.
# Never prints credentials or deletes user files.
AGH_DIR=${ABP_AGH_DIR:-/data/adb/adblockpro}
MODULE_DIR=${ABP_MODULE_DIR:-/data/adb/modules/bindhosts_personal}
STATE_DIR=${ABP_STATE_DIR:-/data/adb/bindhosts_personal}
PROC_DIR=${ABP_PROC_DIR:-/proc}

size_kb() {
  if [ ! -e "$1" ]; then printf '0\n'; return; fi
  result=$(du -sk "$1" 2>/dev/null | awk 'NR==1 { print $1 }')
  case "$result" in ''|*[!0-9]*) result=0 ;; esac
  printf '%s\n' "$result"
}
print_size() {
  printf '%s=%s\n' "$1" "$(size_kb "$2")"
}

engine="$AGH_DIR/bin/AdGuardHome"
print_size diag_disk_module_kb "$MODULE_DIR"
print_size diag_disk_runtime_kb "$AGH_DIR"
print_size diag_disk_state_kb "$STATE_DIR"
print_size diag_disk_engine_binary_kb "$engine"
print_size diag_disk_filter_cache_kb "$AGH_DIR/bin/data/filters"
print_size diag_disk_engine_data_kb "$AGH_DIR/bin/data"
print_size diag_disk_rollback_kb "$STATE_DIR/dns-history"
print_size diag_disk_task_logs_kb "$STATE_DIR/webui-jobs"
print_size diag_disk_service_log_kb "$AGH_DIR/bin.log"
print_size diag_disk_service_log_backup_kb "$AGH_DIR/bin.log.bak"

# Diagnosis passes the PID it verified; standalone storage reports capture it
# once here. The helper rejects PID/starttime changes during the sample.
if [ "$#" -gt 0 ]; then pid=$1
else pid=$(cat "$AGH_DIR/bin/agh.pid" 2>/dev/null)
fi
sh "${0%/*}/memory.sh" sample "$pid" | sed 's/^/diag_/'
