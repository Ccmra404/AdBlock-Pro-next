# Go 辅助工具证书验证补丁

2026-10-22 的 [ARM64 构建](https://github.com/Ccmra404/AdBlock-Pro-next/actions/runs/39726975304)在 `govulncheck` 阶段被阻止：AI 辅助工具使用的 Go 1.27.2 标准库命中 [GO-2026-6809](https://pkg.go.dev/vuln/GO-2026-6809)，报告包含通往 `crypto/x509.Certificate.Verify` 的调用链。

[Go 官方](https://go.dev/doc/devel/release#go1.27.3)于 2026-10-19 发布 Go 1.27.3，补充对不再可信的中间证书的拒绝处理。本补丁把打包及上游更新校验工作流固定到该版本，重新构建模块自有的凭据生成器和 AI 辅助工具。保留源代码扫描与未裁剪 ARM64 二进制扫描，发现问题仍阻止打包。

这次修改不替换预编译的 AdGuard Home，也不修复或重新评估其全部依赖。该核心的安全跟进仍见 [Issue #24](https://github.com/Ccmra404/AdBlock-Pro-next/issues/24)。没有更改用户凭据、规则、Go 模块依赖或模块版本号；已有 Release 不会被覆盖，修复后的安装包需单独发布。
