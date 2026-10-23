#!/system/bin/sh
# Explicit diagnosis only: no network requests, settings writes or raw system dumps.
. "${0%/*}/compat.sh" || exit 1
AGH_DIR=${ABP_AGH_DIR:-/data/adb/adblockpro}

read_setting() {
  "$BB" timeout 2 settings get global "$1" 2>/dev/null
}

private_dns=unknown
if value=$(read_setting private_dns_mode); then
  if [ "$value" = null ]; then
    value=$(read_setting private_dns_default_mode) || value=unknown
    [ "$value" != null ] || value=system_default
  fi
  case "$value" in off|opportunistic|hostname|system_default) private_dns=$value ;; esac
fi
printf 'diag_private_dns=%s\n' "$private_dns"

proxy=not_configured; proxy_unknown=0
for key in http_proxy global_http_proxy_host global_proxy_pac_url; do
  if ! value=$(read_setting "$key"); then proxy_unknown=1; continue; fi
  [ "$value" != null ] || continue
  case "$value" in ''|*'
'*) proxy_unknown=1; continue ;; esac
  [ "$key:$value" != 'http_proxy::0' ] || continue
  case "$key" in
    http_proxy) pattern='^([A-Za-z0-9._%-]+|\[[A-Fa-f0-9:%]+\]):[0-9]+$' ;;
    global_http_proxy_host) pattern='^[A-Za-z0-9._:%-]+$|^\[[A-Fa-f0-9:%]+\]$' ;;
    global_proxy_pac_url) pattern='^https?://[^[:space:]]+$' ;;
  esac
  if printf '%s\n' "$value" | "$BB" grep -Eq "$pattern"; then proxy=configured
  else proxy_unknown=1; fi
done
[ "$proxy" = configured ] || [ "$proxy_unknown" = 0 ] || proxy=unknown
printf 'diag_global_http_proxy=%s\n' "$proxy"

vpn=unknown
if snapshot=$("$BB" timeout 3 dumpsys connectivity --short 2>/dev/null); then
  vpn=$(printf '%s\n' "$snapshot" | "$BB" awk '
    /^[[:space:]]*Current Networks:[[:space:]]*$/ {
      if (started) bad=1
      started=1; inside=1; next
    }
    inside && /^[^[:space:]]/ { inside=0; closed=1 }
    inside && /^[[:space:]]*NetworkAgentInfo[[:space:]]*[{\[]/ {
      entries++
      if ($0 !~ /Transports:/) { bad=1; next }
      transports=$0
      sub(/^.*Transports:[[:space:]]*/, "", transports)
      sub(/[[:space:]]+Capabilities:.*/, "", transports)
      if (transports !~ /[A-Z_]/) { bad=1; next }
      n=split(transports, transport, /[^A-Z_]+/)
      for (i=1; i<=n; i++) if (transport[i]=="VPN") found=1
      next
    }
    inside && /^[[:space:]]*NetworkAgentInfo/ { bad=1 }
    inside && !entries && /[^[:space:]]/ { bad=1 }
    END {
      if (!started || !closed || bad) print "unknown"
      else print found ? "detected" : "not_detected"
    }') || vpn=unknown
fi
unset snapshot value
printf 'diag_vpn=%s\n' "$vpn"

ipv6=$("$BB" timeout 6 "$BB" sh "$AGH_DIR/scripts/iptables.sh" diagnose-ipv6 2>/dev/null) || ipv6=''
printf '%s\n' "$ipv6" | "$BB" awk -F= '
  { count[$1]++; if (NF==2) data[$1]=$2 }
  function value(key, pattern) { return count[key]==1 && data[key] ~ pattern ? data[key] : "unknown" }
  function label(state) {
    if (state=="readable") return "可读取"
    if (state=="unsupported") return "明确不可用"
    if (state=="present") return "已发现"
    if (state=="absent") return "未发现"
    return "查询失败或无法确认"
  }
  END {
    mode=value("diag_ipv6_mode", "^(disabled|redirect|block|unknown)$")
    nat=value("diag_ipv6_nat_table", "^(readable|unsupported|unknown)$")
    filter=value("diag_ipv6_filter_table", "^(readable|unsupported|unknown)$")
    redirect=value("diag_ipv6_redirect", "^(present|absent|unsupported|unknown)$")
    block=value("diag_ipv6_block", "^(present|absent|unsupported|unknown)$")
    print "diag_ipv6_mode=" mode
    print "diag_ipv6_nat_table=" nat
    print "diag_ipv6_redirect=" redirect
    print "diag_ipv6_filter_table=" filter
    print "diag_ipv6_block=" block
    mode_text=mode=="disabled" ? "未启用" : mode=="redirect" ? "重定向" : mode=="block" ? "拒绝 DNS" : "无法确认"
    print "[IPv6] 配置：" mode_text "；NAT 表：" label(nat) "；重定向跳转：" label(redirect) "。"
    print "[IPv6] filter 表：" label(filter) "；DNS 拒绝跳转：" label(block) "。"
    if (mode=="disabled" && (redirect=="present" || block=="present"))
      print "[提醒] IPv6 接管未启用，但仍发现本模块 IPv6 跳转，需检查残留规则。"
    if (mode=="redirect" && redirect=="unsupported")
      print "[提醒] 已配置 IPv6 重定向，但 IPv6 NAT 表明确不可用。"
    else if (mode=="redirect" && redirect=="absent")
      print "[提醒] 已配置 IPv6 重定向，但未发现本模块跳转。"
  }'

case "$private_dns" in
  off) text='关闭' ;;
  opportunistic) text='自动（不代表当前已使用加密 DNS）' ;;
  hostname) text='指定提供商（不代表连接已验证）' ;;
  system_default) text='系统默认' ;;
  *) text='查询失败或无法确认' ;;
esac
printf '[网络] 私人 DNS 配置：%s。\n' "$text"
case "$proxy" in configured) text='已配置' ;; not_configured) text='未配置' ;; *) text='查询失败或无法确认' ;; esac
printf '[网络] 全局 HTTP 代理配置：%s。\n' "$text"
case "$vpn" in detected) text='发现 VPN 网络' ;; not_detected) text='未发现 VPN 网络' ;; *) text='查询失败或格式无法识别' ;; esac
printf '[网络] 系统当前网络列表：%s。\n' "$text"
printf '[说明] 以上为配置与当前网络记录，不能确认目标应用的实际 DNS 路径；不包含 Wi-Fi 单独代理或应用内 DoH/代理。\n'
