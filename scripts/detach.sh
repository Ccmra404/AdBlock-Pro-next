#!/system/bin/sh
bb=$1
shift
# Long-lived children must not keep the caller's update/worker locks open.
exec "$bb" sh -c '
  for path in /proc/self/fd/*; do
    fd=${path##*/}
    case "$fd" in 0|1|2|""|*[!0-9]*) continue ;; esac
    eval "exec $fd>&-"
  done
  exec "$@"
' adblock-detach "$@"
