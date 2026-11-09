# 无人值守优化记录

本文件记录自动排查中确认的问题、处理结果和验证证据，后续每轮优化继续追加。条目使用 UTC 日期，并区分已合并、待评审和仍需真机验证的事项；不记录设备凭据、私人 DNS 配置或原始设备日志。

## 2026-11-08

### 基线

- 仓库：`Ccmra404/AdBlock-Pro-next`
- 检查时 `main`：`dfe849360785d50e31419b10aefad9686f1c312d`
- 最新正式版：AdBlock Pro v0.14.5，`versionCode=57`，于 2026-11-08 发布
- 当前内置核心：AdGuard Home v0.107.80；版本锁定文件中的压缩包 SHA-256 为 `d5e17d0d724418ddef8b7723ed8ade7eef4e621ec5b0e43a341859cca71a3d8f`

### 已确认问题：Android shell 的 epoch 比较溢出

自动规则更新和 Debug 观测报告过期判断将 epoch 秒直接传给 shell 整数 `test` 与算术表达式。超过有符号 32 位边界（2038 年）时，比较可能失败，算术也可能回绕。在本地 Debian `mksh` 下复现了 `3000000000` 比较及减法溢出；尚未在 Android 真机验证。

- 修复：`scripts/compat.sh` 增加有界十进制 `awk` 时间窗口比较；自动更新和 Debug 过期检查共用该函数，并保留未来时间戳（系统时钟回拨）的既有重试行为。
- 回归覆盖：2038 后的自动更新、时间窗口包含/严格边界、时钟回拨，以及失败重试行为。
- PR：[#84 fix(time): avoid epoch overflow in Android shell](https://github.com/Ccmra404/AdBlock-Pro-next/pull/84)，Draft，提交 `aa022de1da3edec6b4b98e2a2e0c0e535e4f9a57`。
- 本地验证：Node 623 项、Python 36 项、bootstrap 与 AI 两个 Go 模块通过；Debian `mksh` 下自动更新测试 19 项通过；Shell/JavaScript 语法及 `git diff --check` 通过。
- Actions：[代码检查](https://github.com/Ccmra404/AdBlock-Pro-next/actions/runs/42505408740)、[ARM64 测试 ZIP 构建及校验](https://github.com/Ccmra404/AdBlock-Pro-next/actions/runs/42505408780)均通过。测试 artifact：[AdBlock-Pro-test-42505408780-arm64](https://github.com/Ccmra404/AdBlock-Pro-next/actions/runs/42505408780/artifacts/13627451746)。正式发布步骤跳过。
- 未在 Android 真机验证。

### 已确认问题：核心升级后版本引用未同步

PR #73 已把内置 AdGuard Home 更新到 v0.107.80，但第三方组件声明、DNS API 文档链接、初始配置注释和升级器测试夹具仍记录 v0.107.79。同步当前引用和测试夹具；10 月安全审计文件保留当时的历史版本记录。此项不改运行逻辑、核心二进制或模块版本。

- PR：[#85 chore(upstream): sync AdGuard Home version references](https://github.com/Ccmra404/AdBlock-Pro-next/pull/85)，Draft，提交 `65be06d749683784aa10bbf60cc28bd85c56a98a`。
- 本地验证：Node 621 项、Python 36 项、bootstrap 与 AI 两个 Go 模块通过；Shell/JavaScript 语法及差异检查通过。
- Actions：[代码检查](https://github.com/Ccmra404/AdBlock-Pro-next/actions/runs/42506311973)、[ARM64 测试 ZIP 构建及校验](https://github.com/Ccmra404/AdBlock-Pro-next/actions/runs/42506311991)均通过。测试 artifact：[AdBlock-Pro-test-42506311991-arm64](https://github.com/Ccmra404/AdBlock-Pro-next/actions/runs/42506311991/artifacts/13628105169)。正式发布步骤跳过。
- 未执行真机测试；变更只涉及文档、注释与测试夹具。

### 体积检查

v0.14.5 正式 ARM64 ZIP 为 20,028,919 字节。包内 AdGuard Home 二进制为 34,209,952 字节，两个随包规则文件合计 387,826 字节。核心是主要体积来源；本轮没有改写上游二进制或压缩格式，也没有改变当前正式版包内容。

### 其他问题及处理

- Issue #56 的新装默认反查设置已由 PR #57 修复；当前新装关闭私网 PTR 解析和客户端 PTR 探测，升级仍保留用户原有 DNS 配置。
- Issue #24 跟踪的核心版本已由 PR #73 更新到 v0.107.80。上游更新本身已有独立 PR 和设备验收记录，因此没有重复触发更新。
- Issue #52 / PR #53 的 FlClash DNS 候选尚未通过手机验收；现有记录显示真机查询仍超时。未扩大 DNS 豁免或修改接管逻辑，等待具备条件的设备复验。

### 当前状态与后续记录

- 最新正式版仍为 v0.14.5；PR #84 和 #85 均为 Draft，尚未合并。
- 本轮未执行 Android 真机操作；PR 专用测试 artifact 不是正式 Release。
- 后续每轮在本文件新增日期条目，记录当时 `main` SHA、具体发现及证据、对应 PR/提交、自动化验证结果、真机状态和未解决事项。

## 2026-11-09

### Issue #24：AdGuard Home v0.107.80 源码可达性复核

当前官方稳定版仍为 v0.107.80，仓库锁定文件与内置 ARM64 核心一致。核心 build info 为 Go 1.27.3、Linux/ARM64、`CGO_ENABLED=0`，并设置 `DefaultGODEBUG=multipathtcp=0`；这与上游 v0.107.80 发布说明中禁用 MPTCP 的安全缓解相符。

使用官方 `govulncheck v1.9.0`（漏洞库更新时间 2026-11-05）分别扫描当前二进制及对应官方源码标签 `v0.107.80`。源码检查按 Linux/ARM64、CGO 关闭执行：

- 二进制扫描报告 `GO-2026-6237`（`github.com/insomniacslk/dhcp`）及 `GO-2026-5932`（`golang.org/x/crypto/openpgp`）两个符号级告警。
- 源码扫描对 `GO-2026-6237` 给出一条调用链：`/control/dhcp/find_active_dhcp` → `handleDHCPFindActiveServer` → `aghnet.CheckOtherDHCP` → DHCPv4 发现 → `BroadcastRawUDPConn.ReadFrom`。漏洞说明是恶意 IPv4 数据报长度不足以容纳 UDP 头时可能导致负 DHCP 长度并触发 panic；[漏洞记录](https://pkg.go.dev/vuln/GO-2026-6237)。
- 该路径由 AdGuard Home 的 DHCP 设置界面调用；本项目普通 DNS 启动和查询路径没有调用该检查。API 经过 AdGuard Home 认证中间件；首次安装 HTTP 管理地址绑定 `127.0.0.1:3000`，DHCP 服务默认关闭，但查找接口仍会注册。用户可更改网络绑定或主动使用 DHCP 设置，所以不能标成不可达或无风险。
- 源码扫描没有给 `GO-2026-5932` 显示可达调用链；扫描摘要仍报告一个未被代码调用的受影响模块。未将二进制中存在符号等同于可利用。
- 实际 Android 设备上的触发条件、panic 对单个 HTTP 请求或整个进程的影响均未测试。此次扫描是调用链证据，不是漏洞利用或真机安全验收。
- 修复版 `github.com/insomniacslk/dhcp` 已有上游模块版本，但 v0.107.80 仍依赖旧版本；当前没有更新的 AdGuard Home 官方稳定版。没有自编译或替换核心，继续等待官方稳定核心更新。

### 应用过滤重置路径复核

只读检查确认 `scripts/factory-reset.sh` 会创建空的 `app-exclusions.txt`；`tests/factory-reset.test.mjs` 覆盖恢复默认后清空名单。此路径未发现遗漏，不需要新增代码修改。

### 本轮状态

- `main` 仍为 `dfe849360785d50e31419b10aefad9686f1c312d`，正式版仍为 v0.14.5。
- 本轮安全复核和重置路径审查没有修改产品运行代码；Issue #24 仍需等待官方核心更新及后续设备评估。
- 无真机测试、PR 合并或 Release。
