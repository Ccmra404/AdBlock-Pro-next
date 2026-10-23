# 可选规则与参考项目改进方案

参考 [AdGuard Home For Android](https://github.com/liuzq2002/Adguard-Home-For-Magisk-Mod) 的规则维护与网络诊断思路，分三步推进。每步独立评审，保留现有官方核心、默认规则、用户名单及 IPv6 默认关闭策略。正式发布另行确认。

## 第一步：可选 GOODBYEADS 订阅

在「规则管理」导入 **GOODBYEADS DNS（含配套放行）** 后执行规则更新。它默认不启用，不会在覆盖安装时替换已有订阅。停用或移除后，再执行更新即可撤下这组规则；需要恢复时可导入下面的 DNS 地址。

| 文件 | 首选地址 | HTTPS 备用地址 |
| --- | --- | --- |
| DNS 拦截 | <https://ghfast.top/raw.githubusercontent.com/8680/GOODBYEADS/master/data/rules/dns.txt> | <https://raw.githubusercontent.com/8680/GOODBYEADS/master/data/rules/dns.txt> |
| 配套放行 | <https://ghfast.top/raw.githubusercontent.com/8680/GOODBYEADS/master/data/rules/allow.txt> | <https://raw.githubusercontent.com/8680/GOODBYEADS/master/data/rules/allow.txt> |

两个入口来自 [GOODBYEADS 项目](https://github.com/8680/GOODBYEADS)。保留 TLS 证书校验；入口可用性仍需在用户的国内网络确认。将内置地址改成其他自定义链接后，按普通订阅处理，不推断第三方的配套地址；上述两个 DNS 地址均会加载对应的放行文件。

### 放行与更新边界

- 下载 DNS 和放行两份文件后，才合并为一个本地过滤器交给 AdGuard Home。停用、移除和历史回滚沿用已有流程，一起处理拦截与放行。
- 放行文件必须包含 DNS 例外，非注释项必须以 `@@` 开头。任一文件下载失败或放行格式异常，会在改动正在运行的订阅前终止，保留上一份可用规则。
- 原样保留放行规则及其修饰符。浏览器用途的规则不会通过删除修饰符转换成全域放行；是否支持由官方 DNS 引擎判定。这不是浏览器广告过滤功能。
- 配套例外可能放行其他普通订阅或个人拦截所命中的域名。`$important` 拦截优先于普通例外；本功能不更改个人规则的优先级。用「域名检查」查看实际 `reason` 和命中规则，不能只看 NXDOMAIN 或规则条数。
- GOODBYEADS 已聚合秋风等来源，重叠不代表效果提升。没有随包加入该项目的大型快照，也没有复制参考模块的大量自定义 `$important` 规则。

验收覆盖：默认未启用、保留已有选择、两文件成对更新、分别回退镜像、放行失败保留旧过滤器、停用移除、原生 ARM64 核心的例外和优先级。国内网络下载及真实应用误拦截需单独验收，CI 不代替真机。

## 第二步：VPN 与 IPv6 诊断

先展示实际监听、IPv4 与 IPv6 接管、Android 私人 DNS、VPN 和代理 DNS 路径，明确区分「未启用」「内核不支持」与「查询失败」。用普通 Wi-Fi、移动网络及 VPN 开关前后对照验证。优先解决可定位的冲突，不自动重写第三方代理配置。

国内加密 DNS 与备用上游作为可选方案评估：比较解析耗时、证书、不可达时的恢复和暂停行为。不能只凭换配置后可用，就把原因归于某个 DNS 模式。

## 第三步：单独评估 SNI 实验

参考其 NFQUEUE 与 TLS ClientHello 域名过滤，先确认内核能力、CPU 与功耗、失败放行、退出清理及 VPN 共存。ECH、QUIC、加密隧道和广告与正文共用域名仍有边界。通过评估前不替换官方核心，不进入默认过滤链。

不引入参考模块的持续关闭私人 DNS、清空应用数据、自动改代理配置、切飞行模式、全局阻断 IPv6 DNS 或 UDP 443、删除其他模块等行为。
