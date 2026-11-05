# AdBlock Pro v0.14.4

## 更新内容

- 模块界面和 AdGuard Home 原生后台共用当前订阅状态，可在模块中管理订阅的启用状态、名称和移除操作。模块规则源目录仍负责下载和更新规则。
- 默认启用 VPN/TUN 自动兼容。检测到 VPN 活跃时暂停 DNS 重定向，VPN 断开并确认后自动恢复。可在设置中调整此选项。
- 更新 AdGuard Home 至官方 v0.107.80。
- 修复更新器无法识别官方 AdGuard Home 压缩包内 `./AdGuardHome/AdGuardHome` 路径的问题。

## 升级说明

通过 Root 管理器覆盖安装并重启。首次升级会启用 VPN/TUN 自动兼容；如不需要，可在模块设置中关闭。其他现有配置和个人名单会保留。

## 验证

- GitHub Actions 代码检查和 ARM64 安装包构建通过。
- 已在 Xiaomi Pad 8 Pro、Android 17、ReSukiSU/KernelSU 4.2.0-rc2 安装组合候选包并重启，验证模块订阅管理、规则应用、规则更新，以及 FlClash VPN 连接时暂停 DNS 重定向、断开后恢复。
- AdGuard Home v0.107.80 在平板通过配置检查并随候选包运行；重启后模块界面显示 DNS 核心运行、DNS 重定向已应用。

## 回退

如升级后遇到问题，可覆盖安装上一稳定版 v0.14.3 并重启。
