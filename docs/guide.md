# AdBlock Pro 使用指南

[返回项目主页](../README.md) · [下载安装包](https://github.com/Ccmra404/AdBlock-Pro-next/releases)

AdBlock Pro 在手机本地运行 [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome)，通过模块管理的 DNS 重定向、订阅规则和个人黑白名单，过滤广告及部分跟踪域名。项目提供适配手机与平板的 Root WebUI，让规则、开关、日志和诊断尽量集中在一个界面完成。

> [!IMPORTANT]
> **新仓库源码基线：`v0.13.0-rc.3`（versionCode 45）。** 旧仓库的 Release 资产不会自动迁移；新仓库当前没有可安装包。重新验收并发布 ARM64 ZIP 前，请勿将 GitHub 自动下载的 Source code ZIP 当成可安装模块。

**项目定位：** 优先兼顾国内 Android 应用的日常兼容性、可维护的过滤规则，以及异常情况下的 DNS 可用性。不追求“规则条数越多越好”，也不承诺拦截所有应用广告。

## 主要功能

| 功能 | 说明 |
| --- | --- |
| 本地 DNS 过滤 | 使用 AdGuard Home 作为 DNS 过滤核心，不依赖庞大的系统 `hosts` 文件 |
| 规则来源管理 | 一个列表管理内置源、共享规则和 HTTPS 自定义来源；支持启停、移除与重命名 |
| 个人黑白名单 | 将自定义拦截、放行域名与第三方订阅分开管理 |
| Root WebUI | 总览、规则管理、个人名单、运行设置、日志及诊断 |
| 更新与回滚 | 更新前保存规则快照，更新失败时尝试恢复上一套配置 |
| DNS 接管控制 | 可单独关闭 DNS 重定向，不必同时卸载模块 |
| 故障保护 | 检查 DNS 核心运行及监听状态；异常时尝试解除本模块的 DNS 接管 |
| 域名观察 | 短时间观察设备 DNS 请求，辅助判断漏拦截域名；需要人工确认 |

安装包内置 **10007** 和 **秋风 AdGuard 全规则**（广告、隐私与不受欢迎内容）快照，首次安装也会启用共享抓包规则。预置订阅只有这两个公开规则源；你可以在规则管理中自行导入、停用、移除、重命名或修改订阅链接。移除内置来源只会从当前订阅列表移除，之后仍可重新导入。

来源或名单变更后，请在「规则管理」执行更新，修改才会应用到 DNS 过滤核心。模块先通过系统 `curl` 下载并检查订阅，再让 AdGuard Home 读取本地缓存；下载或校验失败时会继续保留上一版有效规则。增加来源可能提高内存占用和误拦截风险，不等于一定提高拦截效果。

## 工作原理

```text
Android 应用 / 系统 DNS 请求
             │
             ▼
   本模块管理的 IPv4 DNS 重定向
             │
             ▼
    本地 AdGuard Home DNS 服务
             │
     ┌───────┴────────┐
     │                │
  订阅过滤规则     个人黑 / 白名单
     │                │
     └───────┬────────┘
             ▼
      放行解析 / 拦截域名
```

AdBlock Pro 的默认设计**只接管 IPv4 明文 DNS**，并不尝试强制覆盖 Android 私人 DNS、VPN、应用内 DoH/DoT 或所有 IPv6 查询。这些流量可能绕过模块过滤，属于目前明确的功能边界。

域名过滤无法直接删除应用已经渲染出来的广告占位、贴片组件，也无法自动点击「跳过广告」。需要处理开屏跳过时，可独立搭配 [GKD](https://github.com/gkd-kit/gkd)；**GKD 不是本模块的内置引擎**。

## 安装前须知

**必要条件：**

- Android **ARM64** 设备；
- 已正确安装并运行 KernelSU、Magisk 或 APatch，具备模块所需的 root 权限与模块运行环境；
- 管理器提供包含 `flock`、`setuidgid`、`inotifyd` 等命令的完整 BusyBox，ROM 或可信本地环境提供 curl 与 IPv4 iptables；
- 使用针对该项目制作的**完整安装 ZIP**，而不是 GitHub 自动生成的 Source code ZIP；
- 确保没有另一个启用中的 AdGuard Home 模块与本模块争用服务或 DNS 端口。

**为什么不能直接下载仓库 ZIP 安装？**

为了避免上传设备配置，仓库没有提交安装时需要的 `admin.auth` 和 `bin/AdGuardHome.yaml`。通过 `.github/workflows/release.yml` 构建完整 ARM64 安装包：首次安装默认账号为 `admin`，密码为 `password`，安装程序在**本机生成带随机盐的 bcrypt 哈希**，运行文件权限为 `0600`；已安装设备的账号和配置不会被覆盖。直接压缩仓库不会包括打包时编译的安装初始化工具，因此不可直接安装。

安装时通过对应 Root 管理器选择完整模块 ZIP，完成后按要求重启。KernelSU 与 APatch 可以从管理器打开模块 WebUI；Magisk 用户需使用兼容 `ksu.exec` 的 WebUI 宿主。本项目尚未针对所有机型与 Android 版本完成兼容性测试；先保留可恢复的旧版本或备份更稳妥。

### 管理器与工具兼容

模块统一寻找 KernelSU 的 `/data/adb/ksu/bin/busybox`、Magisk 的 `/data/adb/magisk/busybox` 或 APatch 的 `/data/adb/ap/bin/busybox`。安装时记录 Root 类型，普通 WebUI shell 没有管理器变量时也能选择相同的工具，避免迁移 Root 方案后误用残留目录。诊断输出包含 `diag_root_family` 与 `diag_busybox`。

curl 优先使用 `/system/bin/curl`，其次寻找可信本地运行目录或 PATH 中的 curl。缺少完整 BusyBox、curl 或 IPv4 iptables 时，安装在改写用户数据前停止。Toybox 不作为完整 BusyBox 的替代品。本模块不修改系统文件，DNS 模式不需要额外挂载元模块。

APatch 的 WebUI 按 [官方 FAQ](https://apatch.dev/faq.html#webui-of-apm-kpm) 兼容 KernelSU 接口。Magisk 本体不提供相同的内置 WebUI 入口，可以使用 [WebUI X](https://github.com/MMRLApp/WebUI-X-Portable) 等兼容宿主，授予所需 Root 权限后打开模块。普通浏览器无法执行模块的 Root 管理命令；原生 AdGuard Home 后台仅管理 DNS 核心。

模块管理器中的**操作**按钮会切换 DNS 核心启停，并非打开 WebUI 的按钮。KernelSU 衍生版只按标准模块和 WebUI 接口进行适配，不按项目名称保证所有版本均可用。

## 开机启动与网络就绪

模块开机自启时采用**有限等待、离线可用**的策略：

1. 等待 Android 报告启动完成（兼容未提供开机动画状态的 ROM，等待设有上限）。
2. 再缓冲 **8 秒**，降低系统服务密集初始化期间的启动冲突。
3. 检查 IPv4 或 IPv6 默认路由，最多等 **20 秒**。此操作**不请求公网地址，也不做 DNS 解析**；有路由不代表一定可以访问互联网。
4. 如果没有网络或检查超时，仍会尝试启动本地 AdGuard Home；只有 UDP/TCP DNS 监听准备好后才启用重定向。离线开机不会一直卡住。

高级用户可在运行设置文件 `/data/adb/adblockpro/settings.conf` 中调整：

```ini
boot_start_delay=8
boot_network_wait=20
```

数字单位为秒；设置成 `0` 可以关闭相应等待，分别最多允许 60 秒和 90 秒。修改后重启手机才会应用到开机启动流程；WebUI 里的手动启动操作不会额外等待这些时间。

## WebUI 使用指南

1. **总览**：查看 DNS 核心、重定向、规则条目、内存和查询统计。
2. **规则管理**：逐项导入、停用、移除或重命名规则来源，执行「立即检查并更新」，必要时从规则历史恢复。
3. **个人名单**：添加放行或拦截域名、搜索已有条目。保存名单后仍需执行规则更新。
4. **系统设置**：控制 DNS 接管、开机自启、自动更新，并进入原生 AdGuard Home 后台。
5. **运行日志**：查看模块任务结果、诊断信息；使用短时域名观察辅助排查漏拦截。

原生 AdGuard Home 管理界面在本机 **`http://127.0.0.1:3000/`**。它与 AdBlock Pro WebUI 是两个不同的管理界面：前者负责 DNS 引擎的高级功能，后者负责模块级来源、个人名单与维护操作。首次安装默认使用 `admin / password`；覆盖升级保留旧账号和密码。后台仅监听本机，若自行开放远程访问，请先修改默认密码。现有设备可用 root 终端通过 `cat /data/adb/adblockpro/admin.auth` 查看实际的 `账号:密码`，不要公开此文件或设备配置。

### 常用排查命令

以下命令需要在有 root 权限的终端中执行：

```sh
# 查询服务、过滤和 DNS 接管状态
su -c 'sh /data/adb/modules/bindhosts_personal/bindhosts.sh --status'

# 运行模块诊断
su -c 'sh /data/adb/modules/bindhosts_personal/bindhosts.sh --diagnose'

# 网络异常时，尝试撤销本模块的 DNS 接管
su -c 'sh /data/adb/modules/bindhosts_personal/bindhosts.sh --takeover off'
```

> [!WARNING]
> 修改 DNS 重定向、防火墙规则或 AdGuard Home 服务，可能暂时影响全机域名解析。遇到断网应优先撤销 DNS 接管，不要在网络异常时反复强制重启。私人 DNS、VPN、双栈/IPv6 网络等场景需要单独排查。

## 项目结构

```text
AdBlock-Pro/
├── module.prop            # KernelSU 模块元信息
├── customize.sh            # 安装及迁移逻辑
├── service.sh              # 开机启动和故障监控
├── bindhosts.sh            # DNS 操作、规则更新、回滚与诊断
├── webui-config.sh         # 来源和个人配置管理
├── webui-job.sh            # WebUI 后台任务与日志接口
├── webroot/                # WebUI HTML / CSS / JavaScript
├── scripts/
│   ├── tool.sh             # AdGuard Home 生命周期
│   └── iptables.sh         # DNS 重定向规则维护
├── bin/
│   ├── AdGuardHome         # ARM64 过滤核心
│   └── data/filters/       # 随包规则快照
├── tests/                  # WebUI、任务及防火墙模拟测试
└── .github/workflows/      # GitHub Actions 自动检查
```

运行时的个人设置保存在 `/data/adb/bindhosts_personal/`，AdGuard Home 相关文件保存在 `/data/adb/adblockpro/`。公开源码不预置设备个人黑白名单；安装后可通过 WebUI 添加和管理自己的域名。

## 开发状态与测试

| 项目 | 当前情况 |
| --- | --- |
| 预发布源码版本 | `v0.13.0-rc.3` · ARM64；仍需真机验收 |
| 历史代码记录 | 旧仓库 PR #1：WebUI 响应、DNS 故障恢复与回归测试 |
| 自动化验证 | JavaScript / Shell 语法检查，以及前端状态、模拟防火墙、任务与 DNS 监听测试 |
| 管理器适配验证 | KernelSU、Magisk、APatch 工具选择、名单操作、日志与任务的模拟回归测试 |
| 真机验证 | 早期版本曾在 realme GT5 Pro 上测试；**当前候选版及跨管理器适配尚未完成真机验证** |
| 发布状态 | 新仓库尚无 Release；后续 ARM64 ZIP 需按新仓库的 CI 与真机验收流程重新构建 |

后续优先工作是：测试不同 ROM 下的 DNS 启停和异常恢复、验证 Wi-Fi / 蜂窝数据及私人 DNS / VPN 场景、确认回滚安全性，并继续验证自动构建的安装包。在这些工作完成之前，不应将优化分支的代码视作已发布的稳定版本。

## 常见问题

**为什么开了过滤还是会看到广告？**

DNS 只能依据域名决策。与正常内容共用域名的广告、应用内 DoH/DoT、私人 DNS 或 VPN 流量，可能无法由本模块处理。先通过诊断确认 DNS 是否被模块接管，再谨慎调整规则。

**为什么换档后拦截效果没变化？**

来源选择只保存设置，必须再执行一次「规则更新」。如果更新失败，应查看运行日志，而不是假定新来源已经生效。

**是否需要装很多广告源？**

不需要。建议从安装包默认来源开始，遇到明确漏拦截后再单独导入来源。来源重叠、规则过多或误拦截，可能带来额外的内存和维护成本。

**它与 AdGuard Home 模块有什么区别？**

AdGuard Home 是底层 DNS 引擎；AdBlock Pro 在其上提供面向 KernelSU 的预设规则、个人名单、故障保护、WebUI 工作流和模块级维护。它不是另一个独立 DNS 引擎。

## 上游项目与声明

- [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome)：本地 DNS 过滤引擎。
- [10007](https://github.com/lingeringsound/10007_auto)：默认基础规则。
- [AWAvenue Ads Rule](https://github.com/TG-Twilight/AWAvenue-Ads-Rule)：内置 AdGuard 全规则来源，使用[广告、隐私、不受欢迎内容均拦截的订阅选项](https://awavenue.top/Sub.html?tool=adguard&privacy=block&unwelcome=block)。相关许可证副本见 [GPL-3.0 许可证副本](../licenses/AWAvenue-GPL-3.0.txt)。
- [KernelSU](https://github.com/tiann/KernelSU)：Android Root 与模块平台。
- [GKD](https://github.com/gkd-kit/gkd)：可独立搭配使用的应用界面规则工具。

第三方二进制、规则和其他组件分别受其上游许可证及使用条款约束；请勿默认仓库所有内容都具有相同的再分发授权。

**隐私提醒：** 本仓库包含设备使用者自行整理的个人名单文件。将仓库公开、Fork 或镜像前，应先逐项检查这些文件、配置和可能出现的凭据，避免泄露私人域名与账号信息。
