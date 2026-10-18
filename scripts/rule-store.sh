#!/system/bin/sh
# Public reviewed rules and local private lists have separate storage.
STATE=${ABP_STATE_DIR:-/data/adb/bindhosts_personal}
AGH=${ABP_AGH_DIR:-/data/adb/adblockpro}
MODULE=${ABP_MODULE_DIR:-/data/adb/modules/bindhosts_personal}
. "${0%/*}/compat.sh" || exit 1
SOURCE=${ABP_SHARED_RULES_URL:-https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/main/rules/shared-app-domains.txt}
SHARED=$STATE/shared-app-domains.txt
FILTER=$AGH/bin/userfilters/adblock-pro-shared-app-rules.txt
umask 077
mkdir -p "$STATE" "$AGH/bin/userfilters" || exit 1
work="$STATE/.rule-store.$$"
mkdir "$work" || exit 1
trap 'rm -rf "$work"' EXIT

normalize_shared() {
  [ -s "$1" ] && [ "$(wc -c < "$1")" -le 65536 ] || return 1
  "$BB" awk '
    function valid(d, a,n,i) {
      if (length(d)>253 || index(d,".")==0) return 0
      n=split(d,a,".")
      for(i=1;i<=n;i++) if(length(a[i])>63 || a[i] !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) return 0
      return 1
    }
    { sub(/\r$/, ""); sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, "") }
    /^# revision: [0-9]+$/ { if(++revisions>1 || length($3)>12) bad=1; revision=$3; next }
    /^#/ || /^$/ { next }
    { d=tolower($0); if(!valid(d)) bad=1; else domains[d]=1; if(++rows>5000) bad=1 }
    END {
      if(bad || !revision || rows<1) exit 1
      print "# revision: " revision
      for(d in domains) print d
    }
  ' "$1" > "$work/normalized" || return 1
  "$BB" sort -u "$work/normalized" > "$2"
}
revision() { "$BB" awk '/^# revision:/ { print $3; exit }' "$1"; }
commit_shared() {
  "$BB" awk '!/^#/ && NF { print "||" $0 "^" }' "$1" > "$work/filter" || return 1
  if [ -f "$SHARED" ] && "$BB" cmp -s "$1" "$SHARED"; then
    if [ -f "$FILTER" ] && "$BB" cmp -s "$work/filter" "$FILTER"; then return 0; fi
    mv "$work/filter" "$FILTER"; return
  fi
  [ ! -f "$SHARED" ] || cp -p "$SHARED" "$work/before" || return 1
  # Both files are staged before changing the current snapshot.
  if mv "$1" "$SHARED" && mv "$work/filter" "$FILTER"; then return 0; fi
  if [ -f "$work/before" ]; then cp -p "$work/before" "$SHARED"; else rm -f "$SHARED"; fi
  return 1
}
initialize_shared() {
  normalize_shared "$MODULE/rules/shared-app-domains.txt" "$work/bundle" || return 1
  if [ -f "$SHARED" ]; then
    normalize_shared "$SHARED" "$work/current" || return 1
    if [ "$(revision "$work/current")" -ge "$(revision "$work/bundle")" ]; then
      commit_shared "$work/current"; return
    fi
  fi
  commit_shared "$work/bundle"
}
import_lists() {
  encoded=$1
  case "$encoded" in ''|*[!A-Za-z0-9+/=]*) return 1 ;; esac
  [ ${#encoded} -le 98304 ] || return 1
  printf '%s' "$encoded" | "$BB" base64 -d > "$work/import" || return 1
  [ "$(wc -c < "$work/import")" -le 65536 ] || return 1
  # The WebUI sends only tagged domains. Validate again before any write.
  "$BB" awk -F '\t' '
    function valid(d,a,n,i) {
      if(length(d)>253 || index(d,".")==0) return 0
      n=split(d,a,".")
      for(i=1;i<=n;i++) if(length(a[i])>63 || a[i] !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) return 0
      return 1
    }
    { sub(/\r$/, ""); d=tolower($2); if(NF!=2 || ($1!="B" && $1!="W") || !valid(d)) bad=1; else print $1 "\t" d; if(++n>5000) bad=1 }
    END { if(bad || n<1) exit 1 }
  ' "$work/import" > "$work/validated" || return 1
  for kind in blacklist whitelist; do
    file="$STATE/$kind.txt"
    [ -f "$file" ] || return 1
    cp -p "$file" "$work/$kind.before" || return 1
    [ "$kind" = blacklist ] && tag=B || tag=W
    { cat "$file"; printf '\n'; "$BB" awk -F '\t' -v tag="$tag" '$1==tag { print $2 }' "$work/validated"; } |
      "$BB" awk '{ sub(/\r$/, ""); if(/^#/){print; next} sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); if(NF && !seen[tolower($0)]++) print tolower($0) }' > "$work/$kind.next" || return 1
  done
  if ! mv "$work/blacklist.next" "$STATE/blacklist.txt" || ! mv "$work/whitelist.next" "$STATE/whitelist.txt"; then
    cp -p "$work/blacklist.before" "$STATE/blacklist.txt"
    cp -p "$work/whitelist.before" "$STATE/whitelist.txt"
    return 1
  fi
  echo '[+] 个人名单已合并导入；现有名单保留，执行规则更新后生效。'
}

case "$1" in
  init) initialize_shared || { echo '[!] Cannot initialize a valid shared rule snapshot.' >&2; exit 1; } ;;
  show)
    file=$SHARED; [ -f "$file" ] || file="$MODULE/rules/shared-app-domains.txt"
    normalize_shared "$file" "$work/current" || { echo '[!] Shared rule snapshot is unavailable.' >&2; exit 1; }
    printf 'revision=%s\nupdated_at=%s\n' "$(revision "$work/current")" "$(stat -c %Y "$file" 2>/dev/null || echo 0)"
    "$BB" awk '!/^#/ && NF { print "domain\t" $0 }' "$work/current"
    ;;
  sync)
    case "$SOURCE" in https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/*/rules/shared-app-domains.txt) ;; *) echo '[!] Invalid shared repository URL.' >&2; exit 1 ;; esac
    CURL=${CURL:-$(abp_find_curl)}
    [ -s "$AGH/certs/cacert.pem" ] || { echo '[!] 模块 CA 证书包缺失，无法安全同步共享规则。' >&2; exit 1; }
    candidate_urls=$SOURCE
    if [ "$SOURCE" = 'https://raw.githubusercontent.com/Ccmra404/AdBlock-Pro-next/main/rules/shared-app-domains.txt' ]; then
      candidate_urls="$candidate_urls https://gcore.jsdelivr.net/gh/Ccmra404/AdBlock-Pro-next@main/rules/shared-app-domains.txt https://cdn.jsdelivr.net/gh/Ccmra404/AdBlock-Pro-next@main/rules/shared-app-domains.txt"
    fi
    downloaded=0
    dns_failure=0
    tls_failure=0
    for candidate_url in $candidate_urls; do
      candidate_host=${candidate_url#https://}
      candidate_host=${candidate_host%%/*}
      echo "[进度] 尝试共享规则源：$candidate_host"
      if "$CURL" --cacert "$AGH/certs/cacert.pem" --silent --show-error --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time 20 --max-filesize 65536 "$candidate_url" -o "$work/download"; then
        [ "$candidate_url" = "$SOURCE" ] || echo '[+] 共享规则已从 HTTPS 镜像获取。'
        downloaded=1
        break
      else
        curl_status=$?
        case "$curl_status" in
          6|28) dns_failure=1 ;;
          60) tls_failure=1 ;;
        esac
      fi
      rm -f "$work/download"
    done
    if [ "$downloaded" != 1 ]; then
      [ "$dns_failure" != 1 ] || echo '[!] 共享规则镜像的域名无法解析或解析超时；请检查设备 DNS、VPN 或网络，旧快照已保留。' >&2
      [ "$tls_failure" != 1 ] || echo '[!] 共享规则镜像的 TLS 证书校验失败；请检查系统时间、CA 证书或网络代理，未关闭证书校验，旧快照已保留。' >&2
      echo '[!] 共享规则同步失败；现有共享规则快照和个人名单均已保留。' >&2
      exit 1
    fi
    normalize_shared "$work/download" "$work/next" || { echo '[!] Invalid shared rules; previous snapshot retained.' >&2; exit 1; }
    if [ -f "$SHARED" ]; then
      normalize_shared "$SHARED" "$work/current" || exit 1
      [ "$(revision "$work/next")" -ge "$(revision "$work/current")" ] || { echo '[!] Older shared snapshot refused.' >&2; exit 1; }
    fi
    commit_shared "$work/next" || exit 1
    echo '[+] 共享抓包规则已同步；未覆盖本机个人名单。'
    ;;
  import) import_lists "$2" || { echo '[!] 名单导入失败；请检查格式、域名或文件大小。' >&2; exit 1; } ;;
  export)
    case "$2" in local|shared) ;; *) exit 1 ;; esac
    case "$3" in ''|*[!0-9]*) exit 1 ;; esac
    [ ${#3} -le 20 ] || exit 1
    folder=${ABP_EXPORT_DIR:-/sdcard/Download/AdBlock Pro}
    mkdir -p "$folder" || exit 1
    chmod 755 "$folder" || exit 1
    case "$2" in local) export_name=personal-rules ;; shared) export_name=shared-rules ;; esac
    file="$folder/AdBlock-Pro-$export_name-$3.txt"
    if [ "$2" = local ]; then
      {
        printf '# AdBlock Pro personal lists\n[拦截名单]\n'
        "$BB" awk '!/^#/ && NF { sub(/\r$/, ""); print }' "$STATE/blacklist.txt"
        printf '\n[放行名单]\n'
        "$BB" awk '!/^#/ && NF { sub(/\r$/, ""); print }' "$STATE/whitelist.txt"
      } > "$work/export"
    else
      source=$SHARED; [ -f "$source" ] || source="$MODULE/rules/shared-app-domains.txt"
      normalize_shared "$source" "$work/export" || exit 1
    fi
    # Refuse an existing destination, including a symlink, in shared storage.
    ( set -C; cat "$work/export" > "$file" ) || { echo '[!] Export destination already exists or is unavailable.' >&2; exit 1; }
    chmod 644 "$file" || { rm -f "$file"; exit 1; }
    printf 'exported_path=%s\n' "$file"
    ;;
  write)
    case "$2" in operation-logs) extension=json ;; observed-domains) extension=txt ;; *) exit 1 ;; esac
    case "$3" in ''|*[!0-9]*) exit 1 ;; esac
    [ ${#3} -le 20 ] || exit 1
    case "$4" in ''|*[!A-Za-z0-9+/=]*) exit 1 ;; esac
    [ ${#4} -le 90000 ] || exit 1
    folder=${ABP_EXPORT_DIR:-/sdcard/Download/AdBlock Pro}
    mkdir -p "$folder" || exit 1
    chmod 755 "$folder" || exit 1
    printf '%s' "$4" | "$BB" base64 -d > "$work/export" || exit 1
    [ -s "$work/export" ] && [ "$(wc -c < "$work/export" | tr -d '[:space:]')" -le 65536 ] || exit 1
    file="$folder/AdBlock-Pro-$2-$3.$extension"
    ( set -C; cat "$work/export" > "$file" ) || { echo '[!] Export destination already exists or is unavailable.' >&2; exit 1; }
    chmod 644 "$file" || { rm -f "$file"; exit 1; }
    printf 'exported_path=%s\n' "$file"
    ;;
  *) exit 1 ;;
esac
