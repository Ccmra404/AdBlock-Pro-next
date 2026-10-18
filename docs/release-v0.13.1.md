# AdBlock Pro v0.13.1

This maintenance release bundles an Android ARM64 `curl` binary so installation and rule downloads do not depend on a device-provided `curl`. The binary is built from pinned upstream curl and OpenSSL sources, and both license texts are included in the module.

The module still relies on the BusyBox supplied by the Root manager and the device's IPv4 `iptables` support. Existing DNS settings, credentials, rules, and IPv6 defaults are preserved.

Automated validation passed on the release candidate: [code checks](https://github.com/Ccmra404/AdBlock-Pro-next/actions/runs/38760229371) and [ARM64 curl build and install ZIP](https://github.com/Ccmra404/AdBlock-Pro-next/actions/runs/38760229613). This exact release has not yet been installed on an Android device; device-specific verification remains separate.
