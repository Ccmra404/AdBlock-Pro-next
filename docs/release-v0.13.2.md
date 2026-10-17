# AdBlock Pro v0.13.2

修复部分 Android 设备同步共享规则或下载订阅时出现的 `curl (60): unable to get local issuer certificate`。

## 更新内容

- 随包补齐 Mozilla 公共 CA 证书，供模块自带 curl 校验 HTTPS；不再依赖 Android 系统证书目录的路径和哈希格式。
- 共享规则同步与普通订阅下载共用证书修复，继续校验证书及域名，不跳过 HTTPS 验证。
- 安装器检查证书文件是否缺失或为空；构建时核对证书 SHA-256、解析证书，并检查 ARM64 安装包内容。
- 新增 Root 管理器原生版本检查入口，通过 GitHub 正式版清单获取更新和中文日志。旧版用户需先手动覆盖安装一次，之后可由兼容管理器检查更新。

## 升级

可直接覆盖安装，无需全新安装。保留 AdGuard Home 账号、配置、订阅和个人黑白名单。

版本号为 `v0.13.2`，versionCode 为 `48`；AdGuard Home 核心、默认来源和 IPv6 默认关闭策略均未改动。

## 验证及范围

- 功能修复已通过代码检查、245 项 Node 测试、24 项 Python 测试、Go 测试及 ARM64 ZIP 构建；完整提交与验证记录见 [PR #18](https://github.com/Ccmra404/AdBlock-Pro-next/pull/18)。
- 已离线复现 Android 旧哈希证书目录校验失败，并验证 PEM 证书文件可正常校验；电脑使用随包证书成功通过 HTTPS 获取共享规则。
- 维护者反馈该修复测试包实机测试通过。未记录具体机型、Root 管理器和网络组合，因此不将此反馈扩大为所有设备兼容性结论。

本次针对证书信任链兼容问题；网络不可达、订阅地址失效、设备时间错误及 HTTPS 解密代理导致的失败仍需按实际日志排查。证书包来源和许可证见 `certs/README.md` 及 `THIRD_PARTY_NOTICES.md`。
