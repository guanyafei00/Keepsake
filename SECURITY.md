# 安全政策

## 报告漏洞

发现安全问题请不要直接开公开 issue。

优先用 GitHub 的私有漏洞报告：打开本仓库的 Security 页，点 Report a vulnerability。这个通道只有维护者能看到，等修复发出去之后再公开细节。

> 这个入口需要仓库设置里开启 Private vulnerability reporting（Settings → Advanced Security）。没开的话 Security 页不会出现按钮，此时请通过 GitHub 给维护者发消息说明情况。

报告里请写清楚影响范围、复现步骤和你的联系方式。不要附真实 Cookie、token、账号密码或带登录态的链接；需要演示时用脱敏样例。

## 处理节奏

收到后先确认能否复现，再判断影响范围。修复随最近一次版本发布，release notes 里写修了什么，不写可利用的细节。

## 范围

Keepsake 是本地运行的桌面应用，不收集、不上传用户数据。以下通常不算安全问题：

- 第三方站点自身的服务条款或访问策略变化导致订阅失败
- 用户本机导出的 Cookie 文件保管不当
- 需要攻击者已经能物理接触或登录用户本机才能触发的情形

依赖组件（yt-dlp / gallery-dl / FFmpeg / whisper.cpp 等）自身的问题，请优先报给对应上游。如果影响本程序的分发或调用方式，也欢迎在这里说明。
