// 下载队列：并发控制 + 自适应风控（档位退避/站点熔断）+ 事件推送
const { spawn } = require('child_process');
const path = require('path');

// 平台化引擎文件名：win 加 .exe，mac/linux 裸名
function exe(n) { return process.platform === 'win32' ? n + '.exe' : n; }
const fs = require('fs');
const strategy = require('./strategy');
const article = require('./article');   // 文章引擎：进程内执行（同 direct 先例，不 spawn 子进程）
const { cookieBrowserWarning } = require('./browsercookies');   // 浏览器登录态预警（Windows 文件锁根因见该文件头注释）

let BIN = path.join(__dirname, '..', 'resources', 'bin');
let ENGINES = null;   // 可写引擎目录（userData/engines）：自更新落这里；spawn 时优先取新版
let COOKIE = path.join(__dirname, '..', 'resources', 'cookies.txt');
let OUTDIR = null;
let PROXY = null;
let MIN_FREE_MB = 1000;   // #70①：目标盘剩余空间低于此值任务挂起（0=关闭检测）
let MAX_CONCURRENT = 2;   // 同时下载任务数（设置页可调 1-5，热更新即时生效）
let RATE_LIMIT = 0;       // 下载限速字节/秒（0=不限；yt-dlp --limit-rate + 直连引擎节流；gallery-dl 图文站不适用）
let GDL_CFG = null;   // gallery-dl 配置：stdout/stderr 强制 UTF-8（韩/日/emoji 否则被内部替换成 '???')
let PIXIV_CFG = null;   // gdl-pixiv.json：Pixiv OAuth refresh-token 配置（授权后存在，spawn 时才查 → 即时生效）
let COOKIE_BROWSER = '';   // 浏览器登录态来源（''=用 cookies.txt 文件；chrome/edge/firefox/brave=引擎 --cookies-from-browser 直读）
let BILI_LINE = '';   // B站 CDN/线路手动选线（''=自动；baidu/tencent/aliyun/wscloud/huawei=国内 CDN 线路枚举，经 --extractor-args "bilibili:cdn=<值>" 透传）
let AUTO_CBZ = false;   // gallery-dl 任务完成后自动把图片目录打包 CBZ
const CBZ_MIN_IMAGES = 3;   // 目录内图片少于该数不打包（避免把单图/缩略图目录也卷进去）
const CBZ_IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
function configure({ binDir, cookiePath, outDir, proxy, minFreeMB, enginesDir, watchdogTotalMin, watchdogStallMin, maxConcurrent, rateLimitMB }) {
  if (binDir) BIN = binDir;
  if (cookiePath) COOKIE = cookiePath;
  if (outDir) OUTDIR = outDir;
  if (proxy !== undefined) PROXY = proxy || null;   // 空串清除
  if (minFreeMB !== undefined) MIN_FREE_MB = Math.max(0, Number(minFreeMB) || 0);
  if (enginesDir) ENGINES = enginesDir;
  if (watchdogTotalMin !== undefined) WATCHDOG_TOTAL_MIN = Math.max(0, Number(watchdogTotalMin) || 0);   // 0=关闭
  if (watchdogStallMin !== undefined) WATCHDOG_STALL_MIN = Math.max(0, Number(watchdogStallMin) || 0);   // 0=关闭
  // 并发热更新：调小立即生效（tick 读模块级值）；调大需外层触发 tick 补位
  if (maxConcurrent !== undefined) MAX_CONCURRENT = Math.min(5, Math.max(1, Math.floor(Number(maxConcurrent) || 2)));
  if (rateLimitMB !== undefined) RATE_LIMIT = Math.min(100, Math.max(0, Math.floor(Number(rateLimitMB) || 0))) * 1024 * 1024;
  try {
    GDL_CFG = path.join(path.dirname(COOKIE), 'gdl-utf8.json');
    fs.writeFileSync(GDL_CFG, JSON.stringify({ output: {
      stdout: { encoding: 'utf-8', errors: 'replace' },
      stderr: { encoding: 'utf-8', errors: 'replace' },
    } }));
  } catch (e) { GDL_CFG = null; console.warn('[queue] gdl config write fail:', e.message); }
  PIXIV_CFG = path.join(path.dirname(COOKIE), 'gdl-pixiv.json');
}

// 运行时可调项（设置页热更；与 configure 分开避免整包重读）
function setCookieBrowser(b) { COOKIE_BROWSER = ['', 'chrome', 'edge', 'firefox', 'brave'].includes(b) ? b : ''; }
// B站 线路/CDN 手动选线（#15）：热更新；选中非自动时透传进 bilibili 下载的 yt-dlp 参数
function setBiliLine(l) { BILI_LINE = ['', 'baidu', 'tencent', 'aliyun', 'wscloud', 'huawei'].includes(l) ? l : ''; }
function setAutoCbz(on) { AUTO_CBZ = !!on; }

// cookie 来源参数：浏览器直读优先（免导出），回落 cookies.txt。两引擎同款参数（各自原生支持）
function cookieArgs() {
  if (COOKIE_BROWSER) return ['--cookies-from-browser', COOKIE_BROWSER];
  if (fs.existsSync(COOKIE)) return ['--cookies', COOKIE];
  return [];
}

// 浏览器登录态预警去重：run() 每个任务都会跑，同一条警告 10 分钟内只放行一次，
// 否则队列连跑 N 个任务就 toast 刷屏 N 次（用户反馈过 toast 骚扰）
let _lastWarn = { msg: '', t: 0 };
function warnOnce(msg) {
  const now = Date.now();
  if (msg === _lastWarn.msg && now - _lastWarn.t < 10 * 60 * 1000) return false;
  _lastWarn = { msg, t: now };
  return true;
}

// 浏览器登录态读取失败的错误翻译：引擎原始报错是英文技术细节（yt-dlp 的
// "Could not copy Chrome cookie database" / "Permission denied ... Cookies"）用户看不懂，
// 替换成人话并附带原文（方便排查）。判定收敛避免误翻：Permission denied 与 Cookies 必须
// 同一行且 Cookies 带词边界（\b）——真实报错是 Cookie 数据库路径（...\Network\Cookies），
// 而「Permission denied: D:/Downloads/MyCookies Backup/file.jpg」这类普通文件权限错误里
// MyCookies 不构成词边界（y 与 C 都是字母），不会被误翻成浏览器锁文案
function translateCookieError(text) {
  const s = String(text || '');
  const locked = /Could not copy Chrome cookie database/i.test(s)
    || /Permission denied[^\n]*\bCookies\b/i.test(s);
  if (!locked) return null;
  return '无法读取浏览器登录态（浏览器正在运行，Windows 锁定了 Cookie 文件）——请完全退出该浏览器后重试，或改用手动导入的 cookies.txt｜原始报错：' + s.slice(0, 120);
}
// gallery-dl 启动参数前缀（所有 spawn 共用）
function gdlBaseArgs() {
  const args = GDL_CFG ? ['--config', GDL_CFG] : [];
  if (PIXIV_CFG && fs.existsSync(PIXIV_CFG)) args.push('--config', PIXIV_CFG);
  return args;
}

// 引擎错误分类：识别风控/限流信号（词边界防误判：避免匹配到文件大小「412MB」之类）
function isRateLimitError(text) {
  return /\b(412|429)\b|-352|rate.?limit|Too Many Requests|Waiting for \d+ (minutes|seconds)|Precondition Failed|请求过于频繁/i.test(text || '');
}

// Windows 下引擎会再 spawn 子进程（yt-dlp→ffmpeg 合并）；只 kill 父进程会留孤儿
// 继续写同一文件。taskkill /T 连整棵进程树一起杀，失败回落 SIGKILL
function killTree(child) {
  if (!child) return;
  try { if (child.exitCode !== null) return; } catch (e) {}
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref();
      return;
    } catch (e) {}
  }
  try { child.kill('SIGKILL'); } catch (e) {}
}

// #70① 磁盘空间检测：下载目录所在盘剩余 < MIN_FREE_MB 视为不足。
let WATCHDOG_TOTAL_MIN = 240;   // 下载总时长上限（分钟）：超时杀进程标 error，任务可重试；0=关闭（外部
let WATCHDOG_STALL_MIN = 15;    // 连续无输出判定（分钟）：引擎网络挂死防永久占用队列；0=关闭
const WATCHDOG_MAX_RETRIES = 2;   // 看门狗触发后自动重试上限：真挂死最多重试 2 次，仍失败才最终标 error（不误杀正常长任务）

// 引擎解析：userData/engines 有自更新新版优先，否则用随包 resources/bin
function pick(name) {
  if (ENGINES) { const p = path.join(ENGINES, name); if (fs.existsSync(p)) return p; }
  return path.join(BIN, name);
}

// statfs 在部分环境不可用时返回 null（= 跳过检测，绝不能因检测失败阻断下载）
function freeMB() {
  if (!OUTDIR || !MIN_FREE_MB) return null;
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const st = fs.statfsSync(OUTDIR);
    return Math.floor(st.bavail * st.bsize / (1024 * 1024));
  } catch (e) { return null; }
}
function diskLow() { const m = freeMB(); return m !== null && m < MIN_FREE_MB; }

class DownloadQueue {
  constructor(broadcast) {
    this.broadcast = broadcast;
    this.items = new Map();
    this.order = [];
    this.active = 0;
    this._heldTimer = null;
  }

  add(url, meta = {}) {
    const u = String(url || '').trim();
    if (!u) return null;
    // 查重（同 URL 活跃任务直接返回已有项并打 duplicate 标记，UI 提示不重复入队
    // 手工挑安全字段——整包展开会把 _child/_files/_diskTimer/_runSeq 等内部
    // 句柄泄漏进 IPC 序列化（spawn 子进程对象/大数组跨进程传递是事故隐患）
    for (const it of this.items.values()) {
      if (it.url === u && ['queued', 'downloading', 'held'].includes(it.status)) {
        return {
          id: it.id, url: it.url, engine: it.engine, status: it.status,
          progress: it.progress, title: it.title, uploader: it.uploader,
          filePath: it.filePath, fileCount: it.fileCount, error: it.error, addedAt: it.addedAt,
          _range: it._range, _subs: it._subs, _audio: it._audio, _transcribe: it._transcribe, _subId: it._subId,
          duplicate: true,
        };
      }
    }
    const id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const item = {
      id, url: u, engine: meta.engine || 'unknown',
      status: 'queued',               // queued|downloading|held|done|error|canceled
      progress: 0, title: meta.title || u, uploader: meta.uploader || null,
      filePath: null, fileCount: 0, error: null, addedAt: Date.now(),
      _range: meta._range || null,
      _subs: !!meta._subs, _audio: !!meta._audio, _transcribe: !!meta._transcribe,
      _subId: meta._subId || null,   // 订阅来源任务：改名后标题同步用
    };
    // 入队即检查熔断：该站冷却中直接挂起
    if (strategy.isBreakered(item.url)) {
      item.status = 'held';
      item.error = '站点风控冷却中';
    }
    this.items.set(id, item);
    this.order.push(id);
    this.tick();
    this.push();
    return item;
  }

  cancel(id) {
    const it = this.items.get(id);
    if (!it) return false;
    if (['queued', 'downloading', 'held'].includes(it.status)) {
      // 直连引擎没有子进程，取消 = destroy 正在传输的请求（_child 为空 killTree 自然跳过）
      if (it._directReq) { try { it._directReq.destroy(); } catch (e) {} it._directReq = null; }
      // 文章引擎同样无子进程：置取消标记，流水线在步骤间/图片循环内自检退出；
      // 顺带 destroy 挂在控制对象上的抓取窗口——页面脚本卡死时标记永远不会被自检到，
      // 不销毁窗口流水线就永远出不来（P1-1）
      if (it._articleCtl) {
        it._articleCtl.canceled = true;
        try { if (it._articleCtl.win) it._articleCtl.win.destroy(); } catch (e) {}
        it._articleCtl = null;
      }
      killTree(it._child);
      if (it._wasActive) { this.active = Math.max(0, this.active - 1); it._wasActive = false; }
      // cancel 立即清磁盘巡检 timer（不留 30s 空转；兜底由 timer 自清分支与 close 事件覆盖）
      if (it._diskTimer) { clearInterval(it._diskTimer); it._diskTimer = null; }
      it.status = 'canceled';
      this.tick();
      this.push();
      return true;
    }
    return false;
  }

  // 退出前清场但不取消任务（用户反馈：未完成项目下次启动自动续跑）：
  // 只杀 downloading 的子进程/请求防孤儿，状态就地改回 queued 落盘；
  // queued/held 原样保留 → 启动时 restore 自动重排续跑。与 cancel 的区别 = 不标 canceled
  killRunning() {
    for (const it of this.items.values()) {
      if (it.status !== 'downloading') continue;
      if (it._directReq) { try { it._directReq.destroy(); } catch (e) {} it._directReq = null; }
      // 同 cancel：退出前也 destroy 文章引擎的抓取窗口，防卡死窗口跨续跑泄漏（P1-1）
      if (it._articleCtl) {
        it._articleCtl.canceled = true;
        try { if (it._articleCtl.win) it._articleCtl.win.destroy(); } catch (e) {}
        it._articleCtl = null;
      }
      killTree(it._child);
      if (it._wasActive) { this.active = Math.max(0, this.active - 1); it._wasActive = false; }
      if (it._diskTimer) { clearInterval(it._diskTimer); it._diskTimer = null; }
      it.status = 'queued';
    }
    this.push();
  }

  // 重试：error/held/canceled/done → queued（重置进度统计，防跨次累加虚高）
  // done 也允许重试——doneCard 本来就渲染了 ⟳ 按钮，点了却无响应；gallery-dl 重跑会自动跳过已有文件
  retry(id) {
    const it = this.items.get(id);
    if (!it || !['error', 'held', 'canceled', 'done'].includes(it.status)) return false;
    it.status = strategy.isBreakered(it.url) ? 'held' : 'queued';
    it.error = null;
    it.progress = 0;
    it.fileCount = 0;
    it._watchdogRetries = 0;   // 手动重试 = 重置看门狗额度，给用户一个干净的重跑机会
    it._diskHeld = false;   // 手动重试 = 用户确认空间已处理，清磁盘挂起标记
    this.tick(); this.push();
    return true;
  }

  // 删除任务记录（只清列表记录，不动磁盘文件）。活跃任务先取消再删
  remove(id) {
    const it = this.items.get(id);
    if (!it) return false;
    if (!['done', 'error', 'canceled'].includes(it.status)) this.cancel(id);
    this.items.delete(id);
    this.order = this.order.filter(x => x !== id);
    this.push();
    return true;
  }

  // 批量清空终态任务（done/error/canceled）的记录
  clearFinished() {
    const FIN = ['done', 'error', 'canceled'];
    const ids = this.order.filter(id => FIN.includes(this.items.get(id).status));
    for (const id of ids) this.items.delete(id);
    this.order = this.order.filter(id => this.items.has(id));
    this.push();
    return ids.length;
  }

  // 订阅改名后同步历史任务标题（老任务在改名前入队，标题里还带着「订阅 N」占位名）
  renameSub(subId, name) {
    let n = 0;
    for (const it of this.items.values()) {
      if (it._subId !== subId) continue;
      const nt = it.title.replace(/^((?:\[订阅回溯\]|\[订阅\])\s+)[^·]+?(\s*·|$)/, `$1${name}$2`);
      if (nt !== it.title) { it.title = nt; n++; }
    }
    return n;
  }

  snapshot() {
    return this.order.map(id => {
      // 保留 _range（先前被剥离导致范围任务崩溃恢复后全量重下）；_files 巨大且只供 onDone 钩子用，不入快照；
      // _runSeq 是 run 序号（内部幂等标记），不得泄漏给渲染层
      const { _child, _wasActive, _files, _diskTimer, _diskHeld, _runSeq, _articleCtl, ...rest } = this.items.get(id);
      if (rest.status === 'held') rest.heldRemainMs = strategy.breakerRemainMs(rest.url);
      return rest;
    });
  }

  push() {
    this.pruneFinished();   // 终态任务上限淘汰，防长驻内存/tasks.json 无限膨胀
    this.broadcast(this.snapshot());
  }

  pruneFinished() {
    const FIN = ['done', 'error', 'canceled'];
    const finished = this.order.filter(id => FIN.includes(this.items.get(id).status));
    if (finished.length > 200) {
      for (const id of finished.slice(0, finished.length - 200)) this.items.delete(id);
      this.order = this.order.filter(id => this.items.has(id));
    }
  }

  tick() {
    // 熔断解除的 held 任务回队（_diskHeld 除外——磁盘挂起要等空间恢复，见 diskWatch）
    for (const id of this.order) {
      const it = this.items.get(id);
      if (it.status === 'held' && !it._diskHeld && !strategy.isBreakered(it.url)) {
        it.status = 'queued';
        it.error = null;
      }
    }
    // 入队/回队时磁盘不足 → 直接挂起（避免启动一瞬又停）
    if (diskLow()) {
      for (const id of this.order) {
        const it = this.items.get(id);
        if (it.status === 'queued') {
          it.status = 'held';
          it._diskHeld = true;
          it.error = '磁盘空间不足（剩余 ' + freeMB() + ' MB < ' + MIN_FREE_MB + ' MB），已暂停——清理空间后自动继续';
        }
      }
    }
    while (this.active < MAX_CONCURRENT) {   // 并发数热更新：读模块级值，调小立即生效
      const next = this.order.map(i => this.items.get(i))
        .find(it => it.status === 'queued' && !strategy.isBreakered(it.url));
      if (!next) break;
      if (diskLow()) { next.status = 'held'; next._diskHeld = true; next.error = '磁盘空间不足，已暂停——清理空间后自动继续'; continue; }
      this.run(next);
    }
    // 定时回查：held（熔断/磁盘）或被熔断卡住的 queued，30 秒一轮。
    // 磁盘恢复的挂起任务也在这里唤醒（#70①）
    const hasHeld = this.order.some(i => this.items.get(i).status === 'held');
    const queuedOnBreaker = !hasHeld && this.order.some(i => {
      const it = this.items.get(i);
      return it.status === 'queued' && strategy.isBreakered(it.url);
    });
    if ((hasHeld || queuedOnBreaker) && !this._heldTimer) {
      this._heldTimer = setTimeout(() => { this._heldTimer = null; this.wakeHeld(); this.tick(); this.push(); }, 30 * 1000);
    }
  }

  // 看门狗判定（独立方法便于单测）：返回 null 或终止原因文本
  _watchdogReason(it) {
    const now = Date.now();
    if (WATCHDOG_TOTAL_MIN > 0 && it._startedAt && now - it._startedAt > WATCHDOG_TOTAL_MIN * 60000)
      return '下载总时长超 ' + WATCHDOG_TOTAL_MIN + ' 分钟';
    if (WATCHDOG_STALL_MIN > 0 && it._lastOutput && now - it._lastOutput > WATCHDOG_STALL_MIN * 60000)
      return '连续 ' + WATCHDOG_STALL_MIN + ' 分钟无输出';
    return null;
  }

  // 看门狗触发后的统一处置：先杀进程/断请求（killFn），再按「自动重试 ≤ WATCHDOG_MAX_RETRIES 次」闭环；
  // 重试耗尽才标 error 并附人话原因。只在真静默/超时触发（_watchdogReason 已把关），绝不误杀正常长任务；
  // 重试直接重跑（本轮看门狗计时在 run 内清零，引擎幂等跳过已存在文件，不重复下载）。
  _watchdogFail(it, wdReason, seq, killFn) {
    if (seq !== it._runSeq || it.status !== 'downloading') return;   // 旧 run 的迟到事件 / 已结束，丢弃
    if (typeof killFn === 'function') { try { killFn(); } catch (e) {} }   // 杀子进程 / 断直连请求 / 关文章抓取窗口
    if (it._diskTimer) { clearInterval(it._diskTimer); it._diskTimer = null; }
    this.active = Math.max(0, this.active - 1);
    it._wasActive = false;
    it._watchdogRetries = (it._watchdogRetries || 0) + 1;
    if (it._watchdogRetries <= WATCHDOG_MAX_RETRIES) {
      // 自动重试：直接重跑（不排队、立即占回原并发槽）；_startedAt/_lastOutput 在 run() 内已重置
      it.status = 'queued';
      it.error = null;
      it.progress = 0;
      this.run(it);
      this.push();
    } else {
      it.status = 'error';
      it.error = '下载长时间无响应（看门狗已自动中止并重试 ' + WATCHDOG_MAX_RETRIES + ' 次仍失败）：' + wdReason + '。请检查网络或站点是否可用，稍后可点 ⟳ 手动重试';
      this.tick(); this.push();
    }
  }

  // 磁盘挂起任务：空间恢复即回队（#70①）
  wakeHeld() {
    if (diskLow()) return;
    for (const id of this.order) {
      const it = this.items.get(id);
      if (it.status === 'held' && it._diskHeld) {
        it._diskHeld = false;
        it.status = 'queued';
        it.error = null;
      }
    }
  }

  run(it) {
    // run 序号——重试/磁盘挂起重跑会再次 run 同一 it，旧 run 的 close/error/磁盘巡检
    // 事件晚到时凭 seq 识别并丢弃，绝不误清新一轮的 timer 或把新任务打成 error
    const seq = (it._runSeq = (it._runSeq || 0) + 1);
    it.status = 'downloading';
    it._startedAt = Date.now();   // 看门狗：总时长基准（恢复的重试任务重新计时）
    it._lastOutput = Date.now();  // 看门狗：无输出判定基准
    if (!Array.isArray(it._files)) it._files = [];   // 本次尝试产出的文件清单（跨重试累积；重试时引擎会跳过已存在文件）
    this.active++;
    it._wasActive = true;
    const done = (status, extra = {}) => {
      if (!it._wasActive) return;   // 幂等守卫（spawn 的 error+close 双触发只算一次
      it.status = status;
      if (status === 'done') it._watchdogRetries = 0;   // 成功即清零看门狗重试计数（避免历史失败拖累后续重试额度）
      Object.assign(it, extra);
      if (status === 'done' && this.onDone) {
        try { this.onDone(it); } catch (e) { console.warn('[queue] onDone hook fail:', e.message); }   // 来源索引（媒体库溯源用）
      }
      if (status === 'done' && AUTO_CBZ) {
        this._maybeCbz(it).catch(e => console.warn('[queue] cbz fail:', e.message));   // 异步打包，不阻塞队列补位
      }
      this.active = Math.max(0, this.active - 1);
      it._wasActive = false;
      this.tick();
      this.push();
    };

    const args = this.buildArgs(it);
    if (it.engine === 'direct') return this.runDirect(it, done, seq);   // 直连引擎无子进程，独立执行路径
    if (it.engine === 'article') return this.runArticle(it, done, seq); // 文章引擎同 direct：进程内执行
    if (!args) return done('error', { error: '不支持的引擎: ' + it.engine });

    // 浏览器登录态预警：选了浏览器且（未安装/正在运行）就提前口头提示——
    // 未装的任务照样会失败，正在运行 gallery-dl 会静默回落游客态，都等引擎报错就太晚了。
    // 放在 spawn 之前但不阻塞热路径（检测是一次 tasklist，几十毫秒）；direct/article 不用 cookieArgs 不检测
    if (COOKIE_BROWSER) {
      const cbw = cookieBrowserWarning(COOKIE_BROWSER);
      if (cbw && warnOnce(cbw) && this.onWarn) { try { this.onWarn(cbw); } catch (e) {} }
    }

    fs.mkdirSync(OUTDIR, { recursive: true });
    // 编码：两引擎输出均为 UTF-8（yt-dlp 用 --encoding；gallery-dl 用 --config 强制 stdout/stderr 为 UTF-8）
    const ytdlpDec = 'utf-8';
    const decOut = new TextDecoder(ytdlpDec);
    const decErr = new TextDecoder(ytdlpDec);
    const child = spawn(args.exe, args.args, { windowsHide: true });
    it._child = child;

    // #70① 下载中每 30 秒查一次磁盘：写满前主动挂起（杀进程树防半截文件），空间恢复后在 wakeHeld 回队
    // 外部同一定时器顺带跑看门狗——总时长超限/连续无输出即杀进程标 error，防引擎挂死永久占用队列
    it._diskTimer = setInterval(() => {
      if (seq !== it._runSeq || it.status !== 'downloading') { clearInterval(it._diskTimer); it._diskTimer = null; return; }
      const wdReason = this._watchdogReason(it);
      if (wdReason) { this._watchdogFail(it, wdReason, seq, () => killTree(child)); return; }
      if (diskLow()) {
        killTree(child);
        it.status = 'held';
        it._diskHeld = true;
        it.error = '磁盘空间不足（剩余 ' + freeMB() + ' MB），已暂停——清理空间后自动继续';
        this.active = Math.max(0, this.active - 1);
        it._wasActive = false;
        clearInterval(it._diskTimer); it._diskTimer = null;
        this.tick(); this.push();
      }
    }, 30 * 1000);
    const clearDiskTimer = () => { if (it._diskTimer) { clearInterval(it._diskTimer); it._diskTimer = null; } };

    child.stdout.on('data', d => this.parseOutput(it, decOut.decode(d, { stream: true })));
    child.stderr.on('data', d => this.parseOutput(it, decErr.decode(d, { stream: true })));
    child.on('error', e => {
      if (seq !== it._runSeq) return;   // 旧 run 的 spawn 错误事件，新 run 已接管
      // 引擎文件缺失（首启在线引导还没下载完 / 杀软误删）→ 给出可行动的提示而非裸 ENOENT
      clearDiskTimer();
      const msg = /ENOENT|spawn/i.test(String(e)) && !fs.existsSync(args.exe)
        ? '下载引擎尚未就绪（首次运行需联网自动下载，几十秒后重试即可；若反复出现请检查杀毒软件是否拦截）'
        : String(e);
      done('error', { error: msg });
    });
    child.on('close', code => {
      if (seq !== it._runSeq) return;   // 旧 run 的进程退出事件——不得清新一轮的 _diskTimer、不得判结果
      clearDiskTimer();
      if (!it._wasActive || it.status === 'canceled') return;   // 幂等守卫（含 cancel 后的 close）
      if (code === 0) {
        strategy.reportSuccess(it.url);
        done('done', { progress: 100, filePath: it.filePath });
      } else {
        const rate = isRateLimitError(it.error);
        const st = strategy.reportFailure(it.url, rate);
        const breakerNow = strategy.isBreakered(it.url);
        // Cookie 文件锁错误优先翻译成人话（translateCookieError 已附带原文）；风控/限流标记照旧叠加
        const base = translateCookieError(it.error) || it.error || ('引擎退出 code=' + code);
        const msg = (rate ? '[风控/限流] ' : '') + base;
        done(breakerNow ? 'held' : 'error', {
          error: msg.slice(0, 300),
          level: st.level
        });
      }
    });
  }

  // 图站任务产物 → CBZ：取本次产出文件里「图片最多的目录」，用系统自带 bsdtar（Windows 10+ 内置，
  // 显式 --format zip）整目录打包成 <目录名>.cbz 与目录平级。0 依赖、失败静默（不影响下载结果）
  async _maybeCbz(it) {
    try {
      if (it.engine !== 'gallery-dl' || !Array.isArray(it._files) || !it._files.length) return;
      const counts = new Map();   // dir -> 图片数
      for (const f of it._files) {
        if (!CBZ_IMG_RE.test(f)) continue;
        const d = path.dirname(f);
        counts.set(d, (counts.get(d) || 0) + 1);
      }
      let best = null, bestN = 0;
      for (const [d, n] of counts) if (n > bestN) { best = d; bestN = n; }
      if (!best || bestN < CBZ_MIN_IMAGES) return;
      const base = path.basename(best);
      const out = path.join(path.dirname(best), base + '.cbz');
      if (fs.existsSync(out)) { it.cbz = out; return; }   // 重试场景：册子已在，跳过
      await new Promise((resolve, reject) => {
        // 必须用绝对路径调系统 bsdtar——Git Bash 环境的 GNU tar 在 PATH 里优先且不支持 zip。
        // 路径经 path.join 拼（避免字符串字面量反斜杠被 JS 转义符吃掉）；--format zip 显式指定
        // （bsdtar 的 -a 只认 .zip 等常见扩展，.cbz 会落回 ustar 格式，实测踩坑）
        const tarExe = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
        const child = spawn(tarExe, ['--format', 'zip', '-c', '-f', out, '-C', path.dirname(best), base], { windowsHide: true });
        let err = '';
        child.stderr.on('data', d => err += d);
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve() : reject(new Error('tar exit ' + code + ' ' + err.slice(0, 100))));
        setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error('cbz 打包超时')); }, 10 * 60000);
      });
      it.cbz = out;
      if (this.onCbz) { try { this.onCbz(it, out); } catch (e) {} }
      this.push();
    } catch (e) { console.warn('[queue] cbz:', e.message); }
  }

  buildArgs(it) {
    const ytdlp = pick(exe('yt-dlp'));
    const gdl = pick(exe('gallery-dl'));
    if (it.engine === 'direct' || it.engine === 'article') return null;   // 进程内引擎不走 spawn（run 已提前分流），防误用
    if (it.engine === 'yt-dlp') {
      // 媒体库物理目录：{站点}/{UP主}/{标题} [id].ext（与 gallery-dl 的 bilibili/{作者}/ 结构对齐）
      const site = /bilibili\.com/i.test(it.url) ? 'bilibili'
        : /youtube\.com|youtu\.be/i.test(it.url) ? 'youtube' : 'other';
      const outTpl = path.join(OUTDIR, site, '%(uploader|Unknown)s', '%(title)s [%(id)s].%(ext)s');
      // ffmpeg 可能尚未就绪（首启在线引导下载中）→ 降级为单文件流，不合并、不抽轨，保住可用性
      const hasFfmpeg = fs.existsSync(pick(exe('ffmpeg')));
    const args = [
        '-f', it._audio ? 'bestaudio/best' : (!hasFfmpeg ? 'b' : 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/bv*+ba/b'),
        '-S', it._audio ? 'abr' : 'res:1080',
        '--merge-output-format', 'mp4',
        ...(hasFfmpeg ? ['--ffmpeg-location', pick(exe('ffmpeg'))] : []),
        '-o', outTpl,
        '--newline', '--no-playlist', '--windows-filenames',
        '--concurrent-fragments', '4',   // DASH 分段 4 路并行（B站/YouTube 视频皆分段下发），实测提速 2~4 倍
        '--encoding', 'utf-8',   // 管道默认 ANSI(GBK)，韩文/emoji 等字符直接丢——强制 UTF-8 保住完整文件名
        '--mtime',   // 用 HTTP Last-Modified 设文件时间＝发帖时间，媒体库才能按帖子发布时间排序
        '--print', 'after_move:filepath',
    ];
      // 仅音频模式（转写/听播客场景）：ffmpeg 抽轨转 mp3（无 ffmpeg 时降级下 bestaudio 原格式）
      if (it._audio && hasFfmpeg) args.push('-x', '--audio-format', 'mp3', '--audio-quality', '5');
      // 随视频下载字幕（转写替代/辅助）：优先中文，AI 自动字幕也收；拿不到不阻塞下载
      if (it._subs) args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'zh.*,zh,en.*', '--convert-subs', 'srt');
      const st = strategy.forUrl(it.url);
      // 注意：yt-dlp 裸 --sleep 有歧义（ambiguous），必须用 --sleep-interval；gallery-dl 才用 --sleep
      if (st.sleep > 0) args.push('--sleep-interval', String(st.sleep), '--sleep-requests', String(Math.max(1, st.sleep)));
      // 下载限速（设置页可调，0=不限）；--limit-rate 接受 4.2M 这类后缀
      if (RATE_LIMIT > 0) args.push('--limit-rate', Math.floor(RATE_LIMIT / (1024 * 1024)) + 'M');
      if (PROXY) args.push('--proxy', PROXY);   // YouTube 等被墙站点走用户代理
      args.push(...cookieArgs());
      // B站 线路/CDN 手动选线（#15）：选中非自动时透传 --extractor-args "bilibili:cdn=<线路>"。
      // 当前 yt-dlp(2026.08.19) 的 bilibili 提取器未注册 cdn extractor-arg，属前向兼容钩子——
      // 引擎仅告警忽略、不影响下载；待上游/分支支持后无需改码即生效。
      if (BILI_LINE && site === 'bilibili') args.push('--extractor-args', 'bilibili:cdn=' + BILI_LINE);
      args.push('-P', OUTDIR, it.url);
      return { exe: ytdlp, args };
    }
    if (it.engine === 'gallery-dl') {
      const st = strategy.forUrl(it.url);
      const args = [...gdlBaseArgs(), '-d', OUTDIR, '--windows-filenames'];
      if (st.sleep > 0) args.push('--sleep', String(st.sleep));
      if (it._range) args.push('--range', it._range);
      if (PROXY) args.push('--proxy', PROXY);
      args.push(...cookieArgs());
      args.push(it.url);
      return { exe: gdl, args };
    }
    return null;
  }

  // 直连引擎：directprobe 隐藏窗口现取 CDN 直链（带签名/时效，每次运行必须现取）→ Node 流式下载。
  // 无子进程：看门狗/磁盘巡检用 destroy 请求代替 killTree；取消走 cancel 里的 _directReq 分支
  runDirect(it, done, seq) {
    const http = require('http');
    const https = require('https');
    const electron = require('electron');
    const dp = require('./directprobe');
    it._lastOutput = Date.now();
    // 磁盘/看门狗巡检（与 spawn 路径同节奏 30s，逻辑一致）
    it._diskTimer = setInterval(() => {
      if (seq !== it._runSeq || it.status !== 'downloading') { clearInterval(it._diskTimer); it._diskTimer = null; return; }
      const wdReason = this._watchdogReason(it);
      if (wdReason) { this._watchdogFail(it, wdReason, seq, () => { if (it._directReq) { try { it._directReq.destroy(); } catch (e) {} } }); return; }
      if (diskLow()) {
        if (it._directReq) { try { it._directReq.destroy(); } catch (e) {} }
        it.status = 'held';
        it._diskHeld = true;
        it.error = '磁盘空间不足（剩余 ' + freeMB() + ' MB），已暂停——清理空间后自动继续';
        this.active = Math.max(0, this.active - 1);
        it._wasActive = false;
        clearInterval(it._diskTimer); it._diskTimer = null;
        this.tick(); this.push();
      }
    }, 30 * 1000);
    const clearDiskTimer = () => { if (it._diskTimer) { clearInterval(it._diskTimer); it._diskTimer = null; } };

    const fail = (msg) => {
      clearDiskTimer();
      if (it._directReq) { try { it._directReq.destroy(); } catch (e) {} it._directReq = null; }
      if (seq !== it._runSeq || !it._wasActive || it.status === 'canceled') return;
      const st = strategy.reportFailure(it.url, false);
      done(strategy.isBreakered(it.url) ? 'held' : 'error', { error: String(msg).slice(0, 300), level: st.level });
    };

    dp.probe(it.url, { electron }).then(r => {
      if (seq !== it._runSeq) return;   // 旧 run 的探测晚到，丢弃
      if (r.error) return fail(r.error);
      if (/\.m3u8/i.test(r.url)) return fail('仅探测到分段流(m3u8)，暂不支持自动下载：请在页面内直接观看或稍后重试');
      const site = /douyin\.com/i.test(it.url) ? 'douyin'
        : /kuaishou\.com|chenzhongtech/i.test(it.url) ? 'kuaishou' : 'other';
      // 视频 id：URL 里能抓就抓（媒体库溯源用），抓不到用任务 id 兑底
      const vm = it.url.match(/\/video\/(\d+)/) || it.url.match(/short-video\/([\w-]+)/);
      const vid = vm ? vm[1] : it.id;
      const dir = path.join(OUTDIR, site);
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, dp.sanitizeName(r.title) + ' [' + vid + '].mp4');
      it.title = r.title || it.title;   // 探测拿到真实标题后回填任务卡

      // 下载请求：跟随重定向（CDN 直链常 302），移动 UA + 页面 Referer 与探测窗口对齐
      const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
      const doReq = (u, redirects) => {
        if (redirects > 5) return fail('CDN 重定向次数过多');
        const mod = u.startsWith('https') ? https : http;
        const req = mod.get(u, {
          headers: { 'User-Agent': UA, 'Referer': it.url },
        }, res => {
          if (seq !== it._runSeq) { res.resume(); return; }
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            return doReq(new URL(u, res.headers.location).href, redirects + 1);
          }
          if (res.statusCode !== 200) { res.resume(); return fail('CDN 返回 HTTP ' + res.statusCode + '（直链可能已过期，重试会现取新链）'); }
          const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
          let got = 0;
          const out = fs.createWriteStream(fp);
          out.on('error', e => { req.destroy(); fail('写入文件失败: ' + e.message); });
          res.on('data', c => {
            if (seq !== it._runSeq) { req.destroy(); return; }
            got += c.length;
            it._lastOutput = Date.now();   // 看门狗：收到数据 = 活着
            if (total) it.progress = Math.min(99, Math.floor(got / total * 100));
            // 下载限速：每秒配额用完后暂停数据流，1 秒后恢复（1s 粒度对限速足够，不追求平滑）
            if (RATE_LIMIT > 0) {
              it._rateBytes = (it._rateBytes || 0) + c.length;
              if (it._rateBytes >= RATE_LIMIT && !it._ratePaused) {
                it._ratePaused = true;
                res.pause();
                setTimeout(() => {
                  it._rateBytes = 0; it._ratePaused = false;
                  if (seq === it._runSeq && it.status === 'downloading') { try { res.resume(); } catch (e) {} }
                }, 1000);
              }
            }
            this.pushThrottled();
          });
          res.on('error', e => fail('网络中断: ' + e.message));
          res.pipe(out);
          out.on('finish', () => {
            if (seq !== it._runSeq) return;
            clearDiskTimer();
            it._directReq = null;
            if (!it._wasActive || it.status === 'canceled') return;
            if (!it._files.includes(fp)) it._files.push(fp);
            strategy.reportSuccess(it.url);
            done('done', { progress: 100, filePath: fp, fileCount: 1 });
          });
        });
        req.on('error', e => fail('网络请求失败: ' + e.message));
        req.setTimeout(20000, () => { req.destroy(new Error('CDN 连接超时')); });
        it._directReq = req;
      };
      doReq(r.url, 0);
    }).catch(e => fail(e && e.message || e));
  }

  // 文章引擎：lib/article.js 流水线进程内执行（隐藏窗口抓网页文章 → 4 件套归档）。
  // 无子进程：看门狗/磁盘巡检与 direct 路径同节奏；取消走 cancel 里的 _articleCtl 标记分支
  runArticle(it, done, seq) {
    it._articleCtl = { canceled: false };
    it._lastOutput = Date.now();
    // 磁盘/看门狗巡检（与 spawn/direct 路径同节奏 30s，逻辑一致）
    it._diskTimer = setInterval(() => {
      if (seq !== it._runSeq || it.status !== 'downloading') { clearInterval(it._diskTimer); it._diskTimer = null; return; }
      const wdReason = this._watchdogReason(it);
      if (wdReason) { this._watchdogFail(it, wdReason, seq, () => { if (it._articleCtl) { it._articleCtl.canceled = true; try { if (it._articleCtl.win) it._articleCtl.win.destroy(); } catch (e) {} } }); return; }
      if (diskLow()) {
        if (it._articleCtl) { it._articleCtl.canceled = true; try { if (it._articleCtl.win) it._articleCtl.win.destroy(); } catch (e) {} it._articleCtl = null; }
        it.status = 'held';
        it._diskHeld = true;
        it.error = '磁盘空间不足（剩余 ' + freeMB() + ' MB），已暂停——清理空间后自动继续';
        this.active = Math.max(0, this.active - 1);
        it._wasActive = false;
        clearInterval(it._diskTimer); it._diskTimer = null;
        this.tick(); this.push();
      }
    }, 30 * 1000);
    const clearDiskTimer = () => { if (it._diskTimer) { clearInterval(it._diskTimer); it._diskTimer = null; } };

    const fail = (msg, kind) => {
      clearDiskTimer();
      it._articleCtl = null;
      if (seq !== it._runSeq || !it._wasActive || it.status === 'canceled') return;
      // 删帖/付费墙/选不出正文 = 源头内容或版式问题，不是站点风控——不计熔断（P2-5），
      // 否则几篇被删文章就把整个站点打成冷却，后续正常文章全部误挂起
      if (kind === 'deleted' || kind === 'paywall' || kind === 'select') {
        return done('error', { error: String(msg).slice(0, 300) });
      }
      const st = strategy.reportFailure(it.url, false);
      done(strategy.isBreakered(it.url) ? 'held' : 'error', { error: String(msg).slice(0, 300), level: st.level });
    };

    article.fetchArticle({
      url: it.url,
      outDir: OUTDIR,
      cancel: it._articleCtl,
      // 进度回调：onProgress 百分比直接进进度条；任何回调都算「活着」（看门狗无输出判定）
      onProgress: (pct) => {
        if (seq !== it._runSeq) return;
        it._lastOutput = Date.now();
        it.progress = Math.min(99, Math.max(0, Math.round(pct)));
        this.pushThrottled();
      },
    }).then(r => {
      clearDiskTimer();
      it._articleCtl = null;
      if (seq !== it._runSeq || !it._wasActive || it.status === 'canceled') return;
      it.title = (r.meta && r.meta.title) || it.title;   // URL 占位标题换成文章真名
      it.filePath = r.dir;                               // 指向文章目录（📂 打开所在文件夹）
      it.fileCount = r.fileCount;
      if (!it._files.includes(r.dir)) it._files.push(r.dir);   // source.record 用（媒体库溯源）
      strategy.reportSuccess(it.url);
      done('done', { progress: 100, filePath: r.dir, fileCount: r.fileCount });
    }).catch(e => {
      clearDiskTimer();
      it._articleCtl = null;
      if (seq !== it._runSeq || !it._wasActive || it.status === 'canceled') return;
      // 取消在流水线内部抛出：此时 cancel() 已把任务置 canceled，静默返回即可
      if (e && e.kind === 'canceled') return;
      fail((e && e.human) || (e && e.message) || String(e), e && e.kind);
    });
  }

  parseOutput(it, chunk) {
    if (it.status === 'downloading') it._lastOutput = Date.now();   // 看门狗：任何输出都算活着的信号
    for (const rawLine of chunk.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (it.engine === 'yt-dlp') {
        if (!line.startsWith('[') && /^[A-Za-z]:\\/.test(line)) { it.filePath = line; if (!it._files.includes(line)) it._files.push(line); continue; }
        // Destination/Merger 行 = 真实文件名（粘贴入队的任务标题还是 URL，下载半天不知道在下什么——
        // 拿到文件名就回填：_destPath 供「打开文件夹」用，URL 标题换成文件名）
        const dm = line.match(/^\[download\]\s+Destination:\s*(.+)$/i) || line.match(/^\[Merger\]\s+Merging formats into\s+"(.+)"$/i);
        if (dm) {
          const p0 = dm[1].trim().replace(/^["']|["']$/g, '');
          if (/^[A-Za-z]:\\/.test(p0)) {
            it._destPath = p0;   // DASH 分段时这是 .f137 临时名，但目录正确，打开文件夹不受影响
            if (!it._files.includes(p0)) it._files.push(p0);
            if (/^https?:\/\//i.test(it.title || '')) {
              const base = p0.replace(/^.*[\\/]/, '').replace(/\.f\d+\.[a-z0-9]+$/i, '').replace(/\.[a-z0-9]+$/i, '');
              if (base) it.title = base.slice(0, 80);
            }
            continue;
          }
        }
        const m = line.match(/\[download\]\s+([\d.]+)%/);
        if (m) it.progress = Math.max(it.progress, parseFloat(m[1]));
        if (line.startsWith('ERROR')) it.error = line;
      } else if (it.engine === 'gallery-dl') {
        // 实测输出格式："# D:\Downloads\...\1.jpg"（# 前缀+绝对路径）；旧版本是 "./相对路径"
        if (line.startsWith('# ') || line.startsWith('./')) {
          it.fileCount++;
          it.filePath = line.startsWith('# ') ? line.slice(2).trim() : path.join(OUTDIR, line.slice(2));
          if (!it._files.includes(it.filePath)) it._files.push(it.filePath);
          it.progress = Math.min(99, it.fileCount * 10);
        }
        if (/^ERROR/i.test(line)) it.error = line;
        // gallery-dl 的限速等待也是风控信号
        const wait = line.match(/Waiting for (\d+) minutes?/i);
        if (wait) it.error = '站点限流：等待 ' + wait[1] + ' 分钟';
      }
    }
    this.pushThrottled();
  }

  pushThrottled() {
    if (this._lastPush && Date.now() - this._lastPush < 300) { this._dirty = true; return; }
    this._lastPush = Date.now();
    this.push();
    if (this._dirty) { this._dirty = false; setTimeout(() => this.pushThrottled(), 350); }
  }
}

module.exports = { DownloadQueue, configure, reconfigure: configure, setCookieBrowser, setAutoCbz, setBiliLine };
