# AdBlock Pro v0.13.3

## 更新内容

- 新增可选 AI 域名分析，兼容 DeepSeek 与 OpenAI Chat Completions 接口。只发送用户选择并确认的域名；AI 只提供建议，导入个人名单或准备共享候选仍由用户确认。
- 个人名单新增、删除或导入后可单独应用，不必重新下载全部规则，也不重启 DNS；观察结果和 AI 结果支持批量选择。
- 更新共享规则库中的酷安开屏广告域名。
- 新增独立 Debug 版本，可通过 ADB 读取脱敏后的运行状态与观察摘要；正式版不保存 Debug 摘要。
- 更新模块自有 Go 工具链，并在构建中增加漏洞扫描门禁。

## 升级与兼容

可直接覆盖安装，保留 AdGuard Home 配置、账号凭据、个人名单、订阅和偏好。版本为 `v0.13.3`，versionCode 为 `49`。IPv6 DNS 接管仍默认关闭；DNS 核心和默认规则订阅策略未改变。

## 验证范围

- 自动化：代码检查、Go 漏洞扫描、真实 ARM64 AdGuard Home 规则测试、安装 ZIP 完整性和凭据排除检查通过。相关 PR：[#20](https://github.com/Ccmra404/AdBlock-Pro-next/pull/20)、[#21](https://github.com/Ccmra404/AdBlock-Pro-next/pull/21)、[#22](https://github.com/Ccmra404/AdBlock-Pro-next/pull/22)、[#23](https://github.com/Ccmra404/AdBlock-Pro-next/pull/23)、[#25](https://github.com/Ccmra404/AdBlock-Pro-next/pull/25)。
- 实机：Redmi K90 Pro Max（KernelSU 衍生管理器）已安装 Debug 构建并冷启动，确认模块标记、ADB 脚本、AdGuard Home 和 IPv4 DNS 接管状态正常。
- 限制：AI 结果只是域名分类建议，不能保证去除某个应用的全部广告；新增 AI/Debug 路径尚未在 Magisk 与 APatch 上单独验收。Debug 报告尚未完成一次新的真实广告观察复现。

