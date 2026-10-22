# DNS 上游设置

入口：模块 WebUI → 设置 → 运行维护 → DNS 上游设置。

此页面通过本机 AdGuard Home 官方 API 读取、测试和修改 DNS 配置，不修改 Android 私人 DNS、VPN、代理软件或 IPv6 接管策略。功能所在 PR 合并并随安装包发布前，已有正式版不会出现此入口。

## 查看和测试

- 上游 DNS 用于日常域名解析。
- 引导 DNS 用于解析 DoH/DoT 服务器的主机名，填写 IP 地址。
- 备用 DNS 可留空。上游故障时的回退由 AdGuard Home 处理；备用地址为普通 IP 时会使用明文 DNS。
- 查询模式沿用当前值，支持负载均衡、并行查询和最快地址。并行模式不判断答案正确性；最快地址会额外探测。

每组最多填写 8 个地址，每行一个。支持普通 IP、IP 加端口、HTTPS DoH 和 TLS DoT。为避免指回本机解析器形成回环，此页面不接受回环地址；分域上游、DNS stamps、文件上游及其他高级配置由原生后台管理，读取时不会删改。

“填入国内普通 DNS”和“填入阿里 + 腾讯 DoH”只修改草稿中的上游及引导地址，不替换当前查询模式或备用 DNS，也不立即应用。DoH 入口采用服务商公开地址：

- 阿里：`https://dns.alidns.com/dns-query`，见[阿里云官方说明](https://static-aliyun-doc.oss-cn-hangzhou.aliyuncs.com/download%2Fpdf%2F176819%2F%25E5%25BF%25AB%25E9%2580%259F%25E5%2585%25A5%25E9%2597%25A8_cn_zh-CN.pdf)。
- 腾讯：`https://doh.pub/dns-query`，见[DNSPod 官方公告](https://docs.dnspod.cn/notices/guan-yu-doh-dotdu-li-ce-shi-ipxia-xian-de-gong-gao/)。

点击“测试草稿”在设备当前网络测试上游、备用和引导地址。它不会应用配置，也不会验证所有网站的访问速度、解析答案是否正确或广告效果。失败时调整地址后重试；不要关闭 TLS 证书验证。电脑的 TUN 可达性不能替代手机国内网络验收。

## 保存与恢复

1. 点击“测试并保存”，检查确认说明。
2. 后台重新测试地址，失败时保留当前配置；成功后先保存私有恢复点，再通过 API 更新四个 DNS 字段，并重新读取校验。
3. 修改失败会尝试恢复操作前配置；恢复未能确认时尝试撤销本模块的 DNS 重定向，保留核心与恢复点，具体结果见运行日志。
4. “恢复上次配置”恢复最近一次保存前的四个 DNS 字段，不覆盖名单、订阅或账号，也不要求当前外网测试成功。恢复需要本地核心 API 仍可访问。

操作不会重启整个模块。成功应用后会尝试清理 DNS 缓存；缓存清理失败会提示，但不将已保存的配置误报为未保存。

恢复点仅位于 Root 私有目录 `/data/adb/adblockpro/backups/dns-before-change.json`，可能包含自定义 DNS 地址和参数，不要公开分享。页面不会把 DNS 配置写入操作日志或浏览器本地存储。

模块会在保存前检测读取后发生的 DNS 配置变化，发现变化时要求重新读取。官方 API 不提供原子条件写入，请避免同时在原生后台和模块 WebUI 修改 DNS 设置。上次测试通过不保证更换网络后仍然可用。

相关官方接口：[dns_info / test_upstream_dns / dns_config / cache_clear](https://github.com/AdguardTeam/AdGuardHome/blob/v0.107.79/openapi/openapi.yaml)。
