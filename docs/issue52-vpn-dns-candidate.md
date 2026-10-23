# Issue #52：FlClash 共存修复候选与手机 Eta 验收交接

本候选基于 `main` 的 `95b82768d843e9a17f000a37e2a1d35818362290`，只修复 VPN 受保护出站 DNS 被再次接管的问题，不包含其他开放 PR 的新功能。正式版仍为 v0.13.5；本候选不自动合并或发布。

## 已确认与仍待确认的边界

[Issue #52](https://github.com/Ccmra404/AdBlock-Pro-next/issues/52) 的手机 A/B/A 证明：同一移动网络、FlClash 配置不变时，模块接管开关与解析失败存在可重复对应；VPN DNS 查询被模块送入 AGH，AGH 公共上游查询经 VPN 超时，而单次使用底层网络标记可以成功。本机 AGH 仍能回答已命中规则的请求，不能把进程/监听存活当作普通解析成功。

代码中另有一个确定的缺口：原重定向链仅豁免 AGH UID/GID，没有保留 Android `VpnService.protect()` 标记的出站套接字。[FlClash v0.9.1 源码](https://github.com/chen08209/FlClash/blob/8d4f9744948751f1273fe871e1d05276fac09b0e/core/lib.go) 的 socket hook 会调用 VPN protect。这些本应由代理向外发送的 DNS 连接仍可能再次进入 AGH；AGH 的无标记上游又进入 VPN，构成重入条件。

这不是已经证明手机上出现无限循环。Issue 尚未提供手机上该标记的实际命中证据；节点 UDP 策略、Clash 出站路由等也可能参与。候选修复是否消除本机超时、是否保持 Fake-IP 分流，必须由 Eta 真机验证。

## 最小修复

在现有 AGH 自身豁免之后、DNS 重定向之前加入：

```sh
-m mark --mark 0x20000/0xe0000 -j RETURN
```

[AOSP Fwmark](https://android.googlesource.com/platform/system/netd/+/refs/heads/main/include/Fwmark.h) 将 bit 17 定义为 `protectedFromVpn`，bit 18–19 定义为权限。该匹配要求 protect=1 且权限为 NONE，保留普通 VPN 应用的受保护出站路径。

不能使用单纯的 `0x20000/0x20000` 放行所有 protected 查询：[NetworkController::getNetworkForDnsLocked](https://android.googlesource.com/platform/system/netd/+/refs/heads/main/server/NetworkController.cpp) 为系统 DNS 也设置 protect 位和 SYSTEM 权限。过宽的豁免可能把普通应用的系统 DNS 一并放走。本候选继续接管这些系统 DNS，以及不带保护标记的普通请求。

- 不按整个 UID 或 VPN 地址段放行，不硬编码某个手机 UID，不豁免 `198.18.0.2`。
- 不改 AGH 上游、Clash 配置、节点、分流、私人 DNS、系统代理或网络标记。
- 不启用 IPv6；共用链构建函数中的保护匹配也适用于原本已明确启用的 IPv6 分支，但不代表新增或验证双栈能力。
- 不新增常驻检测和运行时依赖。内核不支持 mark 匹配时，撤销本次接管，保留 DNS 核心，不能带着半套规则继续宣称成功。
- 安装沿用现有偏好保留逻辑；手机当前的 `dns-takeover=off` 应继续保留。不得为了验收自动打开。

## 电脑端验证

1. 针对保护匹配与安装失败回退补回归；在原代码上先确认失败，再应用修复。
2. Linux CI 执行 `sudo -n python3 tests/issue52_netfilter.py`，通过 `unshare --net` 创建独立网络命名空间。两个本地 DNS stub 和真实 iptables/SO_MARK 验证旧规则截走 protected 出站、候选规则保留该路径，且系统 DNS、普通 DNS、现有 AGH 豁免继续正确。
3. 覆盖 UDP/TCP、显式选择网络、系统权限、无关厂商/计费标记、拦截域名；无数据包离开隔离空间。
4. 这是 Linux 内核规则验收，stub 不是手机 AGH，也没有模拟完整 Android VPN；不把它当作 FlClash 真机通过。

开发时只跑针对性检查；候选提交后做一次完整 CI 和 ARM64 安装包校验。

## 手机 Eta 验收

### 先保持现状

手机当前止损状态以 Issue #52 为准：接管 off、模块跳转 absent，AGH 和 Clash 保持运行。收到候选包不等于获得安装、重启、开启接管或切换网络授权。高风险步骤仍先取得用户明确授权，电脑端不连接 ADB 代替 Eta 执行。

### 获得授权后执行

1. 核对候选 SHA、模块 ZIP 和 SHA256；保留可用正式包，备份仅在手机私有目录，核验原配置和名单。
2. 安装并按管理器要求重启后，先确认接管仍为 off/absent，AGH 和 Clash 配置未变；不要上传私有配置内容。
3. 获得临时开启授权后，在同一移动网络及当前 FlClash 配置下复测 Issue 的 VPN DNS、非显式/显式代理 HTTPS 与正常应用。超时、断网或分流异常立即通过既有 `--takeover off` 撤销，并确认 absent。
4. 记录普通域名返回真实 IP 还是 Fake-IP，以及实际 HTTP 结果；解析成功不能单独证明分流正确。
5. 对同一普通应用路径检查已知拦截域名；记录 AGH `reason/rule` 和实际 DNS 响应。若只显式查询本地 AGH 能拦、普通路径绕过，则不能判定兼容修复通过。
6. 仅记录新增 mark RETURN 规则前后包计数差，不清零计数；无需上传全设备防火墙、完整连接跟踪或完整配置。普通 DNS 仍应命中重定向。无新增命中而恰好恢复联网，不足以确认本候选的因果解释。
7. 把“联网恢复”“正常路径仍过滤”“Fake-IP/分流正常”“偏好与数据保留”分别报告，区分已有手机证据与本候选新证据。

Wi-Fi/移动网络、Clash 开关、主动暂停、异常退出及重启保留可在修复方向验证后集中验收，不反复刷包或一次改变多个变量。

### 回传格式

候选 SHA；用户授权的具体步骤；网络/VPN条件；接管 off/on 的 DNS/HTTP 结果；保护规则包计数增量；正常路径过滤原因；Fake-IP 与分流结果；是否回滚到 off；配置哈希是否保持。不得把账号、令牌、节点地址或私人日志贴入公开 Issue。

验收结束默认恢复用户要求的 off/absent，除非用户另行明确授权保持开启。验收报告回到 #52；电脑端收到证据后再决定修订候选，不自动合并或发版。
