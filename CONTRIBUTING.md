# 贡献指南 / CONTRIBUTING

所有提交者与本地 AI 会话先阅读仓库根目录的 [AGENTS.md](AGENTS.md)。本文提供可执行的操作清单；目标是**保证主分支稳定、发布可追溯、不同会话不互相覆盖**。

## 从最新远端开始

```bash
git fetch origin --prune
git status --short
git log -1 --oneline origin/main
gh pr list --repo Ccmra404/AdBlock-Pro-next --state open
gh release list --repo Ccmra404/AdBlock-Pro-next --limit 5
```

有未提交的本地修改先保存或建立自己的工作树；不要直接强制清理他人的文件。

从最新 `main` 为一个独立任务建立分支：

```bash
git switch -c fix/dns-example origin/main
```

**分支命名**：`fix/<scope>-<topic>`、`feat/<scope>-<topic>`、`perf/<scope>-<topic>`、`ci/<topic>`、`docs/<topic>`、`chore/<topic>`。禁止多个独立任务复用同一个长期分支，并避免把旧 PR 当作当前 main。

## 提交格式

使用 Conventional Commits：

- `fix(dns): avoid stale redirect after resolver crash`
- `fix(root): use selected BusyBox in worker`
- `perf(webui): avoid repeated shell status requests`
- `test(firewall): cover missing IPv6 backend`
- `ci(release): block mutable release assets`
- `docs: clarify root manager requirements`

每个提交处理一个明确主题。**不要把发布版号变更与未经测试的功能堆在一起**。涉及行为改变时，同 PR 补相应回归测试和文档。

## 每次提交前

```bash
for file in action.sh bindhosts.sh customize.sh service.sh uninstall.sh webui-config.sh webui-job.sh scripts/*.sh; do bash -n "$file"; done
node --input-type=module --check < webroot/app.js
node --input-type=module --check < webroot/kernelsu.js
node --test tests/*.test.mjs
(cd tools/bootstrap && go test ./...)
git diff --check
```

CI 是准入条件，但**不能代替真机验收**。更改 DNS 接管/启动/卸载时要加失败回退测试；更改跨 Root 兼容层时需要覆盖 KernelSU、Magisk、APatch；更改打包流程时应验证 ARM64 安装 ZIP、凭据排除和 SHA256。

如果本地工具缺失，应在 PR 明确写出没跑的项目，让 GitHub Actions 进行对应检查，不能宣称“全部通过”。

## Pull Request 门禁

1. 分支推送后开 **Draft PR → main**；在 PR 模板填写动机、影响文件、用户数据/联网风险、测试 run 链接和真机状态。
2. 比较与**当前** `main` 的差异，确认未把别人的 PR/过期版本一起带入。PR 因其他会话的提交而过期时先同步 `main` 并重测。
3. 等目标 commit 的代码检查及 ARM64 安装包构建均成功后，才申请人工审核。
4. **用户明确确认后**才能合并；涉及 Root、DNS、安装、升级、卸载等关键路径的 PR，在合并或发布前优先进行真实设备验证。
5. 发布前再次核对发布的 tag / SHA / `module.prop` / `versionCode`，避免将旧 PR 的绿灯用到新代码。

## 版本发布

- **正常 PR push 只生成测试包**，不得自动向 Releases 上传资产。用于安装的 ZIP 与 GitHub 自动生成的 `Source code.zip` 不同。
- **正式 Release 只允许用户授权的主分支手动 Actions 触发**；同一 tag 永远不覆盖。需要修复旧版本时 bump `version` 与 `versionCode`，创建新的 tag。
- 发布说明应写明所含 PR、功能变化、已验证 Root/ROM/设备、仍未真机验证的项目和回退方式。
- 不主动更改 **IPv6 DNS 默认关闭、IPv4 接管、均衡规则、用户私有配置保留** 这些已确定的行为。
- 如果当前工作流仍允许 push 发布或覆盖资产，必须优先合并修复该问题的 PR，而不是绕过门禁发布。

## 其他本地会话如何接手

请它先执行本页“从最新远端开始”的检查，然后**仅接管一个指明的 PR 或创建自己的新分支**。要求报告以下四项：`main` SHA、工作分支/PR、最新 CI run、真机状态。没有这些证据的“已修复／已发布／已验证”都不能视为完成。

若 GitHub 账户及仓库计划支持，可在 Settings → Branches / Rulesets 中为 `main` 启用：**Require a pull request**、**Require status checks**、禁止直接 push/force push。**新仓库目前为公开仓库，但是否已启用 Rulesets 必须在 GitHub Settings 中实际核验**；文档及 CI 也不能阻止管理员手动绕过。提交 `AGENTS.md` 只建立协作约定，不会自动更改 GitHub 服务器端设置。
