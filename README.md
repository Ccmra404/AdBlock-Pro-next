<div align="center">

# AdBlock Pro

**让去广告更可控，让好规则一起用。**

基于 AdGuard Home 的 Android Root DNS 过滤模块，面向 KernelSU、Magisk 与 APatch 模块环境。

[![Release](https://img.shields.io/github/v/release/Ccmra404/AdBlock-Pro-next?label=Release&color=41866b)](https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest)
[![License](https://img.shields.io/badge/License-GPL--3.0-555555)](LICENSE)

[GitHub 下载](https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest) · [OpenList 下载](https://pan.112589.xyz/本地文件/AdBlock-Pro) · [使用指南](docs/guide.md) · [参与共建](docs/shared-app-rules.md#社区贡献) · [问题反馈](https://github.com/Ccmra404/AdBlock-Pro-next/issues)

</div>

<p align="center">
  <a href="docs/assets/screenshots/overview.jpg"><img src="docs/assets/screenshots/overview.jpg" width="30%" alt="AdBlock Pro 总览界面"></a>
  <a href="docs/assets/screenshots/domain-observation.jpg"><img src="docs/assets/screenshots/domain-observation.jpg" width="30%" alt="AdBlock Pro 域名观察界面"></a>
  <a href="docs/assets/screenshots/shared-rules.jpg"><img src="docs/assets/screenshots/shared-rules.jpg" width="30%" alt="AdBlock Pro 共享规则界面"></a>
</p>

<p align="center"><sub>当前代码的本地演示界面；统计与观察数据仅为示例，不代表设备实测或拦截效果。</sub></p>

## 我们想做的事

遇到漏拦截或误拦截时，不必只靠不断更换规则碰运气。我们希望让用户能观察请求、理解线索，借助可选的 AI 分析辅助判断，再决定如何处理。

经过确认的规则可以留在自己的设备，也可以提交给共享规则库。让一个人的排查结果，帮助更多遇到同类问题的人。

## 我们坚持的原则

- **本地优先**：过滤和规则管理在设备上完成。向 AI 服务发送候选域名前，先由用户确认。
- **用户做主**：规则可以选择、调整和移除。AI 提供建议，不代替用户决定，也不自动发布规则。
- **共同完善**：共享候选先核对、再采用，保留审查、反馈和纠错的空间。

不以规则数量或“拦截一切”为目标，更关注日常使用是否可靠、问题能否排查、调整是否可控。

## 开始使用

从 [GitHub Releases](https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest) 或 [OpenList](https://pan.112589.xyz/本地文件/AdBlock-Pro) 下载完整 ARM64 模块 ZIP。安装条件、使用方法与过滤边界见[使用指南](docs/guide.md)；版本变化和验证范围以对应 Release 说明为准。

想帮助改进项目，可以[反馈问题](https://github.com/Ccmra404/AdBlock-Pro-next/issues)、[提交共享规则候选](docs/shared-app-rules.md#社区贡献)，或按[贡献指南](CONTRIBUTING.md)参与开发。

## 来源与许可

由 **Ccmra** 维护，采用 [GPL-3.0](LICENSE)。感谢 [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome)、[10007](https://github.com/lingeringsound/10007_auto) 和 [AWAvenue Ads Rule](https://github.com/TG-Twilight/AWAvenue-Ads-Rule) 等上游项目。各组件和规则遵循其上游许可，详见[第三方声明](THIRD_PARTY_NOTICES.md)。
