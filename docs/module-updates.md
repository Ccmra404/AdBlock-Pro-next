# Root 管理器内更新模块

模块通过 `module.prop` 中的 `updateJson` 接入管理器原生更新功能：

```text
https://github.com/Ccmra404/AdBlock-Pro-next/releases/latest/download/update.json
```

管理器读取最新正式版的版本号及整数 `versionCode`；当远端数值更大时，显示更新入口。用户可以查看中文更新日志、下载安装包并按管理器提示安装。模块不会自行下载、静默安装或为检查版本常驻后台进程。

GitHub 正式发布工作流自动从 `module.prop` 生成 `update.json`，与 ARM64 ZIP、SHA-256 和 `changelog.md` 一起上传到新 Release。清单中的安装包及日志指向同一版本的不可变地址，避免开发分支或预览版本提前提示正式更新。预发布版不生成更新清单，也不标记为 latest；已有 Release 不覆盖。

旧安装包没有 `updateJson` 时，管理器无法发现这个新入口，需先手动覆盖安装一次支持该功能的正式版。之后是否主动提醒、何时检查、安装后是否要求重启，由具体管理器决定。无法访问 GitHub 时，本次检查或下载可能失败，可改用项目 OpenList 镜像手动下载安装。

该功能按 [Magisk 官方模块格式](https://topjohnwu.github.io/Magisk/guides.html#moduleprop)、[KernelSU 模块格式](https://kernelsu.org/guide/module.html#module-prop) 和 [APatch 管理器实现](https://github.com/bmax121/APatch/blob/main/app/src/main/java/me/bmax/apatch/ui/viewmodel/APModuleViewModel.kt)接入。标准兼容不等于每个衍生管理器均已完成界面实测。
