# 网络诊断说明

在「设置 → 运行诊断」或「总览 → 环境诊断」提交检查，结果保存在「运行日志」。展开命令输出可看到中文说明及 `diag_` 字段。诊断只读取系统配置、监听和防火墙状态，不执行外网测速，不修改 DNS、VPN、私人 DNS 或代理设置。

## IPv6：配置和实际状态分别显示

| 字段 | 含义 |
| --- | --- |
| `diag_ipv6_mode` | `disabled` 未启用、`redirect` 重定向、`block` 拒绝 DNS、`unknown` 配置无法确认 |
| `diag_ipv6_nat_table` / `diag_ipv6_filter_table` | `readable` 表及 OUTPUT 列表可读取，`unsupported` 工具明确报告该表不可用，`unknown` 查询失败或结果不完整 |
| `diag_ipv6_redirect` / `diag_ipv6_block` | 本模块在 OUTPUT 的 IPv6 重定向或拒绝跳转：`present` 已发现、`absent` 确认未发现、`unsupported` 表明确不可用、`unknown` 无法确认 |

“未启用”表示保存的偏好；即使未启用，诊断仍会检查本模块遗留的 IPv6 跳转，并提示残留。“表可读取”不能证明内核能成功安装 REDIRECT，也不能证明某个应用的 IPv6 查询经过了模块。防火墙锁等待最多 1 秒，失败显示未知。

此改动沿用默认关闭 IPv6 DNS 接管的策略。诊断不会自动增加 IPv6 跳转或阻断 IPv6 网络。

## 私人 DNS、全局 HTTP 代理与 VPN

- **私人 DNS**读取系统模式；未显式配置时继续读取系统默认模式。`hostname` 表示指定提供商，`opportunistic` 表示自动，均不代表当前连接已经验证或实际采用加密 DNS。查询失败、空输出或无法识别的值显示未知，不输出提供商域名。
- **全局 HTTP 代理**只报告配置是否存在，不输出地址、端口、PAC 链接或凭据。它不包含 Wi-Fi 单独代理及应用自身设置；已配置也不等于可用。
- **VPN**只识别 `dumpsys connectivity --short` 的 `Current Networks` 段中的网络项，不把历史日志、网络请求或 `NOT_VPN` 文本当作 VPN。`detected` 只表示系统当前网络列表存在 VPN 记录，不能推断它是否承载目标应用。缺少权限、超时、格式不支持或输出不完整均显示未知。

系统设置查询每次最多 2 秒，VPN 查询最多 3 秒，整组 IPv6 防火墙查询最多 6 秒。诊断不保存原始 connectivity dump、网络地址、应用列表或私人 DNS 提供商。它只在用户主动诊断时运行，不增加日常状态轮询开销。BusyBox 不提供 timeout 时，对应查询显示未知，不降级为无超时执行。

这些信息不能证明应用是否走 DoH/DoT、代理内置 DNS、缓存或 IP 直连。排查偶发广告和访问问题时，应针对具体应用做 VPN 开关前后、普通 Wi-Fi/移动网络的对照，并结合域名观察与规则检查；不能仅凭配置快照认定冲突。

实现依据：[Android 私人 DNS 与全局代理设置定义](https://android.googlesource.com/platform/packages/modules/Connectivity/+/refs/heads/main/framework/src/android/net/ConnectivitySettingsManager.java)、[ConnectivityService 当前网络输出](https://android.googlesource.com/platform/packages/modules/Connectivity/+/refs/heads/main/service/src/com/android/server/ConnectivityService.java)。Android 和厂商输出可能变化，因此不识别的格式保留未知状态。
