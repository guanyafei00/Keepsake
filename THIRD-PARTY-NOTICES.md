# 第三方组件声明（THIRD-PARTY NOTICES）

Keepsake 封装、调用或随安装包分发以下开源组件。各组件归其原作者所有，本文件按其许可证要求提供许可声明与源码链接（「源码要约 / Source Offer」）。

| 组件 | 用途 | 许可证 | 源码 / 上游仓库 |
|---|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 视频 / 音频下载引擎 | **The Unlicense**（公有领域） | https://github.com/yt-dlp/yt-dlp |
| [gallery-dl](https://github.com/mikf/gallery-dl) | 图站 / 媒体下载引擎 | **GPL-3.0** | https://github.com/mikf/gallery-dl |
| [FFmpeg](https://ffmpeg.org) | 音视频合并 / 抽轨 / 转封装 | **LGPL-2.1+ / GPL**（依构建分支） | https://github.com/FFmpeg/FFmpeg · https://ffmpeg.org/download.html |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | 本地语音转写（whisper 模型推理） | **MIT** | https://github.com/ggml-org/whisper.cpp |
| [Electron](https://github.com/electron/electron) | 桌面应用框架 | **MIT** | https://github.com/electron/electron |
| [Node.js](https://github.com/nodejs/node) | 运行时 | **MIT** | https://github.com/nodejs/node |
| [@mozilla/readability](https://github.com/mozilla/readability) | 文章正文提取（归档用） | **Apache-2.0** | https://github.com/mozilla/readability |

> Keepsake 主程序自身为私有许可（见 `LICENSE`），与上述组件之间仅为命令行参数级的数据交换与独立进程调用，属于 GPL 认可的「聚合（mere aggregation）」关系；主程序源码不受 GPL 约束，但严格遵循各组件许可证义务（保留版权声明、提供源码链接 / 要约）。

## 随包分发的引擎二进制（app/resources/bin）

以下第三方引擎二进制随 Keepsake 应用分发（位于 `app/resources/bin/`），其许可与上游源码链接如下：

| 文件 | 组件 | 许可证 | 上游源码要约 |
|---|---|---|---|
| `yt-dlp.exe` | yt-dlp | The Unlicense | https://github.com/yt-dlp/yt-dlp |
| `gallery-dl.exe` | gallery-dl | **GPL-3.0** | https://github.com/mikf/gallery-dl |
| `ffmpeg.exe` | FFmpeg | LGPL-2.1+ / GPL | https://github.com/FFmpeg/FFmpeg |
| `bili-probe.exe` | B站探针（Keepsake 自研） | Keepsake 私有许可 | —（本项目原创代码） |
| `whisper/whisper-cli.exe` + `whisper/*.dll` | whisper.cpp | MIT | https://github.com/ggml-org/whisper.cpp |

- **gallery-dl（GPL-3.0）源码要约**：其完整对应源码随时可从上游仓库获取 —— https://github.com/mikf/gallery-dl （含各发布版本 tag 与源码归档）。Keepsake 不修改、不捆绑该组件，仅按原样调用。
- **yt-dlp（The Unlicense）**：公有领域许可，无源码分发义务；上游源码见 https://github.com/yt-dlp/yt-dlp 。
- **FFmpeg**：安装包内含的构建通常基于 LGPL 配置；如在特定分发中启用 GPL 组件（如 `libx264`/`libx265`），则整体按 GPL 对待。源码见 https://github.com/FFmpeg/FFmpeg 。
- **whisper.cpp（MIT）**：本地转写模型推理引擎，源码见 https://github.com/ggml-org/whisper.cpp 。

## 分发方式说明

- **yt-dlp / whisper.cpp / bili-probe（本项目自研探针）**：随安装包分发（见上方 `resources/bin` 清单）。
- **gallery-dl（GPL-3.0）**：随安装包分发 `resources/bin/gallery-dl.exe`；首次运行若本地缺失，Keepsake 亦可自动从 gallery-dl 官方发布页（Codeberg，含 SHA-256 校验）下载原始二进制到用户设备，或选用 Keepsake 官方 Release 上的**原样副本**（未修改的官方文件，附对应源码链接）作为备选源。Keepsake 不修改、不捆绑该组件；其源码随时可从上方链接获取。
- **FFmpeg**：安装包内置 `resources/bin/ffmpeg.exe`；首次需要音视频合并 / 转写时若缺失，亦可由 Keepsake 自动从官方构建源（gyan.dev，备选 BtbN）下载。
- gallery-dl 与 FFmpeg 作为独立进程被调用，与 Keepsake 主程序之间仅有命令行参数级的数据交换，属于 GPL 认可的「聚合（mere aggregation）」关系；Keepsake 主程序源码不受 GPL 约束，但严格遵循上述组件各自的许可证义务（保留版权声明、提供源码链接 / 要约）。

## 许可证全文链接

- **GPL-3.0（gallery-dl 等）**：https://www.gnu.org/licenses/gpl-3.0.html
- **LGPL-2.1（FFmpeg LGPL 构建）**：https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html
- **MIT（Electron / Node.js / whisper.cpp 等）**：随各组件源码仓库分发（见上方链接）
- **Apache-2.0（@mozilla/readability）**：https://www.apache.org/licenses/LICENSE-2.0
- **The Unlicense（yt-dlp）**：https://unlicense.org/

---

© 各组件原作者。Keepsake 主程序 © 2026 Keepsake Author，保留所有权利。
