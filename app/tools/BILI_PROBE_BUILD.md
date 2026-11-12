# bili-probe 构建与溯源

`app/resources/bin/bili-probe.exe` 是 B 站 UP 主动态列表探针：只读列表，不下载内容，
下载一律交给官方引擎。源码是 `app/tools/bili_probe.py`（191 行，只用 Python 标准库）。

## 构建命令

在 `app/` 目录下执行：

```
pyinstaller --onefile --name bili-probe --distpath resources/bin --workpath build --specpath build tools/bili_probe.py
```

命令出处是旧工作区 2026-10-25 / 11-06 的交接会话日志。本机用的 PyInstaller 在
`C:\Users\GG\.workbuddy\binaries\python\envs\default\Scripts\pyinstaller.exe`，
换机器换成自己的那份即可；`build/`、`*.spec` 是构建中间物，不要提交。

## 当前随包二进制

| 项 | 值 |
|---|---|
| 路径 | `app/resources/bin/bili-probe.exe` |
| 大小 | 8,138,039 字节 |
| SHA-256 | `e8ac92a508db15c5f16481b15593709f1d6ef10ff6b467dad831837671c652d2` |
| 基线记录时间 | 2026-11-12 |

校验：

```
sha256sum app/resources/bin/bili-probe.exe
```

## 关于「可复现」的实话

R1.6 原判据写的是「构建产物哈希可复现」，这条做不到：PyInstaller onefile 会把构建时间戳、
临时路径和 Python / PyInstaller 版本差异编进产物，同一份源码重打两次也不会字节一致，
所以哈希相等不能拿来证明某个 exe 出自某份源码。

本次做到的只是可追溯：源码在版本库里、构建命令有据可查、随包二进制的基线哈希已记录。
**没有重新构建，也没有验证当前 exe 与这份源码的对应关系**——要验证只能看运行行为
（例如 `bili-probe.exe <UID> "" all` 返回的 JSON 结构），不能靠哈希。判据相应改为
「源码 + 命令 + 基线哈希可追溯」。

如果将来要更强的保证，得固定构建环境版本、改用支持可复现产出的打包工具，
并留一份构建日志与产物签名。那是独立的工程，不搭 0.3.1 这班车。
