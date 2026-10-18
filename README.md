<div align="center">

# AdBlock Pro

**在 DNS 请求阶段过滤广告域名。漏拦截时，观察、分析，再决定是否加入规则。**

面向 Android ARM64 Root 设备的本地 DNS 过滤模块

[![Release](https://img.shields.io/github/v/release/Ccmra404/AdBlock-Pro-next?label=Release&color=41866b)](https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest)
![Root](https://img.shields.io/badge/Root-KernelSU%20%7C%20Magisk%20%7C%20APatch-555555)
[![License](https://img.shields.io/badge/License-GPL--3.0-555555)](LICENSE)

[**下载最新版**](https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest) · [使用指南](docs/guide.md) · [AI 域名分析](docs/ai-domain-analysis.md) · [共享规则贡献](docs/shared-app-rules.md#社区贡献) · [反馈问题](https://github.com/Ccmra404/AdBlock-Pro-next/issues) · [Debug 版 ADB 诊断](docs/adb-debug.md)

</div>

<p align="center">
  <a href="docs/assets/screenshots/overview.jpg"><img src="docs/assets/screenshots/overview.jpg" width="30%" alt="总览页面：DNS 状态、规则数量与内存"></a>
  <a href="docs/assets/screenshots/domain-observation.jpg"><img src="docs/assets/screenshots/domain-observation.jpg" width="30%" alt="名单页面：观察域名并选择后续操作"></a>
  <a href="docs/assets/screenshots/shared-rules.jpg"><img src="docs/assets/screenshots/shared-rules.jpg" width="30%" alt="共享规则库：同步、搜索与提交候选"></a>
</p>

<p align="center"><sub>实机界面截图。点击图片可查看大图；按钮和截图中的数字可能随版本与设备状态变化。</sub></p>

AdBlock Pro 在 Root Android 设备本地运行 AdGuard Home，过滤广告及部分跟踪域名。中文 WebUI 集中管理规则来源、个人黑白名单、域名观察和运行诊断。

## 从观察到共享规则

1. **观察**：在「名单」页选择本机应用，短时记录设备 DNS 请求。观察结果可能包含后台应用请求，不能精确归因到所选应用。
2. **AI 分析**：按需配置 DeepSeek 或兼容 OpenAI Chat Completions 的 HTTPS 接口。勾选域名并确认发送后，模块只提交所选域名。AI 仅给出判断建议，不会自动改名单或公开规则。
3. **加入个人名单**：确认后加入拦截或放行名单。名单修改会单独应用，不必重新下载全部订阅，也不会重启 DNS。
4. **贡献共享规则**：从共享规则库生成 GitHub 候选链接，检查后手动提交。维护者审核通过后才会更新公共快照，其他设备再同步使用。

## 规则由你管理

- 安装包内置 10007、秋风 AdGuard 全规则和已审核的共享规则快照，首次安装可直接使用。
- 规则来源可逐项导入、停用或移除；远程订阅支持改链接和重命名。更新失败时保留上一版有效规则。
- 个人黑白名单与订阅分开保存；白名单优先于共享规则。可导入、导出和单独管理。
- 总览、运行日志和诊断帮助查看 DNS 核心、接管状态、规则和任务结果。

## 安装

1. 准备已 Root 的 Android ARM64 设备，并停用会争用 DNS 端口或 AdGuard Home 服务的模块。
2. 从 [Releases](https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest) 下载完整 ARM64 安装包，通过 Root 管理器安装并重启。GitHub 的 `Source code` 压缩包不能安装。
3. 打开模块 WebUI，先在「总览」检查 DNS 核心和接管状态，再按需调整规则。

模块适配 KernelSU、Magisk 和 APatch。Magisk 用户需要兼容 `ksu.exec` 的 WebUI 宿主，例如 [WebUI X](https://github.com/MMRLApp/WebUI-X-Portable)。具体 Root 管理器和设备的验证范围见对应 [Release 说明](https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest)；APatch 及新增 AI、Debug 路径尚未全部完成真机验收。

## 使用边界

- 默认只接管 IPv4 明文 TCP/UDP 53，IPv6 DNS 接管默认关闭。私人 DNS、VPN、应用内 DoH/DoT 可能绕过过滤。
- DNS 过滤不能移除应用内广告占位，也不保证拦截缓存广告或与正常内容共用域名的广告。开屏跳过可独立搭配 [GKD](https://github.com/gkd-kit/gkd)。
- 域名观察和 AI 判断都需要人工核对。AI 服务只在你确认后收到所选域名；服务商可能按请求收费。共享规则也必须由你检查并手动提交。

网络异常时，从「系统设置 → 紧急解除接管」关闭本模块 DNS 重定向，再查看运行日志。更多排查方式见[使用指南](docs/guide.md)。

## 项目与许可

由 **Ccmra** 维护，采用 [GPL-3.0](LICENSE)。过滤引擎来自 [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome)；内置规则来自 [10007](https://github.com/lingeringsound/10007_auto)、[AWAvenue Ads Rule](https://github.com/TG-Twilight/AWAvenue-Ads-Rule) 和维护者审核的共享规则。第三方组件遵循各自许可证，见 [第三方声明](THIRD_PARTY_NOTICES.md)。
