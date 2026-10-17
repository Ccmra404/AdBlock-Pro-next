# HTTPS 根证书

模块自带 curl 使用 OpenSSL，不能依赖 Android 旧式哈希命名的系统证书目录。安装时将此 PEM 证书包放到 `/data/adb/adblockpro/certs/cacert.pem`，作为 curl 编译时指定的默认 CA 文件。共享规则同步和订阅下载均保留证书及主机名校验。

- 来源：[curl 官方 Mozilla CA Extract](https://curl.se/docs/caextract.html)
- 固定快照：https://curl.se/ca/cacert-2026-09-25.pem
- SHA-256：`a41b5d356aea97a529fe27e0f7316d2f9d946d75927476cf9cf1b90637d00505`
- 许可证：MPL-2.0，见 `licenses/cacert-MPL-2.0.txt`

更新此文件时，从上述官方来源下载新快照，核对官方 SHA-256，同时更新本说明和 `tools/validate_module_zip.py` 中的固定校验值，通过测试和 PR 审核后随模块升级分发。设备不会自动下载或信任额外的根证书。
