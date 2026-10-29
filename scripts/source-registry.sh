#!/system/bin/sh
# Only reviewed source addresses are fetched; user selections are never rewritten.
STATE=${ABP_STATE_DIR:-/data/adb/bindhosts_personal}
AGH=${ABP_AGH_DIR:-/data/adb/adblockpro}
MODULE=${ABP_MODULE_DIR:-/data/adb/modules/bindhosts_personal}
. "${0%/*}/compat.sh" || exit 1
SOURCE=https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/main/rules/source-registry.tsv
BUNDLE=$MODULE/rules/source-registry.tsv
source_ref=${SOURCE#https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/}
source_ref=${source_ref%%/*}
case "$source_ref" in
  main) CACHE=$STATE/source-registry.tsv ;;
  *) CACHE=$STATE/source-registry-test-$source_ref.tsv ;;
esac
umask 077

valid_registry() {
  [ -s "$1" ] && [ "$(wc -c < "$1")" -le 16384 ] || return 1
  "$BB" awk -F '\t' '
    function valid_url(url, host,path,n,i,part) {
      if(length(url)>1200 || substr(url,1,8)!="https://") return 0
      url=substr(url,9); i=index(url,"/"); if(i<2) return 0
      host=tolower(substr(url,1,i-1)); path=substr(url,i)
      if(path !~ /^\/[A-Za-z0-9._~%\/@:+-]*$/ || length(host)>253) return 0
      n=split(host,part,"."); if(n<2 || part[n] ~ /^[0-9]+$/ || part[n] ~ /^(local|localhost|internal|lan|home)$/) return 0
      for(i=1;i<=n;i++) if(length(part[i])<1 || length(part[i])>63 || part[i] !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) return 0
      return 1
    }
    { sub(/\r$/, "") }
    /^# revision: [0-9]+$/ { if(++rev_count>1 || length($0)>24) bad=1; rev=$0; sub(/^# revision: /,"",rev); if(rev ~ /^0/ || length(rev)>12) bad=1; next }
    /^#/ || /^$/ { next }
    {
      if(NF!=2 || ($1!="10007" && $1!="awa-full" && $1!="goodbyeads" && $1!="goodbyeads-allow" && $1!="shared") || !valid_url($2)) bad=1
      if(++counts[$1]>10 || seen[$0]++ || ++rows>50) bad=1
    }
    END { if(bad || rev_count!=1 || !counts["10007"] || !counts["awa-full"] || !counts["goodbyeads"] || !counts["goodbyeads-allow"] || !counts["shared"]) exit 1 }
  ' "$1"
}
revision() { "$BB" awk '/^# revision: / { print $3; exit }' "$1"; }
newer() { "$BB" awk -v a="$1" -v b="$2" 'BEGIN { exit !(a+0 > b+0) }'; }
select_registry() {
  current=''
  if valid_registry "$BUNDLE"; then current=$BUNDLE; fi
  if valid_registry "$CACHE"; then
    if [ -z "$current" ] || newer "$(revision "$CACHE")" "$(revision "$current")"; then current=$CACHE; fi
  fi
  [ -n "$current" ]
}
source_id() {
  case "$1" in
    https://edgeone.gh-proxy.org/https://raw.githubusercontent.com/lingeringsound/10007_auto/master/reward) echo 10007 ;;
    https://cdn.uura.cn/AWAvenue/AWAvenue-Ads-Rule.txt) echo awa-full ;;
    https://ghfast.top/raw.githubusercontent.com/8680/GOODBYEADS/master/data/rules/dns.txt) echo goodbyeads ;;
    https://ghfast.top/raw.githubusercontent.com/8680/GOODBYEADS/master/data/rules/allow.txt) echo goodbyeads-allow ;;
    shared) echo shared ;;
    *) return 1 ;;
  esac
}

case "$1" in
  urls)
    id=$(source_id "$2") || exit 1
    select_registry || exit 1
    "$BB" awk -F '\t' -v id="$id" '$1==id { print $2 }' "$current"
    ;;
  refresh)
    select_registry || { echo '[提醒] 随包线路清单无效，沿用原有线路。' >&2; exit 1; }
    baseline=$(revision "$current")
    [ -s "$AGH/certs/cacert.pem" ] || { echo '[提醒] CA 证书缺失，沿用现有线路清单。' >&2; exit 0; }
    CURL=${CURL:-$(abp_find_curl)}
    [ -n "$CURL" ] || { echo '[提醒] 下载工具不可用，沿用现有线路清单。' >&2; exit 0; }
    mkdir -p "$STATE" || exit 1
    temp="$STATE/.source-registry.$$"
    trap 'rm -f "$temp"' EXIT
    registry_urls=$SOURCE
    ref_allowed=0
    if [ "$source_ref" = main ]; then ref_allowed=1
    elif [ ${#source_ref} -eq 40 ]; then
      case "$source_ref" in *[!0-9a-f]*) ;; *) ref_allowed=1 ;; esac
    fi
    if [ "$ref_allowed" = 1 ]; then
      registry_urls="$registry_urls https://gcore.jsdelivr.net/gh/Ccmra404/AdBlock-Pro-next@$source_ref/rules/source-registry.tsv https://cdn.jsdelivr.net/gh/Ccmra404/AdBlock-Pro-next@$source_ref/rules/source-registry.tsv https://ghfast.top/raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/$source_ref/rules/source-registry.tsv"
    fi
    for registry_url in $registry_urls; do
      if "$CURL" --cacert "$AGH/certs/cacert.pem" --silent --show-error --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 3 --max-time 6 --max-filesize 16384 "$registry_url" -o "$temp" && valid_registry "$temp"; then
        next=$(revision "$temp")
        if newer "$next" "$baseline"; then
          chmod 600 "$temp" && mv -f "$temp" "$CACHE" || exit 1
          echo '[+] 在线规则线路清单已更新。'
          exit 0
        fi
        if [ "$next" = "$baseline" ] && "$BB" cmp -s "$temp" "$current"; then exit 0; fi
      fi
      rm -f "$temp"
    done
    echo '[提醒] 在线线路清单暂不可用或版本不匹配，继续使用本地有效清单。' >&2
    ;;
  *) echo 'Usage: source-registry.sh {refresh|urls source}' >&2; exit 1 ;;
esac
