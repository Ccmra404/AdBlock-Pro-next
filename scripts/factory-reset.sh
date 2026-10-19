#!/system/bin/sh
umask 077

AGH=${ABP_AGH_DIR:-/data/adb/adblockpro}
STATE=${ABP_STATE_DIR:-/data/adb/bindhosts_personal}
MODULE=${ABP_MODULE_DIR:-/data/adb/modules/bindhosts_personal}
JOBS=${ABP_JOBS_DIR:-$STATE/webui-jobs}
TOOL=${ABP_TOOL:-$AGH/scripts/tool.sh}
BOOTSTRAP=${ABP_BOOTSTRAP:-$AGH/bin/adblock-bootstrap}
CONFIG=${ABP_CONFIG_SCRIPT:-$MODULE/webui-config.sh}
RENDER=${ABP_RENDER_SCRIPT:-$MODULE/bindhosts.sh}
RULE_STORE=${ABP_RULE_STORE:-$AGH/scripts/rule-store.sh}
COMPAT=${ABP_COMPAT:-$AGH/scripts/compat.sh}
TARBIN=${ABP_TAR:-tar}

. "$COMPAT" || exit 1

restore_state() {
  local item name
  if [ "$state_moved" = 1 ]; then
    for item in "$STATE"/* "$STATE"/.[!.]* "$STATE"/..?*; do
      [ -e "$item" ] || [ -L "$item" ] || continue
      name=${item##*/}
      case "$name" in
      webui-jobs|update.lock|root-family|backups) continue ;;
        ai)
          for ai_item in "$STATE/ai"/* "$STATE/ai"/.[!.]* "$STATE/ai"/..?*; do
            [ -e "$ai_item" ] || [ -L "$ai_item" ] || continue
            [ "${ai_item##*/}" = worker.lock ] || rm -rf "$ai_item" || return 1
          done
          continue
          ;;
      esac
      rm -rf "$item" || return 1
    done
  fi
  for item in "$stage/old-state"/* "$stage/old-state"/.[!.]* "$stage/old-state"/..?*; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    name=${item##*/}
    if [ "$name" = ai ]; then
      mkdir -p "$STATE/ai" || return 1
      for ai_item in "$item"/* "$item"/.[!.]* "$item"/..?*; do
        [ -e "$ai_item" ] || [ -L "$ai_item" ] || continue
        mv "$ai_item" "$STATE/ai/" || return 1
      done
      rmdir "$item" 2>/dev/null
      continue
    fi
    mv "$item" "$STATE/$name" || return 1
  done
}

restore_runtime() {
  local item name
  for item in settings.conf admin.auth bin/AdGuardHome.yaml bin/data bin/userfilters; do
    if [ -e "$stage/old-runtime/$item" ]; then
      rm -rf "$AGH/$item" || return 1
      mkdir -p "${AGH}/$(dirname "$item")" || return 1
      mv "$stage/old-runtime/$item" "$AGH/$item" || return 1
    elif [ "$runtime_moved" = 1 ]; then
      rm -rf "$AGH/$item" || return 1
    fi
  done
}

rollback() {
    echo '[恢复] 默认设置未能完整应用，正在恢复原有设置。' >&2
  "$BB" sh "$TOOL" stop >/dev/null 2>&1 || {
    echo '[!] DNS 接管无法安全清理；保留原配置备份和恢复暂存目录。' >&2
    return 1
  }
  restore_state || { echo '[!] 用户状态恢复失败；暂存目录仍保留。' >&2; return 1; }
  restore_runtime || { echo '[!] AdGuard Home 配置恢复失败；暂存目录仍保留。' >&2; return 1; }
  "$BB" sh "$TOOL" start || {
    echo '[!] 原配置已恢复，但 DNS 核心未能重新启动；请查看 AdGuard Home 日志。' >&2
    return 1
  }
  rm -rf "$stage"
  echo '[恢复] 原设置已恢复。' >&2
  return 0
}

fail_after_stop() {
  message=$1
  echo "[!] $message" >&2
  if [ "$stopped" = 1 ]; then rollback || echo "[!] 可恢复备份：$backup" >&2; else rm -rf "$stage"; fi
  exit 1
}

reset_defaults() {
  local item name
  request_id=$1
  case "$request_id" in ''|*[!0-9]*) echo '[!] Invalid reset task id.' >&2; return 1 ;; esac
  [ ${#request_id} -le 20 ] || { echo '[!] Invalid reset task id.' >&2; return 1; }
  [ -d "$AGH" ] && [ -d "$STATE" ] && [ -d "$MODULE" ] || { echo '[!] Module data paths are incomplete; nothing was changed.' >&2; return 1; }
  for ai_result in "$STATE"/ai/jobs/*/result.json; do
    [ -f "$ai_result" ] || continue
    if "$BB" grep -Eq '"status"[[:space:]]*:[[:space:]]*"(queued|running)"' "$ai_result"; then
      echo '[!] AI analysis is still running; wait for it to finish before resetting.' >&2
      return 1
    fi
  done
  [ -d "$AGH/defaults/filters" ] && [ -s "$AGH/defaults/settings.conf" ] &&
    [ -s "$AGH/defaults/config-blacklist.txt" ] && [ -s "$AGH/defaults/config-whitelist.txt" ] &&
    [ -s "$AGH/defaults/filters/10007.txt" ] && [ -s "$AGH/defaults/filters/1791638912.txt" ] || {
      echo '[!] Fresh-install defaults are unavailable. Reinstall the current module package before resetting.' >&2
      return 1
    }
  for item in settings.conf admin.auth bin/AdGuardHome.yaml bin/data bin/userfilters; do
    [ -e "$AGH/$item" ] || { echo "[!] Required AdGuard Home data is missing: $item; nothing was changed." >&2; return 1; }
  done
  [ -x "$BOOTSTRAP" ] || { echo '[!] The setup helper is missing; reinstall the current module package before resetting.' >&2; return 1; }
  [ -x "$TOOL" ] && [ -f "$CONFIG" ] && [ -f "$RENDER" ] && [ -f "$RULE_STORE" ] || {
    echo '[!] A required reset helper is missing; nothing was changed.' >&2; return 1;
  }

  backup_dir=${ABP_EXPORT_DIR:-/sdcard/Download/AdBlock Pro}
  mkdir -p "$backup_dir" || { echo '[!] Cannot create the AdBlock Pro download directory.' >&2; return 1; }
  chmod 755 "$backup_dir" || { echo '[!] Cannot make the AdBlock Pro download directory accessible.' >&2; return 1; }
  stamp=$(date '+%Y%m%d-%H%M%S')
  private_dir="$AGH/backups"
  [ ! -L "$private_dir" ] && mkdir -p "$private_dir" && chmod 700 "$private_dir" || {
    echo '[!] Cannot protect the private recovery directory; nothing was changed.' >&2; return 1;
  }
  backup="$private_dir/AdBlock-Pro-default-settings-$stamp.tar.gz"
  [ ! -e "$backup" ] || backup="$private_dir/AdBlock-Pro-default-settings-$stamp-$$.tar.gz"
  export_backup="$backup_dir/AdBlock-Pro-rules-settings-$stamp-$$.tar.gz"
  [ ! -e "$export_backup" ] && [ ! -e "$export_backup.tmp" ] || return 1
  backup_tmp="$backup.tmp"
  stage="$AGH/.factory-reset-stage.$$"
  old_state="$stage/old-state"
  old_runtime="$stage/old-runtime"
  new_state="$stage/new-state"
  new_runtime="$stage/new-runtime"
  backup_state="$stage/backup-snapshot/module-state"
  backup_runtime="$stage/backup-snapshot/adguard-home"
  stopped=0
  state_moved=0
  runtime_moved=0
  mkdir -p "$old_state" "$old_runtime/bin" "$new_state" "$new_runtime/bin/data/filters" "$new_runtime/bin/userfilters" "$backup_state" "$backup_runtime/bin" || {
    rm -rf "$stage"; echo '[!] Cannot prepare a safe reset workspace.' >&2; return 1;
  }

  cp "$AGH/defaults/settings.conf" "$new_runtime/settings.conf" &&
    cp "$AGH/defaults/config-blacklist.txt" "$new_state/blacklist.txt" &&
    cp "$AGH/defaults/config-whitelist.txt" "$new_state/whitelist.txt" &&
    cp "$AGH/defaults/filters/10007.txt" "$new_runtime/bin/data/filters/10007.txt" &&
    cp "$AGH/defaults/filters/1791638912.txt" "$new_runtime/bin/data/filters/1791638912.txt" || {
      rm -rf "$stage"; echo '[!] Cannot prepare the fresh-install defaults.' >&2; return 1;
    }
  "$BOOTSTRAP" "$new_runtime/bin/AdGuardHome.yaml" "$new_runtime/admin.auth" || {
    rm -rf "$stage"; echo '[!] Cannot generate fresh AdGuard Home credentials and configuration.' >&2; return 1;
  }
  chmod 600 "$new_runtime/settings.conf" "$new_runtime/admin.auth" "$new_runtime/bin/AdGuardHome.yaml" \
    "$new_state/blacklist.txt" "$new_state/whitelist.txt" "$new_runtime/bin/data/filters"/* || {
      rm -rf "$stage"; echo '[!] Cannot protect the prepared reset files.' >&2; return 1;
    }
  printf 'balanced\n' > "$new_state/blocking-mode"
  printf 'on\n' > "$new_state/auto-update"
  printf 'on\n' > "$new_state/autostart"
  printf 'on\n' > "$new_state/dns-takeover"
  : > "$new_state/sources.txt"
  : > "$new_state/custom-sources.txt"
  : > "$new_state/disabled-sources.txt"
  "$BB" awk '
    /^filters:[[:space:]]*$/ { in_filters=1; next }
    in_filters && /^[^[:space:]]/ { in_filters=0 }
    in_filters && /^    url:[[:space:]]*https:\/\// {
      sub(/^    url:[[:space:]]*/, "")
      gsub(/^\"|\"$/, "")
      print
    }
  ' "$new_runtime/bin/AdGuardHome.yaml" > "$new_state/sources-applied.txt" || {
    rm -rf "$stage"; echo '[!] Cannot read default rule sources from the fresh configuration.' >&2; return 1;
  }
  : > "$new_state/last-update"
  : > "$new_state/v3-installed"
  chmod 600 "$new_state"/* || { rm -rf "$stage"; echo '[!] Cannot protect fresh-install preferences.' >&2; return 1; }

  echo '[进度] 创建 Root 私有完整备份和下载目录规则备份…'
  for item in "$STATE"/* "$STATE"/.[!.]* "$STATE"/..?*; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    name=${item##*/}
    case "$name" in backups|.factory-reset-stage.*) continue ;; esac
    cp -R "$item" "$backup_state/" || {
      rm -rf "$stage"; echo '[!] Cannot stage private module data for backup; original settings were not changed.' >&2; return 1;
    }
  done
  for item in settings.conf admin.auth bin/AdGuardHome.yaml bin/data bin/userfilters; do
    mkdir -p "$backup_runtime/$(dirname "$item")" || {
      rm -rf "$stage"; echo '[!] Cannot prepare AdGuard Home backup files; original settings were not changed.' >&2; return 1;
    }
    cp -R "$AGH/$item" "$backup_runtime/$item" || {
      rm -rf "$stage"; echo '[!] Cannot copy AdGuard Home backup files; original settings were not changed.' >&2; return 1;
    }
  done
  if ! "$TARBIN" -czf "$backup_tmp" -C "$stage/backup-snapshot" module-state adguard-home ||
     [ ! -s "$backup_tmp" ] || ! "$TARBIN" -tzf "$backup_tmp" > "$stage/backup-list" 2>/dev/null ||
     ! "$BB" grep -Fxq 'adguard-home/admin.auth' "$stage/backup-list" ||
     ! "$BB" grep -Fxq 'adguard-home/bin/AdGuardHome.yaml' "$stage/backup-list"; then
    rm -f "$backup_tmp"; rm -rf "$stage"
    echo '[!] 备份创建或校验失败；原配置未更改。' >&2
    return 1
  fi
  chmod 600 "$backup_tmp" && mv "$backup_tmp" "$backup" || {
    rm -f "$backup_tmp"; rm -rf "$stage"; echo '[!] Cannot safely save the reset backup; original settings were not changed.' >&2; return 1;
  }

  # Shared storage cannot enforce Root-only permissions. Export only known
  # rule lists/preferences; credentials, subscription URLs and logs stay private.
  export_stage="$stage/rules-export"
  mkdir -p "$export_stage" || { rm -rf "$stage"; return 1; }
  for name in blacklist.txt whitelist.txt auto-update autostart dns-takeover; do
    [ ! -f "$STATE/$name" ] || cp "$STATE/$name" "$export_stage/$name" || { rm -rf "$stage"; return 1; }
  done
  printf '%s\n' 'This archive contains personal lists and basic preferences only.' \
    'The complete recovery backup, including credentials, stays in the module Root-private backups directory.' > "$export_stage/README.txt"
  if ! "$TARBIN" -czf "$export_backup.tmp" -C "$export_stage" . ||
     ! "$TARBIN" -tzf "$export_backup.tmp" >/dev/null 2>&1 ||
     ! mv "$export_backup.tmp" "$export_backup"; then
    rm -f "$export_backup.tmp"; rm -rf "$stage"
    echo '[!] 规则备份创建失败；原设置未更改，完整私有备份仍保留。' >&2
    return 1
  fi

  echo '[进度] 安全停止 DNS 服务并清理 IPv4 接管…'
  "$BB" sh "$TOOL" stop || { rm -rf "$stage"; echo '[!] DNS 服务或接管未能安全停止；未清除任何设置。' >&2; echo "[备份] $backup"; return 1; }
  stopped=1

  for item in "$STATE"/* "$STATE"/.[!.]* "$STATE"/..?*; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    name=${item##*/}
    if [ "$name" = ai ]; then
      mkdir -p "$old_state/ai" || fail_after_stop "Cannot stage existing AI settings."
      for ai_item in "$STATE/ai"/* "$STATE/ai"/.[!.]* "$STATE/ai"/..?*; do
        [ -e "$ai_item" ] || [ -L "$ai_item" ] || continue
        [ "${ai_item##*/}" = worker.lock ] && continue
        mv "$ai_item" "$old_state/ai/" || fail_after_stop "Cannot stage existing AI settings."
      done
      continue
    fi
      case "$name" in webui-jobs|update.lock|root-family|backups) continue ;; esac
    mv "$item" "$old_state/" || fail_after_stop "Cannot stage existing module state."
  done
  state_moved=1

  for item in settings.conf admin.auth bin/AdGuardHome.yaml bin/data bin/userfilters; do
    mkdir -p "$old_runtime/$(dirname "$item")" || fail_after_stop "Cannot prepare runtime rollback files."
    mv "$AGH/$item" "$old_runtime/$item" || fail_after_stop "Cannot stage existing AdGuard Home data."
  done
  runtime_moved=1

  mkdir -p "$AGH/bin" || fail_after_stop 'Cannot prepare AdGuard Home runtime directories.'
  for item in settings.conf admin.auth bin/AdGuardHome.yaml bin/data bin/userfilters; do
    mkdir -p "$AGH/$(dirname "$item")" || fail_after_stop 'Cannot prepare AdGuard Home runtime directories.'
    mv "$new_runtime/$item" "$AGH/$item" || fail_after_stop 'Cannot install fresh AdGuard Home defaults.'
  done
  for item in "$new_state"/*; do
    [ -f "$item" ] || continue
    name=${item##*/}
    mv "$item" "$STATE/$name" || fail_after_stop 'Cannot install fresh module preferences.'
  done

  echo '[进度] 初始化默认规则源与规则快照…'
  ABP_CONFIG_LOCKED=1 "$BB" sh "$CONFIG" init-sources || fail_after_stop 'Cannot initialize default rule sources.'
  ABP_AGH_DIR="$AGH" ABP_STATE_DIR="$STATE" ABP_MODULE_DIR="$MODULE" "$BB" sh "$RULE_STORE" init || fail_after_stop 'Cannot initialize shared-rule defaults.'
  "$BB" sh "$RENDER" --render-user-rules || fail_after_stop 'Cannot build default personal rules.'
  printf '%s\n' "$AGH/bin/userfilters/adblock-pro-user-rules.txt" > "$STATE/user-filter-applied.tmp" &&
    chmod 600 "$STATE/user-filter-applied.tmp" && mv "$STATE/user-filter-applied.tmp" "$STATE/user-filter-applied" ||
    fail_after_stop 'Cannot mark the default personal filter as installed.'

  echo '[进度] 启动默认 DNS 服务…'
  "$BB" sh "$TOOL" start || fail_after_stop 'Fresh DNS configuration did not start; previous settings were restored.'
  stopped=0
  rm -rf "$stage"
  for item in "$JOBS"/*.log "$JOBS"/*.done "$JOBS"/*.action; do
    [ -f "$item" ] || continue
    name=${item##*/}; name=${name%%.*}
    [ "$name" = "$request_id" ] || rm -f "$item"
  done
  echo '[完成] 已恢复本版本的全新安装默认状态。IPv6 DNS 接管仍关闭。'
  echo "[规则备份] $export_backup"
  echo "[私有完整备份] $backup（含凭据，仅 Root 可访问，请勿分享）"
}

case "${1:-}" in
  __locked) shift; reset_defaults "$@" ;;
  '') echo '[!] 缺少默认设置恢复任务编号。' >&2; exit 1 ;;
  *)
    case "$1" in *[!0-9]*) echo '[!] 默认设置恢复任务编号无效。' >&2; exit 1 ;; esac
    [ ${#1} -le 20 ] || { echo '[!] 默认设置恢复任务编号无效。' >&2; exit 1; }
    [ -d "$AGH" ] && [ -d "$STATE" ] || { echo '[!] Module data paths are incomplete; nothing was changed.' >&2; exit 1; }
    mkdir -p "$STATE/ai" || { echo '[!] Cannot prepare the AI task lock.' >&2; exit 1; }
    reset_guard="$AGH/factory-reset.active"
    if [ -e "$reset_guard" ]; then
      old_pid=$(cat "$reset_guard" 2>/dev/null)
      case "$old_pid" in ''|*[!0-9]*) old_pid='' ;; esac
      if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
        if [ ! -r "/proc/$old_pid/cmdline" ] || "$BB" tr '\000' ' ' < "/proc/$old_pid/cmdline" | "$BB" grep -Fq "$AGH/scripts/factory-reset.sh"; then
          echo '[!] 默认设置恢复正在执行，请等待完成后重试。' >&2
          exit 1
        fi
      fi
      rm -f "$reset_guard" || { echo '[!] Cannot clear an expired reset marker.' >&2; exit 1; }
    fi
    ( set -C; printf '%s\n' "$$" > "$reset_guard" ) 2>/dev/null || { echo '[!] 默认设置恢复正在执行，请等待完成后重试。' >&2; exit 1; }
    chmod 600 "$reset_guard" || { rm -f "$reset_guard"; exit 1; }
    "$BB" flock -n "$STATE/update.lock" "$BB" flock -n "$STATE/ai/worker.lock" "$BB" sh "$0" __locked "$1"
    result=$?
    rm -f "$reset_guard"
    if [ "$result" -ne 0 ]; then echo '[!] Another DNS update or AI analysis may be running; no reset was applied unless the log says rollback started.' >&2; fi
    exit "$result"
    ;;
esac
