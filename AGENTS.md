# AGENTS.md — AdBlock Pro 协作与提交规则

适用范围：整个仓库。面向 Codex、ChatGPT、本地 AI 编程会话及人类贡献者。开始写代码前必须阅读本文件及 [CONTRIBUTING.md](CONTRIBUTING.md)。本文件规定提交**流程**，不能替代真实测试。

## 1. 唯一事实来源与多会话协作

- **GitHub 远端仓库是代码事实来源**：每次工作前读取 `origin/main` 的最新 SHA、`module.prop`、现有 PR、最新构建状态及对应变更。不能根据旧聊天、旧截图、旧本地工作树声称代码已合并或已发布。
- 开始任何改动前执行或等效检查：`git fetch origin --prune`、`git status --short`、`git log -1 --oneline origin/main`、`gh pr list --state open`。**不得直接在 `main` 上开发或推送**。
- 一个主题一个分支一个 PR：`fix/<scope>-<topic>`、`feat/<scope>-<topic>`、`perf/<scope>-<topic>`、`docs/<topic>`、`chore/<topic>`。相互独立的修复分别开 PR；需要依赖另一 PR 时明确说明 base 及依赖。
- 修改前检查是否已有其他会话正在修改相同文件或维护同一 PR；**不要直接覆盖别人的分支、重置别人未完成的工作、擅自 force-push、改写历史或绕过 PR**。冲突时先比较差异并说明解决策略。
- **PR 未合并 ≠ 功能已进入 `main`，Actions artifact ≠ GitHub Release，CI 通过 ≠ 真机通过。** 汇报时必须区分这些状态。
- 同一个缺陷由其他会话修复后，先检查当前远端是否已包含修复，避免重复提交。

## 2. 安全与兼容边界（不得静默改变）

- 产品使用 **AdGuard Home ARM64** 做本地 DNS 过滤；当前策略为**默认仅接管 IPv4 明文 TCP/UDP 53**。IPv6 网络不阻断，IPv6 DNS 重定向默认关闭。**没有明确产品决策及兼容测试，不得擅自打开 IPv6 重定向、阻断 IPv6、切换 DNS 架构或更改默认规则档位。**
- Root 环境包含 **KernelSU、Magisk、APatch** 和其标准接口衍生版。优先按能力发现 BusyBox/接口，避免将 `/data/adb/ksu` 路径写死在通用业务代码中。各环境的安装、启动、日志、名单、WebUI 后台任务必须保持功能一致；Magisk WebUI 依赖兼容宿主，不代表后端必须依赖 WebUI。
- **DNS 接管必须 fail-open**：在监听 UDP/TCP 和服务实际就绪前不得安装重定向；服务异常、卸载、禁用或防火墙清理失败时应尽量避免系统 DNS 被指向不可用的解析器。卸载不得在残留本模块 DNS 跳转且无法安全恢复时无条件删除运行文件。
- 用户数据需要保留：`/data/adb/adblockpro` 内既有 AGH 配置和 API 密钥、`/data/adb/bindhosts_personal` 中名单、订阅预设、历史及偏好，不得因升级、Root 适配或清理脚本静默清空。**不要上传真实 `admin.auth`、`AdGuardHome.yaml`、设备日志中的秘密**；发布 ZIP 不能包含设备私有凭据。
- 不能用未验证的“大改重构”取代稳定的启停链；优先小而可回滚的补丁，并为失败分支补测试。

## 3. 必须遵守的开发—审查—构建流程

1. **确认基线**：记录 `main` SHA、相关 PR 和现有 Release。判断修复属于哪个分支，避免旧 PR 与新 `main` 混用。
2. **最小化修改**：清楚说明要修复的真实故障和预期行为；避免顺手改变规则源、IPv6 策略、WebUI 风格、版本号或其他不相关的功能。
3. **添加回归测试**：对 Shell、Go、WebUI、GitHub Actions 的关键故障均补最少一个失败/成功场景。对防火墙、升级、Root 路径等设计**负面用例和可恢复性测试**；不可用的工具用模拟注入，不要求 CI 真 Root。
4. **运行验证**：至少检查 `bash -n`、`node --test tests/*.test.mjs`、Go 测试（若改 Go/安装构建），以及 GitHub Actions 对目标提交生成的 ARM64 测试 ZIP。不能拿旧 commit 的绿色检查作为新 commit 的验证。
5. **提交与 PR**：使用 Conventional Commits（如 `fix(dns): ...`、`test(root): ...`、`ci(release): ...`），提交不包含密码、密钥或生成的本地配置。PR 按仓库模板填写影响范围、测试证据、风险、回退方式、真机状态。
6. **等待确认**：除非用户明确授权合并或发布，否则保持 PR 为 Draft；不要自动合并到 `main`，不要默默创建 GitHub Release。功能已在自己的分支验证 ≠ 获得发布授权。

## 4. 版本、构建与发布不可变性

- 模块版本以 **`module.prop` 中的 `version` 和 `versionCode`** 为准。准备新的发布版本时同步检查构建工作流、更新说明；版本号应与升级路径一致，`versionCode` 递增。
- PR 与开发分支只允许生成标有 `-dev.<sha>` 或等效明显标记的**测试 artifact**；绝不把未经人工确认的预览包发布到官方 Releases，也不要让测试包覆盖正式版本。
- **只有明确的主分支手动 `workflow_dispatch` 可以创建 GitHub Release**。严禁 push 自动发布；同一个 tag 与资产不可覆盖（不能用 `--clobber`、删除重建或直接替换旧版）。要修复已发布版本，必须提高版本号并发布新 tag。
- Release 前确保相关 PR 已合并且必要验证对应**将要发布的确切 SHA**；CI 包含 APK/ZIP 结构、SHA256、ARM64 架构、凭据排除、安装器和基础配置的检查。
- **真机验收必须用户实际执行并反馈**：至少覆盖安装升级、重启后 DNS、Wi‑Fi/移动网络、暂停恢复、规则管理、日志/诊断；宣称兼容 Magisk/APatch 须分别有对应真机证据。不能声称 AI 或云 CI 已完成真机刷机。
- 发布完成后提供 tag、具体提交 SHA、可安装 ZIP 和测试结论；明确“未测试项目”，并保留上一可用版本以便回滚。

## 5. 特别说明：工作流与 GitHub 设置

- **文档规则不会自动限制 GitHub API 操作。** 如 GitHub 计划允许，仓库管理员可在 Settings 为 `main` 配置 PR 与状态检查保护、限制直接 push/force push。**当前新仓库为公开仓库，但服务器端分支保护仍需在 GitHub Settings 中实际核验；不能因为仓库公开就假定保护已启用。** 若尚未启用，应严格执行人工 PR 流程和 CI 证据核对。
- 修改 `.github/workflows/release.yml` 时尤其检查：发布条件、测试 ZIP 与正式 ZIP 隔离、不能覆盖已有 Release、所有打包文件变动会触发 PR 测试。
- 如果当前 `main` 工作流尚未符合上述门禁，**先修复工作流并通过 PR 合并，再做下一次发布**。不允许因为“以前一直这样”就跳过规则。
- 与其他会话交接时，每次提供：`main` SHA、当前工作分支和 PR、最新测试 run、未合并改动、仍待真机验证事项。不得只报告“已经完成”。

本文件为协作约束，修改本文件本身也应通过独立 PR 审核，不应将它与不相关的功能开发混在同一个提交。
