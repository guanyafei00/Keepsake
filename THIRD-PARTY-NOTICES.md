# 第三方组件声明（THIRD-PARTY NOTICES）

Keepsake 封装并使用以下开源组件。各组件归其原作者所有，本文件按其许可证要求提供许可声明与源码链接。

| 组件 | 用途 | 许可证 | 源码 |
|---|---|---|---|
| yt-dlp | 视频/音频下载引擎 | The Unlicense | https://github.com/yt-dlp/yt-dlp |
| gallery-dl | 图站/媒体下载引擎 | **GPL-3.0** | https://github.com/mikf/gallery-dl |
| FFmpeg | 音视频合并/抽轨/转封装 | LGPL-2.1 / GPL（依构建分支） | https://ffmpeg.org/download.html |
| whisper.cpp | 本地语音转写 | MIT | https://github.com/ggml-org/whisper.cpp |
| Electron | 应用框架 | MIT | https://github.com/electron/electron |
| Node.js | 运行时 | MIT | https://github.com/nodejs/node |

## 分发方式说明

- **yt-dlp / whisper.cpp / bili-probe（本项目自研探针）**：随安装包分发。
- **gallery-dl（GPL-3.0）**：自 v0.1.0 起**不随安装包内嵌**。首次运行时 Keepsake 自动从 gallery-dl 官方发布页（Codeberg，含 SHA-256 校验）下载原始二进制到用户设备；下载失败时可选 Keepsake 官方 Release 上的**原样副本**（未修改的官方文件，附带对应源码链接）或国内镜像作为备选源。Keepsake 不修改、不捆绑该组件；其源码随时可从上方链接获取。
- **FFmpeg**：安装包不含 FFmpeg；首次需要音视频合并/转写时由 Keepsake 自动从官方构建源（gyan.dev，备选 BtbN）下载。
- gallery-dl 与 FFmpeg 作为独立进程被调用，与 Keepsake 主程序之间仅有命令行参数级的数据交换，属于 GPL 认可的「聚合（mere aggregation）」关系；Keepsake 主程序源码不受 GPL 约束，但严格遵循上述组件各自的许可证义务（保留版权声明、提供源码链接）。

## 许可证全文链接

- GPL-3.0：https://www.gnu.org/licenses/gpl-3.0.html
- LGPL-2.1：https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html
- MIT / The Unlicense：随各组件源码仓库分发
