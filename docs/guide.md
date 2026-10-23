# AdBlock Pro 使用指南

[返回项目主页](../README.md) · [GitHub 下载](https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest) · [OpenList 下载](https://pan.112589.xyz/本地文件/AdBlock-Pro)

AdBlock Pro 在手机本地运行 [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome)，通过模块管理的 DNS 重定向、订阅规则和个人黑白名单，过滤广告及部分跟踪域名。项目提供适配手机与平板的 Root WebUI，让规则、开关、日志和诊断尽量集中在一个界面完成。

> [!IMPORTANT]
> 从 [最新稳定版](https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest) 下载完整 ARM64 模块 ZIP。GitHub 自动生成的 `Source code` 压缩包不是可安装模块；兼容性与验证范围以对应版本说明为准。

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
| 可选 VPN/TUN 兼容 | 开启后检测到 TUN/WireGuard 接口时自动旁路本模块的 DNS 接管 |
| 故障保护 | 检查 DNS 核心运行及监听状态；异常时尝试解除本模块的 DNS 接管 |
| 域名观察与 AI 分析 | 观察设备 DNS 请求；AI 可分析用户选中的域名，结果需人工确认 |

安装包内置 **10007** 和 **秋风 AdGuard 全规则**（广告、隐私与不受欢迎内容）快照，首次安装也会启用共享抓包规则。默认启用的公开订阅仍为这两个；你可以在规则管理中自行导入、停用、移除、重命名或修改订阅链接。移除内置来源只会从当前订阅列表移除，之后仍可重新导入。

规则目录还提供默认不启用的 **GOODBYEADS DNS（含配套放行）**，按需导入后才下载。它与秋风等上游有重叠，不建议为增加条数而全部叠加。配套放行、优先级和更新失败处理见[可选规则与参考项目改进方案](reference-improvements.md)。

规则来源变更后，在「规则管理」执行更新。个人名单编辑、导入或 AI 导入会单独应用，不重新下载订阅，也不重启 DNS。订阅下载和校验失败时会保留上一版有效规则。增加来源可能提高内存占用和误拦截风险，不等于一定提高拦截效果。

### 每日自动更新

启用后，模块按每日周期下载已启用的规则来源；包含共享来源时也会尝试同步公共快照。失败后间隔重试，保留可用规则。关闭开机自启、停止核心或禁用模块时，不会为了更新而自动启动核心。

### 核心异常恢复

DNS 核心意外退出后，守护会先尝试解除本模块的 DNS 重定向；确认清理成功后，再按至少 **30、60、120 秒**的间隔尝试恢复，最多三次。启动仍会检查 UDP/TCP 监听，准备好后才恢复接管；后台维护正在运行或防火墙状态未知时不会强行启动。

主动暂停、禁用或待卸载的模块不会被自动拉起。连续异常达到上限后，运行日志会提示检查原因并手动恢复；手动启动或连续稳定运行五分钟会重置本轮次数。关闭 DNS 接管但保留核心运行时，恢复也保持接管关闭。此功能不会切换网络、修改上游 DNS、打开 IPv6 接管或调整代理应用。

### 域名观察与 AI

域名观察位于「名单」页顶部，记录观察窗口内经过 AdGuard Home 的请求，不限于此前没出现过的域名。结果可能包含后台应用流量，不能仅凭一次记录认定归属或广告性质。详细流程见[共享规则与短时观察](shared-app-rules.md)；可选接口和发送范围见[AI 域名分析](ai-domain-analysis.md)。

### DNS 上游管理

设置中的「DNS 上游设置」可读取当前配置、填入国内普通 DNS 或 DoH 草稿、测试并保存、恢复上次配置。预设不会自动应用；现有高级配置保持只读。流程、恢复边界和验证范围见 [DNS 上游说明](dns-upstreams.md)。

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

「系统设置 → VPN/TUN 自动兼容」是可选开关，默认关闭。开启后，模块每 5 秒检查 `/sys/class/net`：看到 `tun*` 或 `wg*` 接口时，会暂停本模块的 DNS 接管规则，AdGuard Home 核心继续运行；接口状态无法读取时也会暂时旁路。VPN 接口连续约 15 秒不可见，且 DNS 核心与 TCP/UDP 监听正常时，模块才按用户保存的 DNS 接管偏好恢复规则。用户手动关闭 DNS 接管后，自动恢复不会覆盖该选择。

此模式会旁路**整台设备的模块 DNS 接管**，即使 VPN 只代理部分应用也是如此；由 VPN 自己处理的 DNS 仍取决于 VPN 客户端。若已启用模块的 IPv6 DNS 接管或阻断，暂停时相应规则也会移除，恢复时再按原配置重建。它按接口是否存在判断 VPN，不探测接口是否仍有流量；若客户端断开后保留 TUN/WireGuard 接口，模块会继续旁路，直到接口消失或用户关闭兼容开关。关闭兼容开关会立即按 DNS 接管开关恢复规则，即使 VPN 还连接着，因此仅应在确认此行为符合预期时关闭。此开关无法检测所有厂商自定义 VPN；私人 DNS 和应用内 DoH/DoT 仍可能绕过模块。可在设置页和诊断输出中查看兼容开关及暂停状态。

与 FlClash 同时使用时，VPN 和额外的系统 HTTP 代理可能采用不同的解析路径。已验证用法、恢复步骤与未覆盖范围见 [FlClash VPN 共存排查](vpn-compatibility.md)。

域名过滤无法直接删除应用已经渲染出来的广告占位、贴片组件，也无法自动点击「跳过广告」。需要处理开屏跳过时，可独立搭配 [GKD](https://github.com/gkd-kit/gkd)；**GKD 不是本模块的内置引擎**。

## 安装前须知

**必要条件：**

- Android **ARM64** 设备；
- 已正确安装并运行 KernelSU、Magisk 或 APatch，具备模块所需的 root 权限与模块运行环境；
- 管理器提供包含 `flock`、`setuidgid`、`inotifyd` 等命令的完整 BusyBox，以及 IPv4 `iptables`；安装包自带 ARM64 `curl` 和 CA 证书；
- 使用针对该项目制作的**完整安装 ZIP**，而不是 GitHub 自动生成的 Source code ZIP；
- 确保没有另一个启用中的 AdGuard Home 模块与本模块争用服务或 DNS 端口。

**为什么不能直接下载仓库 ZIP 安装？**

为了避免上传设备配置，仓库没有提交安装时需要的 `admin.auth` 和 `bin/AdGuardHome.yaml`。通过 `.github/workflows/release.yml` 构建完整 ARM64 安装包：首次安装默认账号为 `admin`，密码为 `password`，安装程序在**本机生成带随机盐的 bcrypt 哈希**，运行文件权限为 `0600`；已安装设备的账号和配置不会被覆盖。直接压缩仓库不会包括打包时编译的安装初始化工具，因此不可直接安装。

安装时通过对应 Root 管理器选择完整模块 ZIP，完成后按要求重启。KernelSU 与 APatch 可以从管理器打开模块 WebUI；Magisk 用户需使用兼容 `ksu.exec` 的 WebUI 宿主。本项目尚未针对所有机型与 Android 版本完成兼容性测试；先保留可恢复的旧版本或备份更稳妥。

### 管理器与工具兼容

模块统一寻找 KernelSU 的 `/data/adb/ksu/bin/busybox`、Magisk 的 `/data/adb/magisk/busybox` 或 APatch 的 `/data/adb/ap/bin/busybox`。安装时记录 Root 类型，普通 WebUI shell 没有管理器变量时也能选择相同的工具，避免迁移 Root 方案后误用残留目录。诊断输出包含 `diag_root_family` 与 `diag_busybox`。

模块优先使用安装包自带的 ARM64 `curl` 和 CA 证书。安装前会检查完整 BusyBox 与 IPv4 `iptables`；缺少依赖时会停止安装。本模块不修改系统文件，DNS 模式不需要额外挂载元模块。

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
3. **个人名单**：添加、删除或导入放行与拦截域名。模块会单独应用个人名单，不下载其他订阅，也不重启 DNS。
4. **系统设置**：控制 DNS 接管、开机自启和每日自动更新，配置可选 AI 接口，并进入原生 AdGuard Home 后台。
5. **运行日志**：查看、搜索、复制或导出操作记录和诊断信息；域名观察位于「名单」页顶部。

原生 AdGuard Home 管理界面在本机 **`http://127.0.0.1:3000/`**。它与 AdBlock Pro WebUI 是两个不同的管理界面：前者负责 DNS 引擎的高级功能，后者负责模块级来源、个人名单与维护操作。首次安装默认使用 `admin / password`；覆盖升级保留旧账号和密码。后台仅监听本机，若自行开放远程访问，请先修改默认密码。现有设备可用 root 终端通过 `cat /data/adb/adblockpro/admin.auth` 查看实际的 `账号:密码`，不要公开此文件或设备配置。

### 导出与恢复默认设置

个人名单、观察结果和操作日志等导出文件统一保存到 `Download/AdBlock Pro`。

「设置 → 恢复默认设置」会清除自定义订阅、个人名单、AI 配置、账号设置和历史，恢复当前安装包的默认状态。普通升级无需执行此操作。执行前会导出个人名单及基础偏好；含账号和密钥的完整恢复备份仅保存在 `/data/adb/adblockpro/backups/`，不能把它当作可公开分享的规则备份。

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
环境诊断会分别报告 IPv6 配置、实际跳转、表是否可读取，以及私人 DNS、全局 HTTP 代理和系统当前 VPN 网络记录。查询失败保留未知状态；详细含义及边界见[网络诊断说明](network-diagnostics.md)。

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
│   ├── vpn-compat.sh       # 可选 VPN/TUN 自动旁路与恢复
│   └── iptables.sh         # DNS 重定向规则维护
├── bin/
│   ├── AdGuardHome         # ARM64 过滤核心
│   └── data/filters/       # 随包规则快照
├── tests/                  # WebUI、任务及防火墙模拟测试
└── .github/workflows/      # GitHub Actions 自动检查
```

运行时的个人设置保存在 `/data/adb/bindhosts_personal/`，AdGuard Home 相关文件保存在 `/data/adb/adblockpro/`。公开源码不预置设备个人黑白名单；安装后可通过 WebUI 添加和管理自己的域名。

## 版本与验证

版本号、更新日志和下载文件以 [最新稳定版](https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest) 为准。自动化检查和设备验证范围以该版本的 Release 说明为准；CI 通过不代表所有 Root 管理器和设备都已实测。

## 常见问题

**为什么开了过滤还是会看到广告？**

DNS 只能依据域名决策。与正常内容共用域名的广告、应用内 DoH/DoT、私人 DNS 或 VPN 流量，可能无法由本模块处理。先通过诊断确认 DNS 是否被模块接管，再谨慎调整规则。

**为什么更换规则来源后效果没变化？**

来源选择只保存设置，必须再执行一次「规则更新」。个人名单则会单独应用。如果规则更新失败，应查看运行日志，而不是假定新来源已经生效。

**是否需要装很多广告源？**

不需要。建议从安装包默认来源开始，遇到明确漏拦截后再单独导入来源。来源重叠、规则过多或误拦截，可能带来额外的内存和维护成本。

**它与 AdGuard Home 模块有什么区别？**

AdGuard Home 是底层 DNS 引擎；AdBlock Pro 在其上提供面向 Android Root 模块环境的规则管理、个人名单、故障保护、WebUI 工作流和模块级维护。它不是另一个独立 DNS 引擎。

## 上游项目与声明

- [AdGuard Home](https://github.com/AdguardTeam/AdGuardHome)：本地 DNS 过滤引擎。
- [10007](https://github.com/lingeringsound/10007_auto)：默认基础规则。
- [AWAvenue Ads Rule](https://github.com/TG-Twilight/AWAvenue-Ads-Rule)：内置 AdGuard 全规则来源，使用[广告、隐私、不受欢迎内容均拦截的订阅选项](https://awavenue.top/Sub.html?tool=adguard&privacy=block&unwelcome=block)。相关许可证副本见 [GPL-3.0 许可证副本](../licenses/AWAvenue-GPL-3.0.txt)。
- [KernelSU](https://github.com/tiann/KernelSU)：Android Root 与模块平台。
- [GKD](https://github.com/gkd-kit/gkd)：可独立搭配使用的应用界面规则工具。

第三方二进制、规则和其他组件分别受其上游许可证及使用条款约束；请勿默认仓库所有内容都具有相同的再分发授权。

**隐私提醒：** 本机个人名单、账号、AI 密钥和查询记录不属于公共共享规则。反馈问题前检查日志内容，不要公开设备配置和认证文件。
