const { app, BrowserWindow, ipcMain, shell, Tray, Menu, Notification, dialog, clipboard, protocol } = require('electron');

// ★ Pixiv 授权深链接管（必须在 app ready 前、且全局只能调一次）：把 pixiv 注册为内部标准协议，
// 页面 location 跳 pixiv:// 才会路由进 protocol.handle（pixivauth.installPixivProtocol），
// 否则 Chromium 交给 OS「外部协议启动」→ 没装 Pixiv App 弹「获取打开此链接的应用」，
// 授权 code 直接丢失（实测）
protocol.registerSchemesAsPrivileged([{ scheme: 'pixiv', privileges: { standard: true, secure: true } }]);
// README 截图模式需在 app ready 前禁硬件加速（无 GPU/沙箱环境下 GPU 进程会崩）
if (process.env.KEEPSAKE_CAPTURE) app.disableHardwareAcceleration();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');   // app:applyUpdate 静默安装用，之前漏 import 导致自更新必炸

// GPU 崩溃保护：核显/驱动异常机器上降级为软件渲染（实测 0xC0000005 GPU 进程崩溃）
app.disableHardwareAcceleration();

// autotest 数据隔离：测试绝不读写用户真实数据（曾把测试任务/订阅写进用户 %APPDATA%）
if (process.env.FETCHIE_AUTOTEST) {
  app.setPath('userData', path.join(os.tmpdir(), 'keepsake-autotest-' + Date.now()));
}
// E2E 数据隔离：Playwright 驱动真实窗口跑 UI 流程，同样不得触碰用户数据
if (process.env.KEEPSAKE_E2E) {
  app.setPath('userData', path.join(os.tmpdir(), 'keepsake-e2e-' + Date.now()));
}
// README 截图数据隔离：用仓库内演示数据（screenshots/demo-userdata），公开截图不暴露真实订阅
if (process.env.KEEPSAKE_CAPTURE) {
  app.setPath('userData', path.join(__dirname, '..', 'screenshots', 'demo-userdata'));   // app/ 上一层就是工作区根
}

const identify = require('./lib/identify');
const { ClipWatcher } = require('./lib/clipwatch');
const { DownloadQueue, configure, setBiliLine } = require('./lib/queue');
const strategy = require('./lib/strategy');
const autoupdate = require('./lib/autoupdate');
const store = require('./lib/store');
const subs = require('./lib/subs');
const { browserState, cookieBrowserWarning } = require('./lib/browsercookies');   // 浏览器登录态预警（Windows 文件锁根因见该文件头注释）
const library = require('./lib/library');
const login = require('./lib/login');
const pixivauth = require('./lib/pixivauth');
const settings = require('./lib/settings');
const asr = require('./lib/asr');
const { runEngine } = require('./lib/engine_probe');
const ai = require('./lib/ai');
const enginesBoot = require('./lib/engines_boot');
const updateSign = require('./lib/update_sign');
const log = require('./lib/log');
const source = require('./lib/source');
const srtLib = require('./lib/srt');
const backup = require('./lib/backup');
const textindex = require('./lib/textindex');
const articleLib = require('./lib/article');   // 文章引擎（M-A2/A3）：公众号/知乎/B站专栏等网页文章归档 + 删帖复查
const { atomicWrite } = require('./lib/jsonfile');   // 迁移包导出防半截文件

const CHECK_INTERVAL_MS = 10 * 60 * 1000;   // 每站 10 分钟增量检查
const RULES_INTERVAL_MS = 6 * 3600 * 1000;  // 远程风控规则 6 小时拉一轮
// 默认规则服务端（静态 JSON，随规则变更直接更新线上文件）；FETCHIE_RULES_URL 环境变量可覆盖
const RULES_URL = process.env.FETCHIE_RULES_URL || 'https://guanyafei00.github.io/fetchie-rules/rules.json';
let _rulesVersion = null;   // 最近一次成功应用的远程规则版本（UI 展示用）
// 出厂预置更新源（A4 决策 2026-10-10：维护约定：每次发版同步更新线上 update.json）
// 用户在设置页自己填的 updateUrl 优先于预置值；每次发版流程：签 update.json → 部署到该地址
const UPDATE_URL_PRESET = 'https://guanyafei00.github.io/fetchie-rules/update.json';

// 品牌读音映射（#45 改名 Keepsake）：app 当前未接入 TTS 引擎，但为将来「朗读 / 语音播报」预留正确读法，
// 避免 TTS 把 Keepsake 读成别扭音节（老品牌 DGO 会被逐字母读成「迪-吉-欧」，Keepsake 则自然两音节）。
// 英文自然读音 /ˈkiːpseɪk/ = keep + sake；中文 TTS 直读英文近似「基普塞克」，人耳自然、不逐字母。
// 个别引擎切分异常时可用下方 SSML 显式停顿兜底（实测 edge-tts 对 Keepsake 可直接自然读出，无需强拆）。
const BRAND_TTS = {
  name: 'Keepsake',
  ipa: 'ˈkiːpseɪk',
  syllables: ['keep', 'seɪk'],                    // 自然音节拆分：keep-sake
  zhReadAloud: '基普塞克',                          // 中文 TTS 直读英文的近似音
  edgeTtsSsml: '<speak>keep<break time="120ms"/>sake</speak>',  // edge-tts 兜底：显式停顿防连读
};

async function refreshRemoteRules() {
  try {
    const j = await strategy.fetchRemoteRules(RULES_URL);
    const r = strategy.applyRemoteRules(j.rules || [], { version: j.version });
    _rulesVersion = j.version || null;
    console.log('[rules] remote rules applied:', r.applied, '/', r.total, 'version:', j.version || '-');
    return { ok: true, applied: r.applied, total: r.total, version: _rulesVersion };
  } catch (e) {
    console.log('[rules] remote fetch fail (沿用上次/内置策略):', e.message);
    return { ok: false, reason: e.message, version: _rulesVersion };
  }
}

function exe(n) { return process.platform === 'win32' ? n + '.exe' : n; }   // 平台化引擎文件名

function binDir() {
  // darwin：安装包不带 mac 二进制，首启由 engines_boot 下载到 userData/engines
  if (process.platform === 'darwin') return path.join(app.getPath('userData'), 'engines');
  const dev = path.join(__dirname, 'resources', 'bin');
  if (fs.existsSync(dev)) return dev;
  return path.join(process.resourcesPath, 'bin');
}

let win = null;
let queue = null;
let tray = null;
let quitting = false;   // 托盘模式：关窗≠退出，仅托盘菜单「退出」置位
let minimizeNotices = 0;   // 关窗到托盘的提示只弹前 2 次

function trayIcon() {
  const dev = path.join(__dirname, 'resources', 'tray.png');
  return fs.existsSync(dev) ? dev : path.join(process.resourcesPath, 'tray.png');
}

function appIconPath() {
  const dev = path.join(__dirname, 'resources', 'app.ico');
  return fs.existsSync(dev) ? dev : path.join(process.resourcesPath, 'app.ico');
}

function createTray() {
  if (tray) return;
  try {
    tray = new Tray(trayIcon());
    tray.setToolTip('Keepsake — 媒体下载与订阅');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 Keepsake', click: () => { if (win) { win.show(); win.focus(); } } },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('double-click', () => { if (win) { win.show(); win.focus(); } });
  } catch (e) {
    console.error('[tray] create fail (主窗口不受影响):', e.message);
    tray = null;
  }
}

function createWindow() {
  const capture = !!process.env.KEEPSAKE_CAPTURE;
  win = new BrowserWindow({
    width: 1180, height: 800,
    minWidth: 940, minHeight: 640,   // 防止缩到极小破版
    icon: appIconPath(),
    // 安全加固（#17）：禁用 Node 集成 + 开启上下文隔离 + 启用渲染进程沙箱。
    // sandbox 下 preload 仅能经 require('electron') 拿 contextBridge/ipcRenderer——本 preload 正是此模式，不破坏渲染。
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  win.loadFile('index.html');
  // README 截图模式：KEEPSAKE_CAPTURE=1 用演示数据自动切页截 3 张图后退出（数据隔离见文件头部）
  // capturePage 在 in-process-gpu 下会挂死 → 兜底走 desktopCapturer 屏幕捕获（OS 层，不依赖 Chromium 合成器）
  if (capture) {
    const { desktopCapturer, screen } = require('electron');
    const withTimeout = (p, ms, tag) => Promise.race([
      p,
      new Promise((_res, rej) => setTimeout(() => rej(new Error(tag + ' 超时' + ms + 'ms')), ms))
    ]);
    // 屏幕捕获 + 裁出窗口客户区（乘 scaleFactor 适配 DPI）
    async function captureShot() {
      win.show(); win.focus();
      const d = screen.getDisplayMatching(win.getBounds());
      const sf = d.scaleFactor || 1;
      const sources = await withTimeout(desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) }
      }), 10000, 'getSources');
      if (!sources.length) throw new Error('desktopCapturer 无屏幕源');
      const b = win.getContentBounds();
      const img = sources[0].thumbnail.crop({
        x: Math.round((b.x - d.bounds.x) * sf),
        y: Math.round((b.y - d.bounds.y) * sf),
        width: Math.round(b.width * sf),
        height: Math.round(b.height * sf)
      });
      if (img.isEmpty()) throw new Error('截到空帧');
      return img;
    }
    win.webContents.on('render-process-gone', (_e, d) => console.error('[capture] render-gone', JSON.stringify(d)));
    win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[capture] did-fail-load', code, desc));
    win.webContents.once('did-finish-load', () => {
      console.log('[capture] did-finish-load 进入截图流程');
      const fsx = require('fs');
      // 截图输出：开发模式写仓库 screenshots/；打包后 __dirname 在安装目录里（应只读），
      // 改写 userData，不再污染安装目录（v0.2.15 前的安装目录 screenshots 残留即此来源）
      const outDir = app.isPackaged
        ? path.join(app.getPath('userData'), 'capture-screenshots')
        : path.join(__dirname, '..', 'screenshots');
      fsx.mkdirSync(outDir, { recursive: true });
      const withTimeout = (p, ms, tag) => Promise.race([
        p,
        new Promise((_res, rej) => setTimeout(() => rej(new Error(tag + ' 超时' + ms + 'ms')), ms))
      ]);
      const shots = [['keepsake-library.png', 'lib'], ['keepsake-subs.png', 'rss'], ['keepsake-home.png', 'tasks']];
      (async () => {
        try {
          await new Promise(r2 => setTimeout(r2, 2500));   // 等首屏数据渲染
          for (const [file, page] of shots) {
            console.log('[capture] 切页 →', page);
            await withTimeout(win.webContents.executeJavaScript(`switchPage('${page}')`), 10000, 'switchPage(' + page + ')');
            await new Promise(r2 => setTimeout(r2, 1800));   // 等该页数据加载
            let img = null;
            try {
              img = await withTimeout(win.webContents.capturePage(), 6000, 'capturePage');
            } catch (ce) {
              console.warn('[capture] capturePage 失败（预期内），改走屏幕捕获:', ce.message);
              img = await captureShot();
            }
            if (!img || img.isEmpty()) throw new Error(page + ' 无可用帧');
            fsx.writeFileSync(path.join(outDir, file), img.toPNG());
            console.log('[capture] OK', file, fsx.statSync(path.join(outDir, file)).size, 'bytes');
          }
          console.log('[capture] ALL-DONE');
        } catch (e) { console.error('[capture] FAIL:', e.message); }
        app.quit();
      })();
    });
    // 看门狗：90 秒无论如何退出，绝不挂死
    setTimeout(() => { console.error('[capture] watchdog 90s 强制退出'); app.exit(1); }, 90000);
  }
  // 导航锁（渲染层失守也不许导航去外站——preload 不在外部页面重新注入，IPC 暴露面收住
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 右键菜单（Electron 默认无）：输入框/可编辑区提供 剪切/复制/粘贴/全选（用户反馈：粘贴栏不支持右键粘贴）
  win.webContents.on('context-menu', (e, params) => {
    if (!params.isEditable) return;
    e.preventDefault();
    Menu.buildFromTemplate([
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' }
    ]).popup({ window: win });
  });
  // 托盘常驻：点关闭 = 弹窗问「最小化到托盘」还是「直接退出」（勾选记住后不再问）
  win.on('close', async e => {
    if (quitting) return;
    if (!tray) { quitting = true; app.quit(); return; }   // 托盘创建失败降级：关窗即退出，防「不可见又退不出」
    const act = settings.get().closeAction;   // 'minimize' | 'exit' | 未设置
    if (act === 'exit') { quitting = true; return; }   // 已记住「直接退出」也必须置位 quitting，否则关窗后 window-all-closed 不触发 app.quit，应用变成无窗口僵尸
    e.preventDefault();
    if (act === 'minimize') { win.hide(); return; }   // 已记住「最小化」：直接隐藏
    const { response, checkboxChecked } = await dialog.showMessageBox(win, {
      type: 'question',
      title: '关闭 Keepsake',
      message: '要最小化到托盘还是直接退出？',
      detail: '最小化到托盘：订阅检查与下载继续在后台运行；直接退出：结束所有任务。',
      buttons: ['最小化到托盘', '直接退出'],
      defaultId: 0, cancelId: 0,
      checkboxLabel: '记住我的选择，不再询问',
      checkboxChecked: false,
      noLink: true
    });
    if (response === 0) {
      win.hide();
      if (checkboxChecked) { settings.set({ closeAction: 'minimize' }); }
      if (Notification.isSupported() && minimizeNotices++ < 2) {
        const n = new Notification({ title: 'Keepsake 已最小化到托盘', body: '订阅检查与下载仍在后台运行，右键托盘图标可退出', silent: true });
        n.show();
      }
    } else {
      if (checkboxChecked) settings.set({ closeAction: 'exit' });
      quitting = true;
      app.quit();
    }
  });
  return win;
}

// 单实例锁：托盘常驻后双击图标容易重复启动
// CAPTURE 截图模式跳过：截图实例用的是隔离 userData，与用户常驻实例本不互斥；
// 而 ProcessSingleton 的锁在 JS setPath 之前就按默认 userData 建（实测），常驻实例活着时
// 截图实例会被误判重复启动 → requestSingleInstanceLock() 返回 false → 静默退出，截图必失败
const gotLock = process.env.KEEPSAKE_CAPTURE || app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); } else {
app.on('second-instance', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });   // 窗口可能已销毁，isDestroyed 守卫防 TypeError

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  pixivauth.installPixivProtocol();   // pixiv:// 内部协议 handler（注册privileged见文件顶部注释）

  // 改名迁移：Fetchie → Keepsake（2026-10-20 品牌改名前的历史数据一次性搬入）
  // 逐文件断点续迁 + 全成功后写标记 + 旧目录改名封存（内含明文 cookies.txt，凭证不散落）
  try {
    migrateLegacyDir('Fetchie', path.join(userData, '.fetchie-migrate-done'),
      ['settings.json', 'cookies.txt', 'tasks.json', 'subs.json', 'site-state.json', 'remote-rules.json'], ['asr-models']);
  } catch (e) { console.log('[migrate] 迁移失败(不影响启动):', e.message); }

  // 改名迁移 v2：DGO → Keepsake（2026-10-20 品牌改名）。除配置文件外连 asr-models/engines
  // （同盘 rename 瞬间完成，引擎免重新下载）与 Local Storage（下载选项偏好）一并迁移
  try {
    migrateLegacyDir('DGO', path.join(userData, '.keepsake-migrate-done'),
      ['settings.json', 'cookies.txt', 'tasks.json', 'subs.json', 'site-state.json', 'remote-rules.json', 'pixiv-auth.json'],
      ['asr-models', 'engines', 'Local Storage']);
  } catch (e) { console.log('[migrate] 迁移失败(不影响启动):', e.message); }

  // 默认下载目录：系统「视频」文件夹下的 Keepsake（藏 AppData 用户找不到文件）。
  // 已有 settings.json 的老用户不受影响（其 outDir 优先）。
  let videosDir = null;
  try { videosDir = app.getPath('videos'); } catch (e) {}
  settings.configure({ file: path.join(userData, 'settings.json'), defaultOutDir: path.join(videosDir || userData, 'Keepsake') });
  log.init(path.join(userData, 'logs'));   // 关键事件落盘 userData/logs/，保留 7 天
  const sc = settings.get();
  ai.configure({ url: sc.aiUrl, key: sc.aiKey, model: sc.aiModel });   // BYOK：OpenAI 兼容接口
  const outDir = settings.get().outDir;   // 下载目录：settings.json 可覆盖默认 userData/downloads
  fs.mkdirSync(outDir, { recursive: true });

  // cookie 文件：登录后写 userData/cookies.txt（打包态 resources 在 asar 内不可写）。
  // 旧版 resources/cookies.txt 存在则一次性迁移。configure 传固定路径——登录成功后文件出现，下游引擎自动带上（existsSync 动态判断）。
  const cookiePath = path.join(userData, 'cookies.txt');
  const legacyCookie = path.join(__dirname, 'resources', 'cookies.txt');
  if (!fs.existsSync(cookiePath) && fs.existsSync(legacyCookie)) {
    try { fs.copyFileSync(legacyCookie, cookiePath); } catch (e) {}
  }

  const enginesDir = path.join(userData, 'engines');   // 可写引擎目录：自更新落这里，spawn 优先取新版
  configure({ binDir: binDir(), enginesDir, cookiePath, outDir, proxy: settings.get().proxy, minFreeMB: settings.get().minFreeMB, maxConcurrent: settings.get().maxConcurrent, rateLimitMB: settings.get().rateLimitMB });
  identify.setBinDir(binDir());
  identify.setCookiePath(cookiePath);   // 登录后识别探针也带 cookie（原先断链，登录对识别无效）
  identify.setProxy(settings.get().proxy);
  strategy.configure({ stateFile: path.join(userData, 'site-state.json') });
  refreshRemoteRules();
  setInterval(refreshRemoteRules, RULES_INTERVAL_MS);
  autoupdate.configure({ binDir: enginesDir, fallbackBinDir: binDir() });   // 更新写 userData/engines（可写），本地版本探测回退随包目录
  store.configure({ userData });
  subs.configure({ binDir: binDir(), cookiePath, file: path.join(userData, 'subs.json') });
  // 浏览器登录态与 CBZ 开关：settings.json 单一来源，引擎参数层即时生效
  const { setCookieBrowser, setAutoCbz } = require('./lib/queue');
  setCookieBrowser(settings.get().cookieBrowser);
  setAutoCbz(settings.get().autoCbz);
  subs.setCookieBrowser(settings.get().cookieBrowser);
  setBiliLine(settings.get().biliLine);
  subs.setBiliLine(settings.get().biliLine);
  // ★★#5 剪贴板监听：复制到链接时自动填入任务输入框。安全边界（机制借鉴 RipMe，clean-room）：
  // 只读文本 + 只填输入框，绝不自动入队——入队必须用户点「加入队列」确认；开关默认关
  let clipWatcher = null;
  function applyClipboardWatch(on) {
    if (on && !clipWatcher) {
      clipWatcher = new ClipWatcher(
        () => { try { return clipboard.readText(); } catch (e) { return ''; } },   // 剪贴板被占等异常静默跳过
        url => {
          log.info('clipboard', '剪贴板检测到链接: ' + url);
          if (win && !win.isDestroyed()) win.webContents.send('clipboard:url', { url });
        }
      );
      clipWatcher.start(1500);
    } else if (!on && clipWatcher) { clipWatcher.stop(); clipWatcher = null; }
  }
  applyClipboardWatch(!!settings.get().clipboardWatch);
  library.configure({ outDir, sourceGet: p => source.get(p) });
  textindex.configure({ file: path.join(userData, 'text-index.json') });   // #70③：文稿全文检索索引
  asr.configure({
    binDir: binDir(), modelsDir: path.join(userData, 'asr-models'),
    onPersist: patch => settings.set(patch)   // 默认模型持久化到 settings.json
  });
  asr.restoreActive(settings.get().asrModel);   // 恢复上次选的默认模型
  if (settings.get().asrMirror) asr.setMirror(settings.get().asrMirror);   // 恢复持久化的模型下载源

  // 转写串行队列：同一时间只跑一个 whisper，避免 CPU 打爆
  let asrChain = Promise.resolve();
  const _asrDownloading = new Set();
  function enqueueTranscribe(mediaPath, source) {
    asrChain = asrChain.then(() => asr.transcribe(mediaPath, {
      onProgress: pct => { if (win && !win.isDestroyed()) win.webContents.send('asr:progress', { filePath: mediaPath, pct, source }); },
      onPhase: phase => { if (win && !win.isDestroyed()) win.webContents.send('asr:phase', { filePath: mediaPath, phase, source }); }
    })).then(r => {
      if (win && !win.isDestroyed()) win.webContents.send('asr:done', { filePath: mediaPath, ...r });
      if (win && !win.isDestroyed()) win.webContents.send('library:changed');
      // 即时 textindex.reindex 已移除——library:scan 里的 reindex 用媒体库分组的
      // g.uploader 作权威 up；此处按父目录猜 up 在三级目录结构下会错记且 mtime 不变永不修正
      // 通知分支补 win 存活守卫（对齐同块其余分支）
      if (win && !win.isDestroyed() && (!win.isVisible() || win.isMinimized()) && Notification.isSupported()) {
        const n = new Notification({ title: '转写完成 ✓', body: path.basename(mediaPath), silent: false });
        n.on('click', () => { if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
        n.show();
      }
      return r;
    }).catch(e => {
      if (win && !win.isDestroyed()) win.webContents.send('asr:error', { filePath: mediaPath, reason: e.message });
      return null;
    });
    return asrChain;
  }

  // ===== 阶段一：双语字幕 / 烧字幕（媒体库 🌐 🎬）=====
  function jobState(p, state, note) {   // 媒体库通用任务状态（翻译/烧字幕），渲染层 jobStates 消费
    if (win && !win.isDestroyed()) win.webContents.send('lib:job', { filePath: p, state, note });
  }
  // 翻译串行链：逐个跑，防并发打爆 AI 接口；无 SRT 时自动先转写（对用户零门槛）
  let srtChain = Promise.resolve();
  function enqueueTranslate(mediaPath) {
    srtChain = srtChain.then(() => translateOne(mediaPath)).catch(e => {
      log.warn('srt', '双语字幕失败 ' + mediaPath + ': ' + e.message);
      jobState(mediaPath, 'error', e.message);
      if (win && !win.isDestroyed()) win.webContents.send('toast:event', { msg: '双语字幕失败：' + String(e.message).slice(0, 100) });
    });
    return srtChain;
  }
  async function translateOne(mediaPath) {
    const base = mediaPath.replace(/\.[^.]+$/, '');
    const srtPath = base + '.srt';
    if (!fs.existsSync(srtPath)) {
      jobState(mediaPath, 'running', '尚无字幕，先本地转写…');
      await asr.transcribe(mediaPath, { onProgress: pct => jobState(mediaPath, 'running', `转写 ${pct}%`) });
    }
    jobState(mediaPath, 'running', '翻译中…');
    const r = await srtLib.translateSrt(srtPath, {
      translator: async (prompt, hint) => ai.run('srtTranslate', hint ? hint + prompt : prompt),
      onProgress: (d, t) => jobState(mediaPath, 'running', `翻译 ${d}/${t} 条`),
    });
    jobState(mediaPath, 'done', r.outFile);
    log.info('srt', `双语字幕完成 ${r.blocks} 条 → ${r.outFile}`);
    toastMsg('双语字幕已生成 ✓ ' + path.basename(r.outFile));
    return r;
  }
  // 烧字幕：优先双语 .zh.srt，否则原 .srt；ffmpeg 硬字幕（libx264 重编码 + 音频直拷）
  function burnSubs(videoPath) {
    return new Promise((resolve, reject) => {
      const base = videoPath.replace(/\.[^.]+$/, '');
      const srt = [base + '.zh.srt', base + '.srt'].find(f => fs.existsSync(f));
      if (!srt) return reject(new Error('该文件还没有字幕，先点 🌐 生成双语字幕'));
      const out = base + '.burned.mp4';
      // subtitles filter 转义：\ → /，: → \:（Windows 盘符），' → \'（filter 引号串）
      const esc = srt.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      const ff = path.join(binDir(), exe('ffmpeg'));
      if (!fs.existsSync(ff)) return reject(new Error('ffmpeg 未就绪'));
      const child = spawn(ff, ['-y', '-i', videoPath, '-vf', `subtitles='${esc}'`, '-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-c:a', 'copy', out], { windowsHide: true });
      let err = '';
      child.stderr.on('data', d => { err += d; });
      child.on('error', e => reject(e));
      child.on('close', code => {
        if (code === 0 && fs.existsSync(out)) return resolve({ ok: true, out });
        const m = err.match(/Error[^\n]*|No such filter[^\n]*|[^\n]*Unable to open[^\n]*/i);
        reject(new Error('烧字幕失败 code=' + code + (m ? ': ' + m[0].slice(0, 120) : '')));
      });
    });
  }
  let burnChain = Promise.resolve();
  function enqueueBurn(videoPath) {
    burnChain = burnChain.then(() => {
      jobState(videoPath, 'running', '烧字幕中（视频重编码，可能几分钟）…');
      return burnSubs(videoPath);
    }).then(r => {
      jobState(videoPath, 'done', r.out);
      log.info('srt', '烧字幕完成 → ' + r.out);
      toastMsg('字幕已烧入视频 ✓ ' + path.basename(r.out));
      if (win && !win.isDestroyed()) win.webContents.send('library:changed');
    }).catch(e => {
      jobState(videoPath, 'error', e.message);
      toastMsg('烧字幕失败：' + String(e.message).slice(0, 100));
    });
    return burnChain;
  }

  // 恢复标记：恢复时已存在的 done 任务不算「新完成」（不触发媒体库刷新）
  const resumedDone = new Set();
  const _errLogged = new Set();   // 已记过失败日志的任务 id（snapshot 是副本，标记存任务对象上无效）
  let _batchDone = [];   // batch 通知模式：累积本轮下载周期完成的任务标题，队列全部空闲时统一弹一条

  queue = new DownloadQueue(snapshot => {
    if (win && !win.isDestroyed()) win.webContents.send('queue:snapshot', snapshot);
    store.save(snapshot);          // 每次状态变化持久化
    // 回溯补位兜底：回溯并发 3 路（不再等队列全空），有回溯结束即补位；
    // 队列每次状态变化都顺带判一次（代价仅是个 while 条件，绝大多数时候直接跳过）
    try { drainBackfills(); } catch (e) {}
    // 媒体库自动刷新：有任务新进 done（排除恢复的存量）
    let freshDone = false;
    const doneTitles = [];
    for (const t of snapshot) {
      if (t.status === 'done' && !resumedDone.has(t.id)) { resumedDone.add(t.id); freshDone = true; doneTitles.push(t.title); log.info('queue', '下载完成: ' + t.title + ' → ' + (t.filePath || '?')); }
      if (t.status === 'error' && !_errLogged.has(t.id)) { _errLogged.add(t.id); log.error('queue', '任务失败: ' + t.title + ' — ' + (t.error || '')); }
    }
      if (freshDone && win && !win.isDestroyed()) {
        win.webContents.send('library:changed');
        // 完成通知（设置页可关/选模式）：notifyMode=each 单项即通知 / batch 全部下载完成后统一通知。
        // 仅窗口隐藏/最小化时弹通知（前台时不打扰）；body 带保存位置（
        const sc = settings.get();
        const notifyOn = sc.notifyDone !== false;
        if (sc.notifyMode === 'batch') {
          _batchDone.push(...doneTitles);
          const busy = snapshot.some(t => ['queued', 'downloading', 'held'].includes(t.status));
          if (!busy && _batchDone.length) {
            const titles = _batchDone;
            _batchDone = [];
            if (notifyOn && (!win.isVisible() || win.isMinimized()) && Notification.isSupported()) {
              const n = new Notification({
                title: `全部下载完成 ✓（${titles.length} 个任务）`,
                body: titles.slice(0, 3).join('、') + (titles.length > 3 ? ` 等 ${titles.length} 个` : '') + '\n保存在：' + sc.outDir,
                silent: false
              });
              n.on('click', () => { if (win) { win.show(); win.focus(); } });
              n.show();
            }
          }
        } else if (notifyOn && (!win.isVisible() || win.isMinimized()) && Notification.isSupported()) {
          const n = new Notification({
            title: freshDone === 1 ? '下载完成 ✓' : `下载完成 ✓（${freshDone} 个任务）`,
            body: doneTitles[0] + (freshDone > 1 ? ` 等 ${freshDone} 个` : '') + '\n保存在：' + sc.outDir,
            silent: false
          });
          n.on('click', () => { if (win) { win.show(); win.focus(); } });
          n.show();
        }
      // 勾了「转写」的任务：下载完成自动转写产物（视频/音频都可，whisper 吃 ffmpeg 提的音轨）
      for (const t of snapshot) {
        if (t.status === 'done' && t._transcribe && t.filePath && !t._transcribed) {
          t._transcribed = true;   // 防重复
          enqueueTranscribe(t.filePath, 'task');
        }
      }
    }
  });

  // 来源索引：任务完成 → 记录产出文件 ↔ 来源链接/订阅标记（媒体库溯源用；老文件无记录，UI 不显示徽标）
  // 注意：必须挂在 queue 创建之后——先前误放创建前，queue 为 null，whenReady 直接炸掉窗口都出不来（实测翻车 2026-10-10）
  queue.onDone = it => {
    const files = (Array.isArray(it._files) && it._files.length) ? it._files : (it.filePath ? [it.filePath] : []);
    if (!files.length) return;
    source.record(files, { url: it.url, via: it._subs ? 'sub' : 'task', subId: it._subId || null, title: it.title });
    log.info('source', `来源记录 ${files.length} 个文件 ← ${it.url}`);
  };

  // 图站任务 CBZ 打包完成提示（打包本身在 queue._maybeCbz 异步进行，这里只管播报）
  queue.onCbz = (it, out) => {
    if (win && !win.isDestroyed()) win.webContents.send('toast:event', { msg: '📦 已打包漫画册：' + path.basename(out) });
    log.info('queue', 'CBZ 打包完成: ' + out);
  };

  // 浏览器登录态预警（任务启动时检测到未装/正在运行，queue 去重后转发）：
  // toast 提醒用户先退出浏览器或换 cookies.txt，别等下载失败/静默游客态才发
  queue.onWarn = msg => toastMsg(msg);

  // ★★#4 崩溃恢复（机制借鉴 Parabolic RecoverableDownload，clean-room）：tasks.json 每次 push 都
  // 落盘（1s 防抖），崩溃/强关时「downloading」状态原样留在盘上——与正常退出（before-quit 先 cancel
  // 再 flush，盘上全是终态）天然区分。这里把中断任务自动重排回队 + 提示用户
  let restoredN = 0;
  for (const raw of store.load()) {
    if (raw.status === 'downloading') { raw.status = 'queued'; raw.error = '应用退出中断，已自动重排'; raw.progress = 0; restoredN++; }
    if (raw.status === 'held') raw.status = 'queued';
    if (raw.status === 'queued') {
      const item = queue.add(raw.url, { engine: raw.engine, title: raw.title, _range: raw._range, _subs: raw._subs, _audio: raw._audio, _transcribe: raw._transcribe, _subId: raw._subId });
      item.filePath = raw.filePath; item.fileCount = raw.fileCount;
      restoredN++;   // 未完成续跑（用户反馈）：排队任务也计入恢复数
    } else {
      queue.items.set(raw.id, raw);
      queue.order.push(raw.id);
      if (raw.status === 'done') resumedDone.add(raw.id);
    }
  }
  if (restoredN) {
    const msg = '已自动继续上次未完成的 ' + restoredN + ' 个任务';
    toastMsg(msg);
    log.info('queue', msg);
  }

  // 订阅改名 → 队列历史任务标题同步（老任务入队时还带着「订阅 N」占位名，改名后追平）
  subs.onNameChange((id, name) => {
    const n = queue.renameSub(id, name);
    if (n && win && !win.isDestroyed()) win.webContents.send('queue:snapshot', queue.snapshot());
  });

  // 发布闸门②配套：安装包不捆绑 gallery-dl（GPL-3.0）与 ffmpeg，首启在线引导下载
  // win：下载 gallery-dl.exe + ffmpeg.exe 到 userData/engines；mac：三件套到 userData/engines
  enginesBoot.ensureEngines(binDir()).then(r => {
    if (r && r.installed && r.installed.length) {
      log.info('boot', 'engines installed: ' + r.installed.join(', '));
      console.log(`[boot] ${process.platform} engines installed:`, r.installed.join(', '));
      toastMsg('首次运行：已下载必需组件 ' + r.installed.join('、') + '，功能全部可用');
    }
    if (r && !r.ok) {
      const bad = Object.keys(r).filter(k => !['ok', 'installed'].includes(k)).map(k => k + ': ' + r[k]).join('; ');
      console.warn('[boot] engines partial fail:', bad);
      toastMsg('部分组件联网下载失败（' + bad.slice(0, 80) + '）。会自动换源重试；也可重启软件再试，或在设置页「从本地文件安装引擎」');
    }
  }).catch(e => {
    console.warn('[boot] engines:', e.message);
    toastMsg('联网下载组件失败：' + (e.message || e).slice(0, 80) + '。重启软件可重试');
  });

  // 引擎自检
  ipcMain.handle('engine:probe', async () => runEngine(binDir()));

  // 手动导入引擎（下载兜底：自动源全挂时，用户从官方页手动下载后本地安装）
  ipcMain.handle('engine:pickLocal', async (e, { engine }) => {
    const name = String(engine || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!name) return { ok: false, reason: '引擎名不合法' };
    const r = await dialog.showOpenDialog(win, {
      title: '选择引擎文件（' + name + '；ffmpeg 可选官方 zip 包）',
      filters: [{ name: '引擎文件', extensions: ['exe', 'zip'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, reason: '已取消' };
    const src = r.filePaths[0];
    const dest = path.join(binDir(), name);
    try {
      if (/\.zip$/i.test(src)) {
        await enginesBoot.winExpand(src, binDir());
        if (!fs.existsSync(dest)) return { ok: false, reason: 'zip 内未找到 ' + name };
      } else {
        fs.copyFileSync(src, dest);
      }
      return { ok: true, dest };
    } catch (e2) { return { ok: false, reason: String(e2.message || e2) }; }
  });

  // 引擎更新（风控对抗第一防线）
  ipcMain.handle('engine:checkUpdate', async () => autoupdate.checkAll());
  ipcMain.handle('engine:applyUpdate', async (e, { engine, url, sha256 }) => {
    // 进度直达渲染层（下载 20~30MB 要几十秒，没进度条用户以为卡死）。
    // 不再拿「队列运行中」挡更新：下载随时可点，只让替换阶段等正被 spawn 的引擎文件解锁
    // （Windows 锁文件，updateEngine 内部重试等，见 autoupdate.js）
    const onProgress = (received, total) => {
      if (win && !win.isDestroyed()) win.webContents.send('engine:progress', { engine, received, total, pct: total ? Math.round(received / total * 100) : null });
    };
    try {
      // ok:true 必须带上：渲染层以 r.ok 判成败——以前裸返 updateEngine 结果（无 ok 字段），
      // 更新成功也报「引擎更新失败：未知原因」（实测实锤：重启后才发现其实装上了）
      const r = await autoupdate.updateEngine(engine, url, onProgress, sha256);
      return { ok: true, ...r };
    } finally {
      if (win && !win.isDestroyed()) win.webContents.send('engine:progress', { engine, done: true });
    }
  });

  // ===== 引擎自动更新：启动 5 分钟后 + 每 24 小时，仅在队列空闲时静默更新 =====
  async function engineAutoUpdateOnce() {
    if (process.platform !== 'win32') return;   // mac 引擎走 engines_boot，无 exe 资产可更
    if (settings.get().engineAutoUpdate === false) return;
    const busy = queue.active > 0 || [...queue.items.values()].some(x => ['queued', 'downloading'].includes(x.status));
    if (busy) return;
    const list = await autoupdate.checkAll().catch(() => null);
    if (!list) return;
    for (const u of list.filter(x => x.needUpdate)) {
      // 防降级：本地是 dev 构建（1.33.0-dev / nightly / master）绝不被自动换回稳定版——
      // dev 是用户主动选的，自动更新只负责稳定通道（0.2.7 双通道后 needUpdate 是字符串不等，dev 本地会误报）
      if (autoupdate.isDevVer(u.local)) continue;
      // 只有稳定版确实比本地新才动（本地 dev→稳定 由用户在设置页手动选）
      const c = autoupdate.cmpVer(u.remote, u.local);
      if (c === null || c <= 0) continue;
      try {
        const r = await autoupdate.updateEngine(u.engine, u.url);
        toastMsg(`${u.engine.replace('.exe', '')} 引擎已自动更新 → ${r.newVersion}`);
      } catch (e) { /* 静默失败，下轮再试 */ }
    }
  }
  setTimeout(() => { engineAutoUpdateOnce(); setInterval(() => engineAutoUpdateOnce(), 24 * 3600 * 1000); }, 5 * 60 * 1000);

  // ===== 软件自身更新（手动检查 + 启动自动检查）=====
  function cmpVer(a, b) {
    const pa = String(a || '').replace(/^v/, '').split('.').map(Number);
    const pb = String(b || '').replace(/^v/, '').split('.');
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }
  async function appCheckUpdate() {
    const updateUrl = settings.get().updateUrl || UPDATE_URL_PRESET;
    if (!updateUrl) return { ok: false, reason: '未配置更新源（设置页填写 updateUrl 后可用）' };
    // cache-busting：Pages/Fastly 有 10 分钟 CDN 缓存，修正清单后旧哈希可能被节点续命——
    // 带 _t 参数强制回源（0.2.15 哈希事故教训：线上改对了，用户拉到的还是缓存旧值）
    const bust = (updateUrl.includes('?') ? '&' : '?') + '_t=' + Date.now();
    const j = await autoupdate.getJsonPublic(updateUrl + bust);
    const remote = j.version;
    if (!remote) return { ok: false, reason: '更新源格式错误（需要 {"version":"x.y.z","url":"安装包下载地址"}）' };
    // 发布闸门③：更新清单必须带 Ed25519 签名，验证失败一律拒绝（防更新通道劫持 = 持久化 RCE）
    if (!updateSign.verify(j)) return { ok: false, reason: '更新清单签名校验失败（非官方发布或被篡改），已拒绝' };
    // 验签通过的清单留存在主进程，安装路径只信这份，不信渲染层回传参数
    _verifiedUpdate = { version: remote, url: j.url || '', sha256: j.sha256 || '' };
    const hasUpdate = cmpVer(remote, app.getVersion()) > 0;
    return { ok: true, hasUpdate, version: remote, current: app.getVersion(), url: j.url || '', notes: j.notes || '', page: j.page || '', sha256: j.sha256 || '' };
  }
  function toastMsg(msg) {
    if (win && !win.isDestroyed()) win.webContents.send('toast:event', { msg });
  }
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:checkUpdate', () => appCheckUpdate());
  // 下载新版安装包 → 静默安装到当前目录 → 自动重启（NSIS /S /D=）
  // url/sha256 一律取自主进程留存验签后的清单，忽略渲染层回传（防渲染层失守被静默装包）
  let _verifiedUpdate = null;
  ipcMain.handle('app:applyUpdate', async () => {
    // 安装前强制重新拉一次清单：_verifiedUpdate 是内存变量，app 长期驻留托盘时
    // 会拿着发版当天之前的旧清单去校验新 exe——线上改对了也照样报「哈希校验失败」
    //（0.2.0 用户实锤：今天上午拉的清单，下午修好线上后没重启就点安装，永远失败）
    try { await appCheckUpdate(); } catch (e) { return { ok: false, reason: '刷新更新清单失败（' + String(e.message || e).slice(0, 80) + '），请检查网络后重试' }; }
    const mu = _verifiedUpdate;
    if (!mu || !mu.url) return { ok: false, reason: '请先在设置页检查更新' };
    if (!mu.sha256) return { ok: false, reason: '更新清单未带 sha256，已拒绝安装（完整性无法验证）' };
    if (queue.active > 0 || [...queue.items.values()].some(x => ['queued', 'downloading'].includes(x.status)))
      return { ok: false, reason: '队列还有任务，完成或清空后再更新软件' };
    const inst = path.join(os.tmpdir(), 'keepsake-setup-' + Date.now() + '.exe');
    await autoupdate.downloadPublic(mu.url, inst);
    const size = fs.existsSync(inst) ? fs.statSync(inst).size : 0;
    if (size < 10 * 1024 * 1024) { try { fs.unlinkSync(inst); } catch (e2) {} return { ok: false, reason: '安装包异常（' + Math.round(size / 1048576) + 'MB），已取消' }; }
    // PE 魔数校验：镜像/被墙网络把网页当文件返回时（200+大 HTML），
    // 明确报「下载到的是网页」而不是误导性的哈希不符
    const mz = Buffer.alloc(2);
    const fd = fs.openSync(inst, 'r'); fs.readSync(fd, mz, 0, 2, 0); fs.closeSync(fd);
    if (mz.toString('hex') !== '4d5a') { try { fs.unlinkSync(inst); } catch (e2) {} return { ok: false, reason: '下载到的不是安装包（可能被网络拦截/重定向到网页），已取消' }; }
    // 发布闸门③：安装包 sha256 与签名清单核对，不一致即销毁。
    // 报错必须带「期望/实得」哈希——排查更新问题最需要的就是实得值（0.2.15 事故教训：
    // 没有实得哈希，同一个报错可能是清单错/下载错/缓存错三种原因，排查绕一大圈）
    if (!(await updateSign.sha256ok(inst, mu.sha256))) {   // sha256ok 为流式 async 版，与签名清单核对
      const got = await autoupdate.sha256File(inst);
      try { fs.unlinkSync(inst); } catch (e2) {}
      return { ok: false, reason: '安装包哈希校验失败（期望 ' + String(mu.sha256).slice(0, 12) + '…，实得 ' + String(got).slice(0, 12) + '…）——多为缓存了旧更新清单，请完全退出应用重新打开后再试，或到 GitHub 页手动下载安装包' };
    }
    // NSIS /D= 必须不带引号（含空格目录也裸写），改用 shell 串拼装
    const dir = path.dirname(process.execPath).replace(/[\\"]+$/, '');
    const child = spawn(`"${inst}" /S /D=${dir}`, { detached: true, stdio: 'ignore', shell: true });
    child.unref();
    setTimeout(() => app.quit(), 1500);   // 给安装器起跑时间后退出
    return { ok: true };
  });
  // 更新源配置（只许写 updateUrl 字段，防 renderer 被攻破时改其它配置）
  ipcMain.handle('settings:setUpdateUrl', (e, { url }) => { settings.set({ updateUrl: String(url || '').trim() }); return { ok: true }; });
  ipcMain.handle('settings:setEngineAuto', (e, { on }) => { settings.set({ engineAutoUpdate: !!on }); return { ok: true }; });
  // 开机自启动（用户反馈）：settings.autoStart → 系统 login item。
  // dev 下 process.execPath 是 electron.exe，注册了也没意义 → 只记设置不注册（诚实返回）
  function applyAutoStart() {
    if (!app.isPackaged) return;
    try { app.setLoginItemSettings({ openAtLogin: !!settings.get().autoStart, path: process.execPath, args: [] }); }
    catch (e) { console.warn('[autostart]', e.message); }
  }
  applyAutoStart();
  ipcMain.handle('settings:setAutoStart', (e, { on }) => {
    settings.set({ autoStart: !!on });
    applyAutoStart();
    if (!app.isPackaged) return { ok: true, openAtLogin: false, dev: true };
    const cur = app.getLoginItemSettings();
    return { ok: cur.openAtLogin === !!on, openAtLogin: cur.openAtLogin };
  });
  // 通知设置：on=是否弹下载完成通知；mode=each 单项即通知 / batch 全部完成后统一通知
  ipcMain.handle('settings:setNotify', (e, { on, mode }) => {
    settings.set({ notifyDone: on !== false, notifyMode: mode === 'batch' ? 'batch' : 'each' });
    return { ok: true };
  });
  // #70① 磁盘挂起阈值设置（0=关闭检测）
  ipcMain.handle('settings:setMinFree', (e, { mb }) => {
    const mbN = Math.max(0, Math.floor(Number(mb) || 0));
    settings.set({ minFreeMB: mbN });
    configure({ minFreeMB: mbN });   // 热更新必须调模块级 configure——DownloadQueue 实例没有 reconfigure 方法
    return { ok: true, minFreeMB: mbN };
  });
  // 并发数/限速设置（v0.1.9：队列参数进设置页，外部
  // 浏览器登录态：设了浏览器 → 引擎 --cookies-from-browser 直读（免导出 cookies.txt）；清空回落 cookies.txt
  ipcMain.handle('settings:setCookieBrowser', (e, { b }) => {
    const r = settings.set({ cookieBrowser: String(b || '') });
    setCookieBrowser(r.cookieBrowser);
    subs.setCookieBrowser(r.cookieBrowser);
    // 选了未安装/正在运行的浏览器 → 立刻口头提醒（切完等下载才暴露就太晚了）
    const warning = r.cookieBrowser ? cookieBrowserWarning(r.cookieBrowser) : null;
    if (warning) toastMsg(warning);
    return { ok: true, cookieBrowser: r.cookieBrowser, warning: warning || undefined };
  });
  // B站 线路/CDN 手动选线（#15）：热更新进下载参数（前向兼容钩子，待 yt-dlp 支持 cdn extractor-arg 生效）
  ipcMain.handle('settings:setBiliLine', (e, { line }) => {
    const r = settings.set({ biliLine: String(line || '') });
    setBiliLine(r.biliLine);
    subs.setBiliLine(r.biliLine);
    return { ok: true, biliLine: r.biliLine };
  });
  // 图站任务完成后自动打包 CBZ（漫画归档）
  ipcMain.handle('settings:setCbz', (e, { on }) => {
    const r = settings.set({ autoCbz: !!on });
    setAutoCbz(r.autoCbz);
    return { ok: true, autoCbz: r.autoCbz };
  });
  // ★★#5 剪贴板监听开关（热启停：开=启动轮询，关=停止并丢弃实例）
  ipcMain.handle('settings:setClipboard', (e, { on }) => {
    const r = settings.set({ clipboardWatch: !!on });
    applyClipboardWatch(r.clipboardWatch);
    return { ok: true, clipboardWatch: r.clipboardWatch };
  });
  ipcMain.handle('settings:setQueue', (e, { max, rate }) => {
    const maxN = Math.min(5, Math.max(1, Math.floor(Number(max) || 2)));
    const rateN = Math.min(100, Math.max(0, Math.floor(Number(rate) || 0)));
    settings.set({ maxConcurrent: maxN, rateLimitMB: rateN });
    configure({ maxConcurrent: maxN, rateLimitMB: rateN });
    try { queue.tick(); } catch (er) {}   // 调大并发立即补位启动排队任务（调小由 tick 自然收敛）
    return { ok: true, maxConcurrent: maxN, rateLimitMB: rateN };
  });
  // #70① 数据安全包：导出（用户选路径存 JSON）/ 导入（选文件 → 设置覆盖合并 + 订阅按 URL 合并）
  ipcMain.handle('settings:export', async () => {
    try {
      const r = await dialog.showSaveDialog(win, {
        title: '导出 Keepsake 迁移包',
        defaultPath: 'Keepsake-迁移包-' + new Date().toISOString().slice(0, 10) + '.json',
        filters: [{ name: 'Keepsake 迁移包', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, reason: '已取消' };
      const bundle = backup.collect({ settingsFile: path.join(app.getPath('userData'), 'settings.json'), subsFile: path.join(app.getPath('userData'), 'subs.json') });
      if (!bundle.ok) return bundle;
      atomicWrite(r.filePath, JSON.stringify(bundle.bundle, null, 2));   // tmp+rename，磁盘满不再留半截 JSON
      log.info('backup', `导出迁移包 → ${r.filePath}（${bundle.counts.subs} 个订阅）`);
      return { ok: true, file: r.filePath, counts: bundle.counts };
    } catch (e) { return { ok: false, reason: e.message }; }
  });
  ipcMain.handle('settings:import', async () => {
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '导入 Keepsake 迁移包', properties: ['openFile'],
        filters: [{ name: 'Keepsake 迁移包', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, reason: '已取消' };
      const bundle = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf-8'));
      // 导入前明示影响面（覆盖设置项数 / 订阅数 / AI 密钥），用户确认才执行
      const bs = (bundle && bundle.settings) || {};
      const pendingKeys = backup.SETTINGS_KEYS.filter(k => bs[k] !== undefined && bs[k] !== null && bs[k] !== '');
      const pendingSubs = Array.isArray(bundle.subs) ? bundle.subs.filter(x => x && typeof x === 'object' && String(x.url || '').trim()).length : 0;
      const mb = await dialog.showMessageBox(win, {
        type: 'warning',
        title: '确认导入迁移包',
        message: `将覆盖 ${pendingKeys.length} 项设置${pendingKeys.includes('aiUrl') || pendingKeys.includes('aiKey') ? '（含 AI 接口地址/密钥）' : ''}，并合并 ${pendingSubs} 个订阅。`,
        detail: '覆盖项包括 AI Key 明文等接口配置；已有订阅按 URL 去重跳过，现有数据不会被删除。',
        buttons: ['取消', '导入'],
        defaultId: 0, cancelId: 0, noLink: true,
      });
      if (mb.response !== 1) return { ok: false, reason: '已取消' };
      const setterErrors = [];   // settingsSetter 内校验失败的键经此上报（apply 的 errors 数组此时还没返回）
      let droppedOutDir = false;
      const out = await backup.apply(bundle, {
        settingsSetter: patch => {
          const p = { ...patch };
          // outDir 导入前先过目录校验，失败剔除该键（不写坏目录）
          if (p.outDir !== undefined) {
            const v = settings.validateDir(p.outDir);
            if (!v.ok) { delete p.outDir; droppedOutDir = true; setterErrors.push('outDir: 目录不可写（' + v.reason + '），已保留当前下载目录'); }
          }
          settings.set(p);
          if (p.aiUrl !== undefined || p.aiKey !== undefined || p.aiModel !== undefined) {
            const c = settings.get(); ai.configure({ url: c.aiUrl, key: c.aiKey, model: c.aiModel });
          }
          if (p.minFreeMB !== undefined) configure({ minFreeMB: p.minFreeMB });   // 模块级 configure（实例无 reconfigure）
          if (p.maxConcurrent !== undefined || p.rateLimitMB !== undefined) {
            const c = settings.get();
            configure({ maxConcurrent: c.maxConcurrent, rateLimitMB: c.rateLimitMB });   // v0.1.9：队列参数导入后热更新
            try { queue.tick(); } catch (er) {}
          }
          // 换目录即时生效（对齐 settings:pickDir：模块级 configure 更新 OUTDIR + library 重挂 outDir）
          if (p.outDir !== undefined) {
            configure({ outDir: p.outDir });
            library.configure({ outDir: p.outDir, sourceGet: pp => source.get(pp) });
          }
        },
        subsAdd: (url, name, extra) => {
          const a = subs.add(url, name);
          // 迁移包内订阅属性（分组/频率/暂停/自动转写）随添加恢复；subs.update 白名单钳制类型
          if (a.ok && extra && typeof extra === 'object') {
            const u = subs.update(a.sub.id, extra);
            if (u && u.ok && u.sub) a.sub = { ...a.sub, group: u.sub.group, intervalMin: u.sub.intervalMin, userPaused: u.sub.userPaused, autoTranscribe: u.sub.autoTranscribe };
          }
          if (a.ok) checkAllSubs(a.sub.id).catch(() => {});
          return a;
        },
        subsUrls: subs.list().map(su => su.url),
      });
      if (out.ok) {
        if (droppedOutDir) out.settingsApplied = Math.max(0, out.settingsApplied - 1);   // 被剔除的键不计入成功数
        if (setterErrors.length) out.errors.push(...setterErrors);
        log.info('backup', `导入迁移包：设置 ${out.settingsApplied} 项，订阅 +${out.subsAdded}（跳过 ${out.subsSkipped}）`);
      }
      return out;
    } catch (e) { return { ok: false, reason: '导入失败: ' + e.message }; }
  });
  // #70③ 文稿全文搜索
  ipcMain.handle('text:search', (e, { q, limit }) => {
    const lim = Math.min(100, Math.max(1, Number(limit) || 30));   // limit 钳制，防渲染层传大值放大 snippet 读盘
    return { ok: true, results: textindex.search(q, lim), stats: textindex.stats() };
  });
  // #70④ 组级 AI 摘要：收集组内转写文稿（cap 20 篇 × 8k 字）→ AI 结构化总结 → 存组目录 AI摘要-日期.md
  ipcMain.handle('lib:summarize', async (e, { key, paths }) => {
    if (!ai.ready()) return { ok: false, reason: '请先在设置页配置 AI 接口（地址 / Key / 模型）' };
    // 不再全量重扫媒体库——文件清单由渲染层传入，逐个过 insideOutDir 校验防路径注入
    const list = (Array.isArray(paths) ? paths : []).map(p => insideOutDir(p)).filter(Boolean);
    if (!list.length) return { ok: false, reason: '分组不存在或没有有效文件' };
    const txts = [];
    for (const p of list) {
      const t = p.replace(/\.[^.\\/]+$/, '') + '.txt';
      if (!fs.existsSync(t)) continue;
      try { txts.push({ name: path.basename(p), text: fs.readFileSync(t, 'utf-8').slice(0, 8000) }); } catch (e2) {}
      if (txts.length >= 20) break;   // 防超长+费用失控
    }
    if (!txts.length) return { ok: false, reason: '该组还没有转写文稿——先点「📝 全组转写」' };
    const content = txts.map(t => `## ${t.name.replace(/\.[^.]+$/, '')}\n${t.text}`).join('\n\n');
    const md = await ai.run('groupSummary', content);
    // 组目录取第一个有效 path 的 dirname
    const outFile = path.join(path.dirname(list[0]), `AI摘要-${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(outFile, md, 'utf-8');
    log.info('ai', `组级摘要完成（${key || '未分组'}，${txts.length} 篇）→ ${outFile}`);
    if (win && !win.isDestroyed()) win.webContents.send('library:changed');
    return { ok: true, out: outFile, md, docs: txts.length };
  });
  // 启动 30 秒后自动检查软件更新（可在 settings.json 关：appAutoUpdate=false）
  setTimeout(async () => {
    if (settings.get().appAutoUpdate === false) return;
    const r = await appCheckUpdate().catch(() => null);
    if (r && r.ok && r.hasUpdate) toastMsg(`发现新版本 Keepsake ${r.version}（当前 ${r.current}）— 设置页可一键更新`);
  }, 30 * 1000);


  // 策略快照（UI 显示各站风控档位）
  ipcMain.handle('strategy:snapshot', () => strategy.snapshot());
  // 手动立即更新远程风控规则（UI「⟳ 更新策略」按钮）
  ipcMain.handle('strategy:refresh', () => refreshRemoteRules());
  ipcMain.handle('strategy:version', () => ({ version: _rulesVersion, url: RULES_URL }));

  // 识别 / 队列
  ipcMain.handle('link:identify', async (e, url) => identify.identify(url));
  ipcMain.handle('queue:add', async (e, { urls, opts }) => {
    const added = [];
    const duplicates = [];
    const invalid = [];
    for (const url of (Array.isArray(urls) ? urls : [urls])) {
      if (!url || !url.trim()) continue;
      const meta = await identify.identify(url.trim());
      if (meta.engine === 'invalid') {   // 识别失败的链接不再入队跑一遍注定失败的任务
        invalid.push({ url: url.trim(), reason: meta.reason || '无法识别' });
        continue;
      }
      if (meta.engine === 'feed') {   // feed 不是单篇内容：入队必然失败，提前指路订阅页
        invalid.push({ url: url.trim(), reason: '这是 RSS 订阅源：到「📡 订阅」页粘贴添加，更新即自动下载' });
        continue;
      }
      const item = queue.add(url.trim(), { ...meta, _subs: !!(opts && opts.subs), _audio: !!(opts && opts.audio), _transcribe: !!(opts && opts.trans) });
      if (!item) continue;
      if (item.duplicate) duplicates.push(url.trim());
      else added.push(item.id);
    }
    return { added, duplicates, invalid };
  });
  ipcMain.handle('queue:cancel', (e, { id }) => queue.cancel(id));
  ipcMain.handle('queue:retry', (e, { id }) => queue.retry(id));
  // 删除任务记录（不动磁盘文件）/ 清空全部已完-失败记录
  ipcMain.handle('queue:remove', (e, { id }) => queue.remove(id));
  ipcMain.handle('queue:clearFinished', () => queue.clearFinished());
  ipcMain.handle('queue:snapshot', () => queue.snapshot());
  ipcMain.handle('app:outDir', () => settings.get().outDir);

  // ===== 设置 =====
  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:pickDir', async () => {
    // 不绑主窗口（窗口可能处于托盘隐藏状态导致对话框弹不出），用顶层对话框
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择下载保存目录', defaultPath: settings.get().outDir });
    if (r.canceled || !r.filePaths.length) return { ok: false, reason: '已取消' };
    const dir = r.filePaths[0];
    const v = settings.validateDir(dir);
    if (!v.ok) return { ok: false, reason: '目录不可写：' + v.reason };
    const s = settings.set({ outDir: dir });
    // 即时切换新任务的输出目录（运行中任务沿用开始时的目录）。
    // 注意：必须调模块级 configure（支持 outDir/proxy/minFreeMB 热更新），不能调实例 queue.configure/reconfigure——DownloadQueue 没有实例方法
    configure({ outDir: dir });
    library.configure({ outDir: dir, sourceGet: p => source.get(p) });   // 换目录后来源索引照常可用（按绝对路径匹配）
    return { ok: true, outDir: s.outDir };
  });
  // 网络代理（YouTube 等被墙站点必需）：即时生效于探针/下载引擎/订阅检查
  ipcMain.handle('settings:setProxy', (e, { proxy }) => {
    const p = String(proxy || '').trim();
    if (p && !/^https?:\/\/\S+|^socks5:\/\/\S+/i.test(p)) return { ok: false, reason: '格式示例：http://127.0.0.1:7890 或 socks5://127.0.0.1:7890' };
    settings.set({ proxy: p });
    configure({ proxy: p });
    identify.setProxy(p);
    subs.setProxy(p);
    return { ok: true, proxy: p };
  });

  // ===== Cookie 管理（多站点通用，Netscape 格式合并导入）=====
  function cookieFile() { return path.join(userData, 'cookies.txt'); }
  ipcMain.handle('cookie:info', () => {
    const domains = new Set();
    try {
      for (const line of fs.readFileSync(cookieFile(), 'utf-8').split('\n')) {
        const p = line.replace(/^#HttpOnly_/, '').split('\t');
        if (p.length >= 7 && p[0].trim().startsWith('.')) domains.add(p[0].trim());
      }
    } catch (e) {}
    return { file: cookieFile(), domains: [...domains].sort() };
  });
  ipcMain.handle('cookie:import', async () => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    const r = await dialog.showOpenDialog({ properties: ['openFile'], title: '选择导出的 cookies.txt（Netscape 格式）', filters: [{ name: 'cookies.txt', extensions: ['txt'] }] });
    if (r.canceled || !r.filePaths.length) return { ok: false, reason: '已取消' };
    const target = cookieFile();
    // 合并：现有 cookie 为底，导入的按 (domain, path, name) 覆盖 → B 站登录态不会被误删
    const map = new Map();
    const readNetscape = file => {
      let text = '';
      try { text = fs.readFileSync(file, 'utf-8'); } catch (e) { return; }
      for (const raw of text.split('\n')) {
        let line = raw.trim();
        if (!line) continue;
        const httpOnly = line.startsWith('#HttpOnly_');
        if (line.startsWith('#') && !httpOnly) continue;   // 跳过注释（#HttpOnly_ 是合法 cookie）
        const body = (httpOnly ? line.slice('#HttpOnly_'.length) : line).split('\t');
        if (body.length >= 7) map.set(body[0] + '|' + body[2] + '|' + body[5], (httpOnly ? '#HttpOnly_' : '') + body.join('\t'));
      }
    };
    readNetscape(target);
    readNetscape(r.filePaths[0]);
    try { fs.writeFileSync(target, [...map.values()].join('\n') + '\n'); }
    catch (e) { return { ok: false, reason: e.message }; }
    subs.resetCookieCache();   // 域清单缓存失效：订阅添加时的「需要 cookie」提醒要按最新文件判断
    return { ok: true, count: map.size };
  });
  ipcMain.handle('cookie:openDir', () => {
    const f = cookieFile();
    if (!fs.existsSync(f)) { fs.writeFileSync(f, '# Netscape HTTP Cookie File\n'); }
    shell.showItemInFolder(f);
    return { ok: true };
  });
  // ===== 浏览器登录态一键读取闭环（#12，不做 VSS）=====
  function safeSize(f) { try { return fs.statSync(f).size; } catch (e) { return 0; } }
  function countCookies(f) {
    let n = 0;
    try { for (const l of fs.readFileSync(f, 'utf-8').split('\n')) { const p = l.replace(/^#HttpOnly_/, '').split('\t'); if (p.length >= 7 && p[0].trim().startsWith('.')) n++; } } catch (e) {}
    return n;
  }
  // 返回当前所选浏览器的安装/运行状态 + 人话预警（renderer 据此展示按钮与提示）
  ipcMain.handle('cookie:state', () => {
    const b = settings.get().cookieBrowser;
    if (!b) return { browser: '', installed: false, running: false, warning: null };
    const st = browserState(b);
    return { browser: b, name: st.name, installed: st.installed, running: st.running, warning: cookieBrowserWarning(b) };
  });
  // 一键读取：用 yt-dlp 把浏览器登录态导出到现有 cookies.txt（复用落盘路径；浏览器运行时锁文件则友好报错）
  ipcMain.handle('cookie:readBrowser', async () => {
    const b = settings.get().cookieBrowser;
    if (!b) return { ok: false, reason: '请先在「浏览器登录态」里选择已登录的浏览器' };
    const st = browserState(b);
    if (!st.installed) return { ok: false, reason: '未检测到已安装的 ' + st.name + '，无法读取登录态' };
    if (st.running) return { ok: false, reason: st.name + ' 正在运行，Windows 锁定了 Cookie 文件——请先在任务管理器结束 ' + st.exe + ' 进程后再读取' };
    const target = cookieFile();
    const before = safeSize(target);
    return await new Promise(resolve => {
      // yt-dlp 的 --cookies FILE 语义是「读入并 dump cookie jar 进 FILE」：把浏览器登录态合并导出到现有 cookies.txt。
      // 注意：不能用 --simulate（其语义是「不向磁盘写任何东西」，会连同 cookie jar 一起禁止落盘，功能悄悄变 no-op）；
      // 仅用 --skip-download（不下载媒体但允许写入相关文件，含 cookie jar），确保登录态真正导出。
      const child = spawn(path.join(binDir(), exe('yt-dlp')), [
        '--cookies-from-browser', b, '--cookies', target,
        '--no-warnings', '--skip-download', 'https://www.bilibili.com/',
      ], { windowsHide: true });
      let err = '';
      const dec = new TextDecoder('utf-8');
      child.stderr.on('data', d => { err += dec.decode(d, { stream: true }); });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve({ ok: false, reason: '读取超时（45s），请确认浏览器已完全退出后重试' }); }, 45000);
      child.on('error', e => { clearTimeout(timer); resolve({ ok: false, reason: '启动 yt-dlp 失败：' + e.message }); });
      child.on('close', code => {
        clearTimeout(timer);
        const lock = /Could not copy Chrome cookie database/i.test(err) || /Permission denied[^\n]*\bCookies\b/i.test(err);
        if (lock) return resolve({ ok: false, reason: st.name + ' 仍在运行或 Cookie 文件被锁——请完全退出浏览器后重试' });
        const after = safeSize(target);
        const hasBili = fs.existsSync(target) && /bilibili\.com/i.test(fs.readFileSync(target, 'utf-8'));
        if (after > before || hasBili) {
          try { subs.resetCookieCache(); } catch (e) {}   // 域清单缓存失效：订阅添加时的「需要 cookie」提醒按最新文件判断
          return resolve({ ok: true, count: countCookies(target) });
        }
        if (code !== 0) return resolve({ ok: false, reason: (err.split('\n').find(l => /error/i.test(l)) || ('yt-dlp 退出码 ' + code)).slice(0, 120) });
        resolve({ ok: true, count: countCookies(target) });
      });
    });
  });

  // ===== Pixiv OAuth 授权（gallery-dl 的 Pixiv 通道只认 refresh-token，cookie 完全无效——2026-10-17 实测）=====
  ipcMain.handle('pixiv:login', async () => {
    const r = await pixivauth.pixivLogin(userData, { cookieFile: cookieFile(), proxy: settings.get().proxy });
    if (r.ok) log.info('subs', `Pixiv 授权成功：${r.userName || ''}`);
    return r;
  });
  ipcMain.handle('pixiv:state', () => pixivauth.pixivState(userData));

  // ===== 媒体库（只读索引，永不删除文件）=====
  ipcMain.handle('library:scan', async () => {
    const r = await library.scan();
    // #70③：顺带增量重建文稿索引（扫描结果里全是媒体文件，文稿=同名 .txt；mtime 没变的跳过）
    // 文章条目（kind=article）：索引本体是 article.md，key 用目录路径（渲染层按条目 path 命中徽标）
    try {
      const entries = [];
      for (const g of r.groups) for (const f of g.files) {
        if (f.kind === 'article') entries.push({ path: f.path, src: path.join(f.path, 'article.md'), key: f.path, title: f.name, up: g.uploader });
        else entries.push({ path: f.path, title: f.name, up: g.uploader });
      }
      const s = textindex.reindex(entries);
      if (s.indexed) log.info('textindex', `文稿索引更新 ${s.indexed} 篇（共 ${textindex.stats().docs} 篇）`);
    } catch (e) { log.warn('textindex', '索引更新失败: ' + e.message); }
    return r;
  });
  // 路径必须落在下载目录内（startsWith 前缀匹配可被 downloads-evil 同前缀路径绕过，改 path.relative）
  // 目录本身也放行（rel === ''）：订阅卡片的「打开下载文件夹」用
  function insideOutDir(p) {
    const outDir = path.resolve(settings.get().outDir).toLowerCase();
    const resolved = path.resolve(String(p || ''));
    const rel = path.relative(outDir, resolved.toLowerCase());
    return (rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel))) ? resolved : null;
  }
  // 允许打开的目录范围扩展（#18）：除下载目录外，再放行 userData 下的安全子目录（engines / asr-models），
  // 供「打开引擎目录 / 模型目录」用。path.relative 规范化，防 ../ 越界与符号链接逃逸。
  function insideAllowedDir(p) {
    const out = insideOutDir(p);
    if (out) return out;
    const ud = app.getPath('userData');
    const resolved = path.resolve(String(p || ''));          // 返回保持原始大小写（mac/linux 路径大小写敏感）
    const resolvedLower = resolved.toLowerCase();
    for (const sub of ['engines', 'asr-models']) {
      const root = path.resolve(ud, sub).toLowerCase();
      const rel = path.relative(root, resolvedLower);         // 比较统一小写，防 ../ 越界与符号链接逃逸
      if (rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel))) return resolved;
    }
    return null;
  }
  // 退出双保险（#19）：清掉可能残留的引擎子进程（队列 killRunning 之外再兜底一层，防退出后进程树孤儿）
  function killEngineSubprocesses() {
    const cp = require('child_process');
    if (process.platform === 'win32') {
      cp.spawn('taskkill', ['/F', '/T', '/IM', 'yt-dlp.exe', '/IM', 'gallery-dl.exe', '/IM', 'ffmpeg.exe', '/IM', 'whisper.exe'],
        { windowsHide: true, stdio: 'ignore' });
    } else {
      cp.spawn('pkill', ['-f', 'yt-dlp|gallery-dl|ffmpeg|whisper'], { stdio: 'ignore' });
    }
  }
  // 改名迁移通用函数（#27）：把 legacyName 目录下的 files（逐文件拷贝，断点续迁）/ dirs（同盘改名）搬入 userData。
  // 关键加固：仅当所有拷贝/改名都成功才写 doneMark 并封存旧目录——否则不写标记，下次启动自动重试，
  // 避免「标记已写但实际有文件漏迁」导致用户数据丢失（旧实现弱点在 doneMark 写在拷贝前、且失败也照写）。
  function migrateLegacyDir(legacyName, doneMark, files, dirs) {
    const userData = app.getPath('userData');
    const legacy = path.join(path.dirname(userData), legacyName);
    if (!fs.existsSync(legacy) || fs.existsSync(doneMark)) return;
    let ok = true;
    for (const f of files) {
      const s = path.join(legacy, f), d = path.join(userData, f);
      if (fs.existsSync(s) && !fs.existsSync(d)) {
        try { fs.copyFileSync(s, d); } catch (e) { console.warn('[migrate] copy fail:', f, e.message); ok = false; }
      }
    }
    for (const dir of dirs) {
      const s = path.join(legacy, dir), d = path.join(userData, dir);
      if (fs.existsSync(s) && !fs.existsSync(d)) {
        try { fs.renameSync(s, d); } catch (e) { console.warn('[migrate] rename fail:', dir, e.message); ok = false; }
      }
    }
    if (!ok) { console.log('[migrate] ' + legacyName + ' 部分迁移失败，不写完成标记，下次启动重试'); return; }
    try { fs.writeFileSync(doneMark, String(Date.now())); } catch (e) {}
    try { fs.renameSync(legacy, legacy + '.migrated-bak'); }   // 封存旧目录（内含明文 cookies.txt，凭证不散落）
    catch (e) { try { fs.unlinkSync(path.join(legacy, 'cookies.txt')); } catch (e2) {} }   // 改名不成至少删明文凭证
    console.log('[migrate] ' + legacyName + ' → Keepsake 数据迁移完成');
  }
  // ===== AI 文稿后处理（BYOK：任意 OpenAI 兼容接口，key 存本地 settings.json）=====
  ipcMain.handle('ai:getConfig', () => {
    const c = settings.get();
    return { url: c.aiUrl || '', key: c.aiKey || '', model: c.aiModel || '', ready: ai.ready() };
  });
  ipcMain.handle('ai:saveConfig', (e, cfg) => {
    settings.set({ aiUrl: String(cfg.url || '').trim(), aiKey: String(cfg.key || '').trim(), aiModel: String(cfg.model || '').trim() });
    const c = settings.get();
    ai.configure({ url: c.aiUrl, key: c.aiKey, model: c.aiModel });
    return { ok: true, ready: ai.ready() };
  });
  // 拉取模型列表：只读 settings 的 aiUrl/aiKey，避免依赖 CFG 是否最新（ai.js 的 fetchModels 自行处理 GET + 解析 + 兜底）
  ipcMain.handle('ai:fetchModels', () => {
    const s = settings.get();
    return ai.fetchModels(s.aiUrl, s.aiKey);
  });
  // 对已转写的媒体文件跑 AI：读同名 .txt（或 .srt），结果存同名 .ai.md
  // 补 insideOutDir 校验（同文件其他文件操作都有，唯独这里漏了 → 越界读写）
  ipcMain.handle('ai:run', async (e, { p, task }) => {
    try {
      const base = String(p || '').replace(/\.[^.]+$/, '');
      if (!insideOutDir(base)) return { ok: false, reason: '路径不在下载目录内' };
      const src = [base + '.txt', base + '.srt'].find(f => fs.existsSync(f));
      if (!src) return { ok: false, reason: '先转写出文字稿（📝）再跑 AI' };
      const text = fs.readFileSync(src, 'utf-8');
      const out = await ai.run(task, text);
      const outFile = base + '.ai.md';
      fs.writeFileSync(outFile, out);
      if (win && !win.isDestroyed()) win.webContents.send('library:changed');
      return { ok: true, text: out, file: outFile };
    } catch (err) { return { ok: false, reason: String(err.message || err).slice(0, 200) }; }
  });

  // 打开外部链接（订阅「源头已删除」明细点回源用）：白名单域名，防渲染层被诱导开任意 URL。
  // 改用 URL 解析锚定主机名——原前缀正则可被 https://evil-bilibili.com/ 这类字符串绕过
  ipcMain.handle('app:openExternal', (e, url) => {
    let u = null;
    try { u = new URL(String(url || '')); } catch (err) { return { ok: false, reason: '非白名单链接' }; }
    if (u.protocol !== 'https:') return { ok: false, reason: '非白名单链接' };
    const ALLOW_HOSTS = ['bilibili.com', 'x.com', 'twitter.com', 'youtube.com', 'pixiv.net', 'weibo.com',
      'danbooru.donmai.us', 'gelbooru.com', 'yande.re', 'konachan.com', 'konachan.net', 'artstation.com',
      'deviantart.com', 'imgur.com', 'flickr.com', 'tumblr.com', 'reddit.com', 'tiktok.com', 'instagram.com',
      'github.com', 'gist.github.com'];   // github.com：更新弹窗「去 GitHub 下载」用
    const host = u.hostname.toLowerCase();
    const ok = ALLOW_HOSTS.some(h => host === h || host.endsWith('.' + h)) || /^pinterest\.\w+$/.test(host);
    if (!ok) return { ok: false, reason: '非白名单链接' };
    shell.openExternal(u.href);   // 用已校验过的规范化 URL，杜绝传入字符串被二次解析绕过
    return { ok: true };
  });

  // 打开文件夹/定位文件：只允许操作下载目录内部的路径（防任意路径注入）
  ipcMain.handle('app:openFolder', (e, p) => {
    const resolved = insideAllowedDir(p);
    if (!resolved) return { ok: false, reason: '只允许打开下载目录或引擎/模型目录内的路径' };
    let st = null;
    try { st = fs.statSync(resolved); } catch { return { ok: false, reason: '路径不存在' }; }
    if (st.isFile()) { shell.showItemInFolder(resolved); return { ok: true }; }
    return shell.openPath(resolved).then(err => err ? { ok: false, reason: err } : { ok: true });
  });

  // ===== 订阅（RSS）=====
  // 串行化队列——定时轮/手动检查/添加订阅触发的首检全部排队执行，不再互相吞掉。
  // 原实现用 _checkingSubs 布尔互斥，冲突时静默 return []：订阅添加触发的首检被吞，基线建立延迟到下个 10 分钟轮
  let _subChain = Promise.resolve([]);
  function checkAllSubs(onlyId = null) {
    const run = _subChain.then(() => doCheckAllSubs(onlyId));
    _subChain = run.then(() => {}, () => []);
    return run;
  }
  // 订阅关键词过滤：kw 为空=全收；否则标题/文件名含任一关键词才入队（known 照常记录，不影响增量比对）
  function kwMatch(sub, text) {
    if (!sub.kw || !sub.kw.length) return true;
    const t = String(text || '').toLowerCase();
    return sub.kw.some(k => t.includes(String(k).toLowerCase()));
  }
  // feed 条目链接 → 引擎分流（RSS 语义）：视频/图站/直连按现有 identify 规则走对应引擎，
  // 不硬塞 article（博客 feed 里混播客/视频也能走对）；剩余 unknown（普通网页）→ article 引擎
  // （RSS 订阅的本意就是文字内容，article 引擎有 Readability 兜底，覆盖绝大多数博客文章页）
  function engineForFeedItem(url) {
    const cls = identify.classify(url);
    if (cls.engine === 'yt-dlp' || cls.engine === 'gallery-dl' || cls.engine === 'direct') return cls.engine;
    return 'article';
  }
  async function doCheckAllSubs(onlyId) {
    try {
      const results = [];
      for (const sub of subs.list()) {
        if (onlyId && sub.id !== onlyId) continue;
        const real = subs.get(sub.id);
        if (real.userPaused) { results.push({ id: sub.id, ok: false, reason: '已暂停（手动）' }); continue; }   // #70②
        if (real.paused) {
          // 手动单查自动解除连续失败暂停：cookie/授权修好后用户点 ⟳ 应立即生效，而非强制先点 ▶ 恢复。
          // 根因场景：IG 订阅在没 cookie 时期被 failStreak≥3 自动暂停，cookie 导入后点 ⟳ 仍被这里拦住（实测）
          if (onlyId === sub.id) { real.paused = false; real.failStreak = 0; real.lastError = null; subs.save(); }
          else { results.push({ id: sub.id, ok: false, reason: '已暂停（连续失败）' }); continue; }
        }
        // #70② 频率档位：订阅可设更长间隔（10/30/60 分钟）；手动单查（onlyId）不受限
        if (!onlyId && real.intervalMin > CHECK_INTERVAL_MS / 60000 &&
            Date.now() - (real.lastCheck || 0) < real.intervalMin * 60 * 1000) {
          results.push({ id: sub.id, name: sub.name, ok: false, reason: '间隔未到（订阅 ⚙ 可调频率）' });   // 跳过留痕，UI 不再静默
          continue;
        }
        try {
          // 占位名/URL 兜底名（订阅 N、Instagram · nasa）先补救：入队标题才有真名，不再出现「订阅 3」这种标记（bilibili 也在 refreshName 覆盖范围内）
          if ((real.name || '').startsWith('订阅 ') || real._auto) { try { await subs.refreshName(real.id); } catch (e) {} }
          const gdlSeqs = [];   // gallery-dl 型订阅：新内容只有序号没有独立 URL，先收集再合并连续段
          const r = await subs.checkSub(real, (s, it) => {
            if (it.type === 'text') return;   // 纯文字动态无媒体，只记录不入队
            if (!kwMatch(real, it.text)) return;   // 关键词不匹配：记 known 但不入队
            if (it.type === 'gdl') { gdlSeqs.push(it.seq); return; }
            // RSS feed 条目：按链接分流引擎（文章/视频/图站各自走对），不硬塞 article
            if (it.type === 'feed') {
              const url2 = subs.itemUrl(s, it);
              if (!url2) return;
              const t2 = queue.add(url2, { engine: engineForFeedItem(url2), title: `[订阅] ${s.name} · ${(it.text || '新文章').slice(0, 40)}`, _subId: s.id, _transcribe: !!real.autoTranscribe });
              if (t2 && t2.duplicate) return false;   // 同 URL 已在队列：不记 known，下轮重查防吞
              return true;
            }
            const engine = it.type === 'video' ? 'yt-dlp' : 'gallery-dl';
            // #70④：订阅开启「自动转写」→ 新任务带转写标记（下载完自动出字幕/文稿）
            const t = queue.add(subs.itemUrl(s, it), { engine, title: `[订阅] ${s.name} · ${it.text || it.type}`, _subId: s.id, _transcribe: !!real.autoTranscribe });
            if (t && t.duplicate) return false;   // 同 URL 任务已在队列（可能失败/被取消）→ 不记 known，下轮仍算 fresh 重查，防增量被永久吞掉
            return true;
          });
          // gdl 新内容：连续序号合并成 range 段（如 1,2,3,7 → 1-3 与 7 两段），gallery-dl 按段拉取
          if (gdlSeqs.length) {
            gdlSeqs.sort((a, b) => a - b);
            const runs = [];
            for (const q of gdlSeqs) {
              const last = runs[runs.length - 1];
              if (last && q === last[1] + 1) last[1] = q; else runs.push([q, q]);
            }
            for (const [a, b] of runs) {
              queue.add(real.url, { engine: 'gallery-dl', _range: a === b ? String(a) : `${a}-${b}`,
                title: `[订阅] ${real.name} · 新内容 #${a}${b !== a ? '-' + b : ''}`, _subId: real.id, _transcribe: !!real.autoTranscribe });
            }
          }
          real.failStreak = 0;
          real.lastError = null;   // 检查通过：清失败原因（UI「检查失败」态复位）
          subs.refreshName(real.id);   // 占位名补救（bilibili/gdl/x 都覆盖；已修好的直接跳过）
          // 新订阅自动全量（用户需求：订阅=要全部）：首检建好基线就自动回溯；
          // 队列忙/失败不清标记，下轮检查（10 分钟）自动重试，成功才落盘清除
          if (real.autoBackfill && r.ok) {
            runBackfill(real).then(r2 => {
              if (r2 && r2.ok) { real.autoBackfill = false; subs.save(); }
            }).catch(() => {});
          }
          results.push({ id: sub.id, name: sub.name, ...r });
          log.info('subs', `检查 ${sub.name}: fresh=${r.fresh} gone=${r.gone} total=${r.total}`);
        } catch (e) {
          real.failStreak = (real.failStreak || 0) + 1;
          // 失败态显式化：lastCheck 保持旧值不动，另记 lastFailAt/lastError——
          // 旧行为失败时UI永远显示「尚未检查」，用户根本不知道该站点是缺 cookie 还是网络断了
          real.lastFailAt = Date.now();
          real.lastError = String(e.message).slice(0, 120);
          if (real.failStreak >= 3) { real.paused = true; subs.save(); }   // 连续 3 轮失败暂停，防风控硬撞（状态落盘）
          log.warn('subs', `检查失败 ${sub.name}: ${real.lastError}`);
          results.push({ id: sub.id, name: sub.name, ok: false, reason: real.lastError });
        }
      }
      if (win && !win.isDestroyed()) win.webContents.send('subs:changed', subs.list());
      return results;
    } finally { }
  }
  ipcMain.handle('subs:list', () => subs.list());
  // 一键直达订阅原链接：URL 由主进程按 id 从订阅表取，不信任渲染层传 URL（防注入钓鱼）；
  // 只放行 https（订阅都是 http(s)），不做站点白名单——订阅本来就是用户自己加的，打开自己的订阅页没有额外风险
  ipcMain.handle('subs:openUrl', (e, { id }) => {
    const sub = subs.list().find(s => s.id === id);
    const url = sub && sub.url;
    if (!url || !/^https:\/\//i.test(url)) return { ok: false, reason: '订阅链接缺失或不是 https，已在主进程拦截' };
    shell.openExternal(url);
    return { ok: true };
  });
  // 媒体库一键直达来源：URL 由主进程按文件路径查来源索引取得。
  // 索引只记录建档之后的下载（source.js 的诚实声明），老文件查不到要明说，别让用户以为按钮坏了
  ipcMain.handle('lib:openSource', (e, { filePath }) => {
    const src = source.get(String(filePath || ''));
    if (!src || !src.url) return { ok: false, reason: '这个文件没有来源记录：来源索引只记录建档之后的下载，老文件查不到' };
    if (!/^https:\/\//i.test(src.url)) return { ok: false, reason: '来源链接不是 https，已在主进程拦截' };
    shell.openExternal(src.url);
    return { ok: true };
  });
  ipcMain.handle('subs:add', (e, { url, name }) => {
    const r = subs.add(url, name);
    // 添加即检查：首检建基线 → 自动全量回溯立刻开跑（不等 10 分钟轮询）
    if (r.ok) checkAllSubs(r.sub.id).catch(() => {});
    return r;
  });
  // 关键词过滤设置（空=全收）
  ipcMain.handle('subs:setKw', (e, { id, kw }) => {
    const s = subs.get(id);
    if (!s) return { ok: false, reason: '订阅不存在' };
    s.kw = String(kw || '').split(/[,，\s]+/).map(x => x.trim()).filter(Boolean).slice(0, 20);
    subs.save();
    if (win && !win.isDestroyed()) win.webContents.send('subs:changed', subs.list());
    return { ok: true, kw: s.kw };
  });
  ipcMain.handle('subs:remove', (e, { id }) => subs.remove(id));
  ipcMain.handle('subs:check', (e, { id }) => checkAllSubs(id || null));
  // #70② 订阅属性：暂停/分组/频率/自动转写（白名单见 subs.update）
  ipcMain.handle('subs:update', (e, { id, patch }) => {
    const r = subs.update(id, patch);
    // 手动改名 → 队列历史任务标题同步（旧任务还挂着「订阅 N」，改名后追平；机制同 onNameChange）
    if (r.ok && r.renamed) {
      const n = queue.renameSub(id, r.renamed);
      if (n && win && !win.isDestroyed()) win.webContents.send('queue:snapshot', queue.snapshot());
    }
    if (win && !win.isDestroyed()) win.webContents.send('subs:changed', subs.list());
    return r;
  });
  // 订阅卡片 📂：打开该订阅实际的下载子目录。
  // yt-dlp 结构 {outDir}/{site}/{uploader}；gallery-dl 结构 {outDir}/{category}/{作者目录}（x→twitter/xxx、weibo→weibo/xxx…）
  const GDL_CATEGORY = [
    [/pixiv\.net/i, 'pixiv'], [/weibo\./i, 'weibo'], [/danbooru/i, 'danbooru'], [/gelbooru/i, 'gelbooru'],
    [/yande\.re/i, 'yandere'], [/konachan/i, 'konachan'], [/artstation/i, 'artstation'], [/deviantart/i, 'deviantart'],
    [/imgur/i, 'imgur'], [/flickr/i, 'flickr'], [/pinterest/i, 'pinterest'], [/tumblr/i, 'tumblr'],
    [/reddit/i, 'reddit'], [/tiktok/i, 'tiktok'], [/instagram/i, 'instagram'],
  ];
  function subFolderCandidates(s) {
    const base = settings.get().outDir;
    if (s.kind === 'x') {
      // twitter 提取器的目录名 = 作者 name（观察=handle）；显示名/命名都可能是别的，逐个候选
      return [path.join(base, 'twitter', s.handle || ''), path.join(base, 'twitter', s.name || ''), path.join(base, 'twitter')];
    }
    if (s.kind === 'gdl') {
      const cat = (GDL_CATEGORY.find(([re]) => re.test(s.url)) || [null, null])[1];
      return [cat ? path.join(base, cat, s.name || '') : '', cat ? path.join(base, cat) : ''];
    }
    return [path.join(base, s.kind, s.name || '')];
  }
  ipcMain.handle('subs:openFolder', (e, { id }) => {
    const s = subs.get(id);
    if (!s) return { ok: false, reason: '订阅不存在' };
    const hit = subFolderCandidates(s).find(d => d && fs.existsSync(d));
    const target = hit || settings.get().outDir;   // 全没命中退回下载根目录，至少不是错误的文件夹
    return shell.openPath(target).then(err => err ? { ok: false, reason: err } : { ok: true });
  });
  // 「源头已删除」明细 → 对应本地文件：gallery-dl 用动态 id 命名图片、BV 号在视频文件名里，按 id 搜订阅目录
  // 抽成共用函数：UI 角标查询与删帖清单导出（CSV）同源，避免两套逻辑漂移
  const goneFilesOf = (s) => {
    if (!s || !(s.gone || []).length) return {};
    const roots = [...new Set(subFolderCandidates(s).filter(d => d && fs.existsSync(d) && fs.statSync(d).isDirectory()))];
    const files = [];
    const walk = (dir, depth) => {
      if (depth > 3 || files.length > 2000) return;
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full, depth + 1);
        else if (ent.isFile()) files.push(full);
      }
    };
    roots.forEach(d => walk(d, 0));
    const map = {};
    for (const gid of s.gone) {
      const hit = files.filter(f => path.basename(f).includes(gid)).slice(0, 10);
      if (hit.length) map[gid] = hit;
    }
    return map;
  };
  ipcMain.handle('subs:goneFiles', (e, { id }) => {
    const s = subs.get(id);
    return { ok: true, files: goneFilesOf(s) };
  });
  // 删帖清单导出（v0.1.9）：全部订阅的 gone 明细 → CSV（带 BOM，Excel 直接打开中文不乱码）
  // 列：订阅名 / 类型 / 内容 ID / 源头链接 / 本地文件（; 分隔多文件）/ 本地是否还在
  ipcMain.handle('subs:exportGone', async () => {
    try {
      const rows = [];
      for (const s of subs.list()) {
        if (!(s.gone || []).length) continue;
        const files = goneFilesOf(subs.get(s.id));
        for (const gid of s.gone) {
          const local = files[gid] || [];
          let src = '';
          try { src = subs.itemUrl(s, { id: gid, type: 'video' }) || subs.itemUrl(s, { id: gid, type: 'text' }) || ''; } catch (e) {}
          rows.push([s.name || '', s.kind || '', gid, src, local.join(' ; '), local.length ? '在' : '已不在本地']);
        }
      }
      if (!rows.length) return { ok: false, reason: '当前没有被判定为「源头已删除」的内容' };
      const esc = v => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
      const csv = '\uFEFF订阅名,类型,内容 ID,源头链接,本地文件,本地状态\n'
        + rows.map(r => r.map(esc).join(',')).join('\n') + '\n';
      const r = await dialog.showSaveDialog(win, {
        title: '导出删帖清单',
        defaultPath: 'Keepsake-删帖清单-' + new Date().toISOString().slice(0, 10) + '.csv',
        filters: [{ name: 'CSV 表格', extensions: ['csv'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, reason: '已取消' };
      fs.writeFileSync(r.filePath, csv, 'utf8');
      log.info('subs', `导出删帖清单 → ${r.filePath}（${rows.length} 条）`);
      return { ok: true, path: r.filePath, count: rows.length };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e).slice(0, 120) };
    }
  });
  ipcMain.handle('subs:resume', (e, { id }) => {   // 暂停的订阅可恢复（#70② 起同时清手动/自动两种暂停）
    const r = subs.get(id);
    if (!r) return { ok: false, reason: '订阅不存在' };
    r.paused = false; r.failStreak = 0; r.userPaused = false;
    subs.save();
    if (win && !win.isDestroyed()) win.webContents.send('subs:changed', subs.list());
    return { ok: true };
  });
  // 回溯下载（手动 ⤓ 与「新订阅自动全量」共用）：拉订阅源全部媒体逐条入队（队列内已有同 URL 的自动跳过）
  // 用户反馈「回溯只能一个一个来」：旧实现 FIFO 要等整个下载队列全空才跑下一个回溯——
  // A 订阅回溯入队 200 个任务后，B 订阅要等这 200 个全下完才开始拉清单，干等几小时。
  // 回溯本身只是「拉清单 + 入队」（gdl/x 一次请求搞定，bilibili 全量翻页较重），
  // 下载并发/风控由队列自己管，没道理串行。改为并发 3 个回溯（bilibili 全量翻页 3 路并行是
  // 探测风控与等待时长的平衡点），其余进 FIFO 排队，有回溯结束即补位。
  const _pendingBackfills = [];   // sub id FIFO（去重）
  const MAX_BACKFILL_PARALLEL = 3;
  let _runningBackfills = 0;
  async function _runBackfillNow(real) {
    if ((real.name || '').startsWith('订阅 ') || real._auto) { try { await subs.refreshName(real.id); } catch (e) {} }   // 回溯标题也别带「订阅 N」占位名/URL 兜底名
    let added = 0, skipped = 0;
    // gdl 型订阅：所有项共享同一主页 URL（逐条入队会被同 URL 去重吞掉），整段一个任务即可
    // （gallery-dl 自动翻页拉完整列表全量下载；下载时自动跳过已存在的文件，重复回溯安全）
    if (real.kind === 'gdl') {
      queue.add(real.url, { engine: 'gallery-dl', title: `[订阅回溯] ${real.name} · 全量`, _subId: real.id });
      if (win && !win.isDestroyed()) win.webContents.send('queue:snapshot', queue.snapshot());
      return { ok: true, added: 1, skipped: 0, total: 0, media: 0 };
    }
    // X 订阅回溯：yt-dlp 无用户时间线提取器（Unsupported URL 根因），整个回溯就是一个 gdl 任务
    // （gallery-dl twitter 提取器图+视频一起下，全量翻页直到拉完；下载时自动跳过已存在文件）
    if (real.kind === 'x') {
      queue.add(real.url, { engine: 'gallery-dl', title: `[订阅回溯] ${real.name} · 全量`, _subId: real.id });
      added++;
      subs.refreshName(real.id);
    }
    const r = await subs.backfill(real.id, (s, it) => {
      const url = subs.itemUrl(s, it);
      if (!url) return;
      if (!kwMatch(real, it.text)) return;   // 关键词过滤
      if ([...queue.items.values()].some(x => x.url === url)) { skipped++; return; }
      // RSS feed 条目回溯：同样按链接分流引擎（与增量检查同一套规则）
      const engine = it.type === 'feed' ? engineForFeedItem(url) : (it.type === 'video' ? 'yt-dlp' : 'gallery-dl');
      queue.add(url, { engine, title: `[订阅回溯] ${s.name} · ${(it.text || it.type || '').slice(0, 30)}`, _subId: s.id });
      added++;
    });
    if (win && !win.isDestroyed()) win.webContents.send('queue:snapshot', queue.snapshot());
    return { ok: true, added, skipped, total: r.total, media: r.media };
  }
  async function drainBackfills() {
    while (_pendingBackfills.length && _runningBackfills < MAX_BACKFILL_PARALLEL) {
      const id = _pendingBackfills.shift();
      const real = subs.get(id);
      if (!real) continue;
      delete real._pendingBackfill;
      if (win && !win.isDestroyed()) win.webContents.send('subs:changed', subs.list());
      if (real.userPaused || real.paused) continue;   // 排队期间被暂停：丢弃，不再回溯
      _runningBackfills++;
      (async () => {
        try { toastMsg('开始回溯：' + real.name + '（并发 ' + _runningBackfills + '/' + MAX_BACKFILL_PARALLEL + '）'); await _runBackfillNow(real); }
        catch (e) { toastMsg('回溯失败：' + real.name + ' — ' + String(e.message || e).slice(0, 80)); }
        finally { _runningBackfills--; drainBackfills(); }   // 腾出位子给排队的回溯
      })();
    }
  }
  async function runBackfill(real) {
    if (_runningBackfills < MAX_BACKFILL_PARALLEL) {
      // 有空位即刻开跑（不再等下载队列全空——回溯只是拉清单入队，下载限速由队列管）
      _runningBackfills++;
      try { return await _runBackfillNow(real); }
      finally { _runningBackfills--; drainBackfills(); }
    }
    if (!_pendingBackfills.includes(real.id)) {
      _pendingBackfills.push(real.id);
      real._pendingBackfill = true;   // 瞬态标记：UI 显示「排队待回溯」（不落盘）
      if (win && !win.isDestroyed()) win.webContents.send('subs:changed', subs.list());
    }
    return { ok: true, queued: true, added: 0, skipped: 0, total: 0, media: 0 };
  }
  ipcMain.handle('subs:backfill', async (e, { id }) => {
    const real = subs.get(id);
    if (!real) return { ok: false, reason: '订阅不存在' };
    return runBackfill(real);
  });

  // ===== B 站登录（扫码，Chromium 网络栈，绕开 TLS 指纹风控）=====
  ipcMain.handle('login:open', async () => new Promise(resolve => {
    const r = login.openLoginWindow(userData, res => resolve(res));
    if (!r.ok) resolve(r);   // 窗口已打开等情况立即返回
  }));
  ipcMain.handle('login:state', () => login.loginState(userData));
  ipcMain.handle('login:logout', () => login.logout(userData));

  // B 站 cookie（SESSDATA）过期检测——Netscape 格式第 5 列是过期时间戳。
  // 过期后只能游客身份下载（清晰度降/风控变严），主动提醒重新扫码，别让用户纳闷为啥下载变差了
  function biliCookieExpired() {
    try {
      for (const line of fs.readFileSync(cookiePath, 'utf-8').split('\n')) {
        const l = line.replace(/^#HttpOnly_/, '');
        if (l.startsWith('#')) continue;
        const p = l.split('\t');
        if (p.length >= 7 && p[5] === 'SESSDATA' && /bilibili/i.test(p[0])) {
          const exp = parseInt(p[4], 10) * 1000;
          return exp > 0 && exp < Date.now();
        }
      }
    } catch (e) {}
    return false;
  }
  function checkBiliCookie() {
    if (biliCookieExpired()) {
      log.warn('login', 'B 站 SESSDATA 已过期');
      toastMsg('B 站登录已过期：请点左下角「登录 B 站」重新扫码，否则只能以游客身份下载');
    }
  }
  setTimeout(checkBiliCookie, 15 * 1000);
  setInterval(checkBiliCookie, 24 * 3600 * 1000);

  // ===== 本地转写（Whisper，照 VidBee 方法：模型自选下载 + 镜像切换）=====
  ipcMain.handle('asr:models', () => ({ models: asr.listModels(), mirrors: asr.MIRRORS, activeModel: asr.anyModel() }));
  ipcMain.handle('asr:setMirror', (e, { id }) => { asr.setMirror(id); settings.set({ asrMirror: id }); return { ok: true }; });   // 镜像选择持久化，重启不再退回默认
  // 设默认转写模型（已下载的模型可互相切换）
  ipcMain.handle('asr:setModel', (e, { id }) => {
    const ok = asr.setActive(id);
    return ok ? { ok: true, activeModel: asr.anyModel() } : { ok: false, reason: '该模型尚未下载或不存在' };
  });
  ipcMain.handle('asr:deleteModel', (e, { id }) => asr.deleteModel(id));
  ipcMain.handle('asr:download', (e, { id }) => {
    // 防双击并发下载（同一模型同时只允许一个下载任务
    if (_asrDownloading.has(id)) return { ok: false, reason: '该模型正在下载中' };
    _asrDownloading.add(id);
    return asr.downloadModel(id, pct => {
      if (win && !win.isDestroyed()) win.webContents.send('asr:downloadProgress', { id, pct });
    }).finally(() => _asrDownloading.delete(id));
  });
  ipcMain.handle('asr:transcribe', (e, { filePath }) => {
    const resolved = insideOutDir(filePath);   // 只许转写下载目录内的媒体（防任意文件读取/CPU 滥用）
    if (!resolved) return { ok: false, reason: '只允许转写下载目录内的文件' };
    if (!fs.existsSync(resolved)) return { ok: false, reason: '文件不存在' };
    enqueueTranscribe(resolved, 'manual');
    return { ok: true };
  });
  // 阶段一：全组批量转写——组内每个未转写的音视频入串行队列（已有 .srt 的跳过）
  ipcMain.handle('asr:batch', (e, { paths }) => {
    let added = 0, skipped = 0;
    for (const p of (Array.isArray(paths) ? paths : [])) {
      const resolved = insideOutDir(p);
      if (!resolved || !fs.existsSync(resolved)) continue;
      if (!/\.(mp4|mkv|webm|mov|avi|flv|m4a|mp3|wav)$/i.test(resolved)) continue;
      if (fs.existsSync(resolved.replace(/\.[^.]+$/, '') + '.srt')) { skipped++; continue; }
      enqueueTranscribe(resolved, 'batch');
      added++;
    }
    if (added) toastMsg(`已加入批量转写队列：${added} 个文件（${skipped} 个已有字幕跳过），逐个处理中`);
    else toastMsg(skipped ? '该组全部文件都已有字幕' : '没有可转写的媒体文件');
    return { ok: true, added, skipped };
  });
  // 阶段一：双语字幕——无 SRT 自动先转写，再分块翻译合成中英对照（走用户已配置的 AI key）
  ipcMain.handle('srt:translate', (e, { filePath }) => {
    const resolved = insideOutDir(filePath);
    if (!resolved) return { ok: false, reason: '只允许处理下载目录内的文件' };
    if (!fs.existsSync(resolved)) return { ok: false, reason: '文件不存在' };
    if (!ai.ready()) return { ok: false, reason: '请先在设置页配置 AI 接口（翻译用），转写不受影响' };
    enqueueTranslate(resolved);
    return { ok: true };
  });
  // 阶段一：烧字幕——ffmpeg 硬字幕，优先双语版
  ipcMain.handle('srt:burn', (e, { filePath }) => {
    const resolved = insideOutDir(filePath);
    if (!resolved) return { ok: false, reason: '只允许处理下载目录内的文件' };
    if (!fs.existsSync(resolved)) return { ok: false, reason: '文件不存在' };
    enqueueBurn(resolved);
    return { ok: true };
  });
  // 媒体库删除：移入系统回收站（可恢复），只许删下载目录内的文件
  ipcMain.handle('lib:trash', async (e, { filePath }) => {
    const resolved = insideOutDir(filePath);
    if (!resolved) return { ok: false, reason: '只允许删除下载目录内的文件' };
    if (!fs.existsSync(resolved)) return { ok: false, reason: '文件不存在（可能已被删除，刷新即可）' };
    try {
      await shell.trashItem(resolved);   // 回收站失败（如文件被占用）要给出明确反馈，不能静默吞掉
    } catch (err) {
      return { ok: false, reason: '移入回收站失败（文件可能被占用）：' + String(err.message || err).slice(0, 100) };
    }
    if (win && !win.isDestroyed()) win.webContents.send('library:changed');
    return { ok: true };
  });

  // ===== 文章引擎（M-A2/A3）=====
  // 阅读已存档文章：article 目录里的 index.html 用系统默认浏览器/浏览器内核打开
  // （内嵌阅读样式、图片全本地化，离线可看）
  ipcMain.handle('article:open', (e, { filePath }) => {
    const dir = insideOutDir(filePath);
    if (!dir) return { ok: false, reason: '只允许打开下载目录内的文章' };
    const idx = path.join(dir, 'index.html');
    if (!fs.existsSync(idx)) return { ok: false, reason: '文章文件缺失（目录里没有 index.html）' };
    return shell.openPath(idx).then(err => err ? { ok: false, reason: err } : { ok: true });
  });
  // 重新检查（删帖检测最小版）：重抓原文页——
  // 404 /「内容已被发布者删除」/「此内容因违规无法查看」→ meta 标记删除态；
  // 正文 hash 变化 → 标记「内容有编辑」（本地存档不动，是否重新存档由用户决定）
  ipcMain.handle('article:recheck', async (e, { filePath }) => {
    const dir = insideOutDir(filePath);
    if (!dir) return { ok: false, reason: '只允许检查下载目录内的文章' };
    try {
      // cancel 语义补齐（P1-1）：传入 cancel 控制对象（窗口会挂其上，供后续取消扩展）；
      // recheck 内部每个 executeJavaScript 均有 30s 超时兜底，页面卡死时最坏几十秒内
      // reject，此 IPC 绝不永挂
      const r = await articleLib.recheck({ dir, cancel: { canceled: false } });
      log.info('article', `重新检查 ${path.basename(dir)}: status=${r.status} edited=${r.edited}`);
      if (win && !win.isDestroyed()) win.webContents.send('library:changed');
      return { ok: true, ...r };
    } catch (err) {
      return { ok: false, reason: (err && err.human) || String((err && err.message) || err).slice(0, 160) };
    }
  });

  createWindow();
  createTray();

  // UI 冒烟：策略页 DOM 渲染检查（仅 autotest 时）
  if (process.env.FETCHIE_AUTOTEST && win) {
    win.webContents.on('did-finish-load', async () => {
      try {
        const r = await win.webContents.executeJavaScript(`
          (async () => {
            switchPage('strategy');
            await loadStrategy();
            const t = document.getElementById('strategyList').innerText;
            const l = document.getElementById('learnedList').innerText;
            return JSON.stringify({
              siteRows: (t.match(/bilibili\\.com|pixiv\\.net/g) || []).length,
              sourceTag: t.includes('远程') || t.includes('内置'),
              learnedShown: l.length > 0
            });
          })()
        `);
        console.log('[autotest] strategy ui:', r);
      } catch (e) { console.log('[autotest] strategy ui FAIL:', e.message); }
    });
  }

  // 订阅检查循环：启动 30s 后第一轮，之后每 10 分钟
  let checkTimer = setTimeout(function schedule() {
    checkAllSubs().catch(() => {});
    checkTimer = setTimeout(schedule, CHECK_INTERVAL_MS);
  }, 30 * 1000);

  // 自动测试（主进程级，不依赖渲染层）
  if (process.env.FETCHIE_AUTOTEST) {
    setTimeout(async () => {
      try {
        const probe = await runEngine(binDir());
        console.log('[autotest] engines:', JSON.stringify(probe));
        if (!probe.ytDlp.ok || !probe.galleryDl.ok || !probe.ffmpeg.ok) throw new Error('engine probe failed');

        // 引擎更新检查（只查不装，验证通路）
        const updates = await autoupdate.checkAll().catch(e => { console.log('[autotest] update check fail:', e.message); return null; });
        if (updates) for (const u of updates) console.log('[autotest] update:', u.engine, u.local, '->', u.remote, u.needUpdate ? '(NEED UPDATE)' : '(latest)');

        // 策略层自检：B站档位 + 熔断接口
        const st = strategy.forUrl('https://www.bilibili.com/video/x');
        console.log('[autotest] strategy bilibili:', JSON.stringify({ sleep: st.sleep, level: st.level, threshold: st.breakerThreshold }));
        if (!st.sleep || st.sleep < 3) throw new Error('strategy bilibili sleep invalid');

        // 去重探针：活跃任务同 URL 再 add 必须返回已有项并带 duplicate 标记（
        const AUDIO_URL = 'https://www.bilibili.com/video/BV1GJ411x7h7';
        const t1 = queue.add(AUDIO_URL, { engine: 'yt-dlp', title: 'autotest-video' });
        const dup = queue.add(AUDIO_URL, { engine: 'yt-dlp', title: 'autotest-dup-probe' });
        if (!dup || !dup.duplicate || dup.id !== t1.id) throw new Error('URL dedup broken: ' + JSON.stringify(dup && { id: dup.id, duplicate: !!dup.duplicate }));
        console.log('[autotest] dedup probe: OK (same-URL add returned existing', dup.id + ')');
        const t2 = queue.add('https://www.bilibili.com/opus/1251190976967344129', { engine: 'gallery-dl', title: 'autotest-gallery', _range: '1-3' });
        console.log('[autotest] tasks added:', t1.id, t2.id, '（音频任务延后到 t1 完成后再入队——同 URL 去重只拦活跃任务，老写法 t3 会被拦成 t1 导致音频模式没跑）');

        // 远程规则热更通路：对象直调验证「校验+合并+生效」，persist=false 不污染 remote-rules.json
        strategy.applyRemoteRules([
          { host: 'rules-test.example.com', sleep: 7, breakerThreshold: 2, backoffLevels: [7, 14, 30] },
          { host: 'bad host!!', sleep: 999 },          // 应被过滤
          { host: 'bilibili.com', sleep: 5 },           // 覆盖内置项
        ], { persist: false });
        const tr = strategy.forUrl('https://rules-test.example.com/a');
        const tb = strategy.forUrl('https://www.bilibili.com/video/x');
        console.log('[autotest] rules: test-host sleep=', tr.sleep, 'bilibili sleep=', tb.sleep, '(被本轮测试临时覆盖为 5)');
        if (tr.sleep !== 7) throw new Error('applyRemoteRules new-host merge failed');
        if (tb.sleep !== 5) throw new Error('applyRemoteRules existing-host override failed');

        // 远程规则真实拉取通路（内置线上端点）；网络失败 WARN 不阻塞（环境因素）
        const rr = await refreshRemoteRules();
        console.log('[autotest] rules fetch:', rr.ok ? `OK version=${rr.version} applied=${rr.applied}/${rr.total}` : 'WARN ' + rr.reason);

        const ids = new Set([t1.id, t2.id]);
        const snap = await new Promise(resolve => {
          const iv = setInterval(() => {
            const s = queue.snapshot();
            if (s.filter(x => ids.has(x.id)).every(x => ['done', 'error', 'canceled'].includes(x.status))) { clearInterval(iv); resolve(s); }
          }, 1000);
        });
        for (const s of snap.filter(x => ids.has(x.id))) console.log('[autotest] task:', s.status, s.engine, s.progress + '%', s.fileCount || '', s.error || '');
        let pass = snap.filter(x => ids.has(x.id)).every(s => s.status === 'done');
        // 音频模式延后入队：t1 已 done，同 URL 不再被去重拦截（顺带验证 done 后可重下）
        const t3 = queue.add(AUDIO_URL, { engine: 'yt-dlp', title: 'autotest-audio', _audio: true });
        if (!t3 || t3.duplicate || t3.id === t1.id) throw new Error('audio task blocked by dedup (t1 should be done)');
        console.log('[autotest] audio task added:', t3.id);
        const audioTask = await new Promise(resolve => {
          const iv = setInterval(() => {
            const s = queue.snapshot().find(x => x.id === t3.id);
            if (s && ['done', 'error', 'canceled'].includes(s.status)) { clearInterval(iv); resolve(s); }
          }, 1000);
        });
        console.log('[autotest] task:', audioTask.status, audioTask.engine, audioTask.progress + '%', audioTask.error || '');
        const audioOk = audioTask.status === 'done' && /\.mp3$/i.test(audioTask.filePath || '');
        console.log('[autotest] audio mode product:', audioOk ? 'OK ' + audioTask.filePath : 'FAIL ' + (audioTask.filePath || '?'));
        if (!audioOk) throw new Error('audio-only task did not produce mp3');

        // 本地转写断言：有模型才跑（tiny 75MB；无模型 WARN 不阻塞）
        if (asr.anyModel()) {
          const tr = await asr.transcribe(audioTask.filePath, { language: 'auto' });
          const srtOk = tr.srt && fs.existsSync(tr.srt);
          console.log('[autotest] transcribe:', srtOk ? 'OK ' + tr.srt : 'FAIL');
          if (!srtOk) throw new Error('transcribe did not produce srt');
        } else {
          console.log('[autotest] transcribe: SKIP（未下载模型）');
        }

        // 媒体库索引自检：本轮已下载完成，目录内应有文件可聚合
        const lib = await library.scan();
        console.log('[autotest] library:', lib.groups.length, 'groups,', lib.totalFiles, 'files,',
          (lib.totalSize / 1048576).toFixed(1) + 'MB',
          lib.groups.slice(0, 3).map(g => `${g.site}/${g.uploader}(${g.fileCount})`).join(', '));
        if (lib.totalFiles < 1) throw new Error('library scan found no files');

        // ===== DGO6 QA 回归检查点（v0.1.3 修复轮）：磁盘挂起 / 文稿检索 / 字幕翻译 / 迁移包 =====
        // 任何一项失败：pass 置 false → 最终输出 M1_E2E_FAIL（不中断后续 RSS 检查）
        let dgo6Fail = null;
        const dgo6Check = async (name, fn) => {
          try { await fn(); console.log('[autotest] dgo6/' + name + ': OK'); }
          catch (e) { dgo6Fail = dgo6Fail || name; console.log('[autotest] dgo6/' + name + ': FAIL — ' + e.message); }
        };
        // ① 磁盘挂起：阈值拉到 100TB（远超任何真实磁盘，防真机剩余超 1TB 漏判）→ 新任务必须立即 held
        //    （不 spawn 引擎）→ 恢复阈值 → wakeHeld 回队 → 取消清理
        await dgo6Check('disk-hold', () => {
          const prevMinFree = settings.get().minFreeMB;
          settings.set({ minFreeMB: 104857600 });        // 100TB，确保必挂起
          configure({ minFreeMB: 104857600 });           // 模块级 configure（实例无 reconfigure）
          const probe = queue.add('https://www.bilibili.com/opus/dgo6-diskhold-probe', { engine: 'yt-dlp', title: 'autotest-diskhold-probe' });
          let s = queue.snapshot().find(x => x.id === probe.id);
          if (!s || s.status !== 'held' || !String(s.error || '').includes('磁盘空间不足'))
            throw new Error('磁盘不足应立即挂起: ' + JSON.stringify(s && { status: s.status, error: s.error }));
          settings.set({ minFreeMB: prevMinFree });
          configure({ minFreeMB: prevMinFree });
          queue.wakeHeld();
          s = queue.snapshot().find(x => x.id === probe.id);
          if (!s || s.status !== 'queued') throw new Error('空间恢复后应回队: ' + JSON.stringify(s && s.status));
          queue.cancel(probe.id);
          if (!queue.snapshot().find(x => x.id === probe.id && x.status === 'canceled')) throw new Error('回队后应可取消清理');
        });
        // ② 文稿全文检索：造探针文稿 → reindex → 中文 2-gram 命中 + 原型键 token（DGO6-01 回归）不崩
        await dgo6Check('text-search', () => {
          const dir = path.join(app.getPath('userData'), 'dgo6-probe');
          const media = path.join(dir, 'bilibili', 'autotestUP', 'autotest视频 [BVdgo6].mp4');
          fs.mkdirSync(path.dirname(media), { recursive: true });
          fs.writeFileSync(media, 'x');
          fs.writeFileSync(media.replace(/\.mp4$/, '.txt'), 'DGO 自动测试文稿：量子计算与 constructor 方法入门。');
          const r = textindex.reindex([{ path: media, title: path.basename(media), up: 'autotestUP' }]);
          if (r.indexed !== 1) throw new Error('reindex 应收录 1 篇: ' + JSON.stringify(r));
          const hits = textindex.search('量子计算');
          if (hits.length !== 1 || !String(hits[0].snippet || '').includes('量子')) throw new Error('中文 2-gram 检索失败');
          if (textindex.search('constructor').length !== 1) throw new Error('原型键 token 检索失败（DGO6-01 回归）');
          fs.rmSync(dir, { recursive: true, force: true });
          textindex.reindex([]);   // 摘除探针文稿，不留脏索引
        });
        // ③ 字幕翻译（假翻译器直调，不走 ai.ready/网络）：双语产物含原文+译文
        await dgo6Check('srt-translate', async () => {
          const dir = path.join(app.getPath('userData'), 'dgo6-probe');
          fs.mkdirSync(dir, { recursive: true });
          const src = path.join(dir, 'autotest.srt');
          fs.writeFileSync(src, '1\n00:00:01,000 --> 00:00:02,000\nhello autotest\n\n2\n00:00:03,000 --> 00:00:04,000\nsecond line\n');
          const fake = async prompt => prompt.split('\n')
            .map(l => { const m = /^(\d+)\|(.+)$/.exec(l); return m ? m[1] + '|译' + m[1] : ''; })
            .filter(Boolean).join('\n');
          const r = await srtLib.translateSrt(src, { translator: fake });
          const out = fs.readFileSync(r.outFile, 'utf-8');
          if (!out.includes('hello autotest') || !out.includes('译1') || !out.includes('译2')) throw new Error('双语产物缺失原文/译文');
          fs.rmSync(src, { force: true }); fs.rmSync(r.outFile, { force: true });
        });
        // ④ 迁移包 collect+apply 对象直调（绕 dialog）：自环导入应全部去重跳过、无 errors；畸形包逐条 errors 不中断（DGO6-04 回归）
        await dgo6Check('bundle-roundtrip', async () => {
          const udd = app.getPath('userData');
          const sf = path.join(udd, 'settings.json');
          if (!fs.existsSync(sf)) fs.writeFileSync(sf, '{}');   // 自测 userData 是全新临时目录，自给自足保证文件存在（subs.json 缺失 collect 自带容忍）
          const c = backup.collect({ settingsFile: sf, subsFile: path.join(udd, 'subs.json') });
          if (!c.ok || c.bundle.app !== 'Keepsake' || !c.bundle._warning) throw new Error('collect 失败或缺 _warning');
          const beforeUrls = subs.list().map(su => su.url);
          const a = await backup.apply(JSON.parse(JSON.stringify(c.bundle)), {
            settingsSetter: p => {
              const keep = { ...p }; delete keep.outDir;   // 不动正在用的下载目录
              settings.set(keep);
              if (keep.minFreeMB !== undefined) configure({ minFreeMB: keep.minFreeMB });   // 模块级 configure（实例无 reconfigure）
            },
            subsAdd: (url, name, extra) => { const r2 = subs.add(url, name); if (r2.ok && extra) subs.update(r2.sub.id, extra); return r2; },
            subsUrls: beforeUrls,
          });
          if (!a.ok) throw new Error('apply 自环失败: ' + (a.reason || ''));
          if (a.subsAdded !== 0 || a.subsSkipped !== beforeUrls.length)
            throw new Error(`订阅应全部去重跳过: +${a.subsAdded}/skip=${a.subsSkipped}（期望 skip=${beforeUrls.length}）`);
          if (a.errors.length) throw new Error('apply 不应有 errors: ' + a.errors.join(' | '));
          const bad = await backup.apply({ app: 'DGO', bundleVersion: 1, settings: {}, subs: [null, 42] },
            { settingsSetter: () => {}, subsAdd: () => ({ ok: true }), subsUrls: [] });
          if (!bad.ok || bad.errors.length < 2) throw new Error('畸形包应逐条记 errors 不中断（DGO6-04 回归）: ' + JSON.stringify(bad));
        });
        if (dgo6Fail) { pass = false; console.log('[autotest] dgo6 summary: FAIL (' + dgo6Fail + ')'); }
        else console.log('[autotest] dgo6 summary: 4/4 OK');

        // RSS 通路验证：订阅影视飓风 → 探针拉动态列表（投稿+图文）
        // 本测试机 IP 可能处于风控冷却期（空列表），断言分两级：
        //   基础 = 探针通路不抛错；完整 = 列表非空时做「模拟增量」→ 触发下载 → done
        let rssOk = false, rssDetail = 'no-run';
        try {
          const added = subs.add('https://space.bilibili.com/946974', 'autotest-sub');
          const sub = subs.get(added.sub.id);
          const r1 = await subs.checkSub(sub, () => {});
          rssDetail = `total=${r1.total ?? '?'} fresh=${r1.fresh ?? '?'}`;
          rssOk = r1.ok;
          if (r1.ok && r1.total > 0 && sub.known.length > 1) {
            // 模拟增量：删一条 known 再查 → 应发现 1 条新 → 自动入队下载
            sub.checked = 1;
            sub.known = sub.known.slice(1);
            let dlDone = null;
            const r2 = await subs.checkSub(sub, (s, it) => {
              const engine = it.type === 'video' ? 'yt-dlp' : 'gallery-dl';
              queue.add(subs.itemUrl(s, it), { engine, title: `[RSS增量] ${it.type} ${it.id}` });
            });
            if (r2.fresh > 0) {
              const ok2 = await new Promise(resolve => {
                const iv = setInterval(() => {
                  const s = queue.snapshot().filter(x => x.title.startsWith('[RSS增量]'));
                  if (s.length && s.every(x => ['done', 'error', 'canceled'].includes(x.status))) { clearInterval(iv); resolve(s.every(x => x.status === 'done')); }
                }, 1000);
              });
              rssDetail += ` 增量下载:${ok2 ? 'OK' : 'FAIL'}`;
              rssOk = rssOk && ok2;
            }
          }
          subs.remove(added.sub.id);
        } catch (e) { rssDetail = String(e.message).slice(0, 100); }
        console.log('[autotest] rss:', rssOk ? 'OK' : 'WARN(风控冷却或探针异常)', `(${rssDetail})`);
        const persisted = fs.existsSync(path.join(app.getPath('userData'), 'tasks.json'));
        console.log('[autotest] persisted tasks.json:', persisted);
        console.log('[autotest] login state:', JSON.stringify(login.loginState(app.getPath('userData'))), '（未登录属正常，扫码后变 true）');
        console.log('[autotest] settings:', JSON.stringify(settings.get()));
        if (!settings.get().outDir) throw new Error('settings outDir missing');
        // 整体判定不含 rss（探针受 IP 风控冷却影响，属环境因素）；rss 状态独立输出供人工确认
        console.log(pass && persisted ? 'M1_E2E_PASS' : 'M1_E2E_FAIL');
        setTimeout(() => app.exit(pass && persisted ? 0 : 1), 1500);
      } catch (e) {
        console.error('[autotest]', e.message);
        app.exit(2);
      }
    }, 3000);
  }

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}).catch(e => {
  // 启动兜底：whenReady 里任何一步炸掉都不能静默卡死（2026-10-10 实测：queue.onDone 挂早了导致白屏卡住无任何提示）
  console.error('[boot] startup failed:', e);
  try { log.error('app', '启动失败: ' + (e && e.stack || e)); } catch (e2) {}
  if (process.env.FETCHIE_AUTOTEST) app.exit(3);
  else dialog.showErrorBox('Keepsake 启动失败', String(e && e.message || e).slice(0, 300) + '\n\n详细日志见 userData/logs/ 目录');
});

app.on('window-all-closed', () => {
  // 托盘常驻：窗口全关（=全部隐藏）不退出；真正退出走托盘菜单（quitting=true）
  if (quitting) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  // 未完成任务续跑（用户反馈）：退出不再取消任务——
  // downloading 杀子进程防孤儿后标 queued，queued/held 原样落盘；下次启动 restore 自动续跑。
  // （旧行为 before-quit 全取消，重启后队列是空的，与「自启动后继续未完成项目」矛盾）
  try {
    if (queue) queue.killRunning();
  } catch (e) {}
  try { killEngineSubprocesses(); } catch (e) {}   // 双保险：清掉残留的引擎子进程树
  try { store.flushNow(); } catch (e) {}   // 防抖中的任务状态强制落盘
});
}   // 单实例锁 else 分支闭合：只有拿到锁的实例才注册以上生命周期
