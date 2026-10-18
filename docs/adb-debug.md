# AdBlock Pro Debug 版

Debug 版在观察完成后会把本轮域名摘要保存在设备本地 24 小时，方便电脑通过 ADB 一次性读取，不再逐屏截图。

Debug ZIP 作为单独附件加入对应的 GitHub Release，文件名带 `-debug`；OpenList 是否同步由现有镜像流程决定。它不会进入正式版更新清单。

摘要只包含模块/核心运行状态、观察窗口内域名及请求次数、最近时间、AdGuard Home 返回的拦截原因和过滤器 ID，并标明记录是否达到查询上限。最多输出 200 个域名，同时报告总数和导出数。它不包含原始 DNS 查询记录、客户端 IP、应用名称、账号或 AI 密钥，也不会上传到网络。普通正式版不会保存这份摘要。

手机连接电脑并授权 USB 调试后，在电脑终端运行：

```powershell
adb shell su -c "sh /data/adb/modules/bindhosts_personal/scripts/adb-debug.sh collect"
```

观察完成且页面读取结果后，命令会直接输出汇总报告。请把终端输出发来即可。报告 24 小时后自动过期；再次观察会替换上一份摘要。

正式版和 Debug 版使用相同模块 ID、版本代码及用户数据目录。Debug 版只增加本机诊断能力；不同 Root 管理器对相同版本代码覆盖安装的处理仍待真机确认。Debug 预发布不会被根管理器的正式更新清单选中。
