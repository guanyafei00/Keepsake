// 受控内嵌浏览器管理器（#32）：微信视频号 + 小红书
// 独立持久会话（persist:channels / persist:xhs）：官方页面正常扫码登录一次，Cookie 由 Chromium
// 落盘长期保留，下次秒开免重登；webRequest 网络层监听播放器发起的真实媒体直链（视频号 CDN
// 带 token 时效签名、小红书 sns-video），配合窗口内「📥 归档」浮条一键入队下载。
// 设计约束：不逆向任何私有协议、不 Hook 外部微信客户端——只在自家 Chromium 里看官方页面，
// 对外表述为「本地受控浏览器与个人媒体备份」（只做不说红线）。
const { BrowserWindow, session } = require('electron');

const SITES = {
  channels: {
    site: 'weixin_channels',          // 落盘目录名/任务 site 标签
    partition: 'persist:channels',    // 独立持久会话：隔离 Cookie，防与 B 站/小红书串扰
    home: 'https://channels.weixin.qq.com/',
    title: '微信视频号 · 受控浏览器',
    width: 440, height: 780,
    // 媒体流特征：视频号 CDN 域名（带 token= 时效签名）+ mp4 扩展名兜底
    mediaRe: /finder\.video\.qq\.com|\.mp4(\?|$)/i,
    referer: 'https://channels.weixin.qq.com/',
    hint: '还没截获到视频流：请先在窗口里播放要归档的视频，再点【📥 归档】',
  },
  xhs: {
    site: 'xiaohongshu',
    partition: 'persist:xhs',
    home: 'https://www.xiaohongshu.com/',
    title: '小红书 · 受控浏览器',
    width: 440, height: 780,
    mediaRe: /sns-video|\.mp4(\?|$)/i,
    referer: 'https://www.xiaohongshu.com/',
    hint: '未取到内容：请先打开笔记页（图文/视频均可），再点【📥 归档】',
  },
};

const IMG_RE = /\.(jpg|jpeg|png|webp|heic|gif|ico|svg|css|js|woff2?|ts|json)(\?|$)/i;

// DOM 元数据抓取脚本（浮条点击后执行）：按站点取标题/作者/笔记 ID + 小红书图组/视频直链。
// 全程 try/catch 返回纯文本 JSON——站点改版只降级为空字段，绝不抛错卡住归档流程。
const META_JS = {
  channels: `(function(){
    var out = {};
    try {
      var el = document.querySelector('.desc, [class*="desc"], [class*="title"]');
      out.title = el ? el.textContent.trim().slice(0, 120) : (document.title || '');
      var a = document.querySelector('.anchor, [class*="nickname"], [class*="author"]');
      out.uploader = a ? a.textContent.trim().slice(0, 60) : '';
      var m = location.href.match(/\\/(?:profile|scene|post)\\/([\\w-]+)/);
      out.vid = m ? m[1] : '';
    } catch (e) {}
    return JSON.stringify(out);
  })()`,
  xhs: `(function(){
    var out = {};
    try {
      var st = window.__INITIAL_STATE__;
      if (st && st.note && st.note.noteDetailMap) {
        var map = st.note.noteDetailMap;
        var cur = (st.note.currentNoteId && map[st.note.currentNoteId]) ? st.note.currentNoteId : Object.keys(map)[0];
        var nd = cur && map[cur] && map[cur].note;
        if (nd) {
          out.title = nd.title || nd.desc || '';
          out.uploader = (nd.user && (nd.user.nickname || nd.user.nickName)) || '';
          out.vid = nd.noteId || cur || '';
          var vs = nd.video && nd.video.media && nd.video.media.videoStream;
          if (Array.isArray(vs)) {
            var best = null;
            for (var i = 0; i < vs.length; i++) {
              var s = vs[i];
              if (!s || !s.masterUrl) continue;
              if (!best || (/\\.mp4/i.test(s.masterUrl) && !/\\.mp4/i.test(best.masterUrl))
                || (/\\.mp4/i.test(s.masterUrl) === /\\.mp4/i.test(best.masterUrl) && (s.videoBitrate || 0) > (best.videoBitrate || 0))) best = s;
            }
            if (best) out.videoUrl = best.masterUrl;
          }
          var urls = [];
          var il = Array.isArray(nd.imageList) ? nd.imageList : [];
          for (var j = 0; j < il.length; j++) {
            var im = il[j], pick = null;
            if (im) {
              if (im.urlDefault && !im.livePhoto) pick = im.urlDefault;
              else if (Array.isArray(im.infoList)) {
                for (var k = 0; k < im.infoList.length; k++) {
                  if (im.infoList[k] && im.infoList[k].url && im.infoList[k].imageScene === 'WB_DFT') pick = im.infoList[k].url;
                }
                for (var k2 = im.infoList.length - 1; k2 >= 0 && !pick; k2--) {
                  if (im.infoList[k2] && im.infoList[k2].url) pick = im.infoList[k2].url;
                }
              } else if (im.url) pick = im.url;
            }
            if (pick && urls.indexOf(pick) < 0) urls.push(pick);
          }
          if (urls.length) out.imageUrls = urls;
        }
      }
      if (!out.title) out.title = document.title || '';
    } catch (e) {}
    return JSON.stringify(out);
  })()`,
};

// 浮条注入脚本：固定悬浮操作条 + 「📥 归档当前内容」按钮（点击置 window.__ksArchiveReq 标记，
// 主进程 900ms 轮询消费——页面主世界与 preload 隔离，走标记轮询最稳，不受 CSP/contextBridge 限制）
const TOOLBAR_JS = `(function(){
  try {
    if (document.getElementById('keepsake-bar')) return;
    var bar = document.createElement('div');
    bar.id = 'keepsake-bar';
    bar.style.cssText = 'position:fixed;left:12px;bottom:70px;z-index:2147483647;display:flex;gap:8px;align-items:center;background:rgba(20,24,32,.86);color:#fff;padding:8px 12px;border-radius:10px;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35)';
    var btn = document.createElement('button');
    btn.id = 'keepsake-bar-btn';
    btn.textContent = '📥 归档当前内容';
    btn.style.cssText = 'border:none;background:#38bdf8;color:#04283a;font-weight:700;padding:6px 12px;border-radius:8px;cursor:pointer';
    btn.onclick = function() {
      window.__ksArchiveReq = true;
      btn.textContent = '📥 处理中…';
      setTimeout(function() { var b = document.getElementById('keepsake-bar-btn'); if (b) b.textContent = '📥 归档当前内容'; }, 2500);
    };
    bar.appendChild(btn);
    var tip = document.createElement('span');
    tip.textContent = '播放后点此一键归档';
    tip.style.cssText = 'font-size:11px;opacity:.75';
    bar.appendChild(tip);
    (document.body || document.documentElement).appendChild(bar);
  } catch (e) {}
})()`;

class EmbedBrowserManager {
  /** 管理视频号/小红书两个平台各一个前台窗口单例与持久会话。 */
  constructor() {
    this._wins = { channels: null, xhs: null };
    this._captured = { channels: null, xhs: null };   // 最近截获的媒体载荷（CapturedMedia）
    this._pollTimer = { channels: null, xhs: null };
    this._onPayload = null;   // main 注入：payload → queue.add（免嗅探直落）
    this._onEvent = null;     // main 注入：{ siteKey, type, msg } 通知中转（toast）
  }

  /** 注入归档回调（main.js 在队列就绪后调用）。 */
  configure({ onPayload, onEvent } = {}) {
    if (onPayload) this._onPayload = onPayload;
    if (onEvent) this._onEvent = onEvent;
  }

  _emit(msg) { if (this._onEvent) { try { this._onEvent(msg); } catch (e) {} } }

  /** 打开（或唤起已存在的）受控窗口。单例：重复打开只 focus，绝不重复创建。 */
  open(siteKey, initialUrl) {
    const cfg = SITES[siteKey];
    if (!cfg) return { ok: false, reason: '未知平台: ' + siteKey };
    const w = this._wins[siteKey];
    if (w && !w.isDestroyed()) { w.show(); w.focus(); return { ok: true, reused: true }; }
    this._captured[siteKey] = null;
    const ses = session.fromPartition(cfg.partition);
    let win;
    try {
      win = new BrowserWindow({
        width: cfg.width, height: cfg.height, title: cfg.title, autoHideMenuBar: true,
        webPreferences: { partition: cfg.partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
    } catch (e) {
      return { ok: false, reason: '受控浏览器窗口创建失败: ' + String(e && e.message || e).slice(0, 80) };
    }
    this._wins[siteKey] = win;
    this._setupInterception(win, siteKey, cfg);
    win.webContents.on('did-finish-load', () => this._injectToolbar(win, siteKey));
    win.on('closed', () => {
      this._wins[siteKey] = null;
      if (this._pollTimer[siteKey]) { clearInterval(this._pollTimer[siteKey]); this._pollTimer[siteKey] = null; }
      try { ses.webRequest.onBeforeRequest(null); } catch (e) {}   // 注销拦截监听，防后台网络监听泄漏
    });
    // 导航限制：受控窗口只许访问本站域名（官方页外链跳第三方一律拦下，收住暴露面）
    const hostRe = siteKey === 'channels'
      ? /^https:\/\/([a-z0-9-]+\.)*(weixin|qq)\.com/i
      : /^https:\/\/([a-z0-9-]+\.)*(xiaohongshu|xhslink|xhscdn)\.com/i;
    win.webContents.on('will-navigate', (e, url) => { if (!hostRe.test(url)) e.preventDefault(); });
    // window.open / _blank 目标页不走 will-navigate，必须显式 deny 防绕过域名白名单开新窗
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.loadURL(initialUrl && /^https?:\/\//i.test(String(initialUrl)) ? String(initialUrl) : cfg.home).catch(() => {});
    win.show();
    return { ok: true };
  }

  /** 注册网络层媒体流监听：截获即记录（CapturedMedia），带时效签名以新换旧。 */
  _setupInterception(win, siteKey, cfg) {
    const ses = win.webContents.session;
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
      try {
        const u = details.url || '';
        if (u && !IMG_RE.test(u) && (details.resourceType === 'media' || cfg.mediaRe.test(u))) {
          this._capture(siteKey, u, ses);
        }
      } catch (e) {}
      cb({});
    });
  }

  _capture(siteKey, url, ses) {
    const cfg = SITES[siteKey];
    const prev = this._captured[siteKey];
    if (prev && prev.mediaUrl === url) return;
    this._captured[siteKey] = {
      site: cfg.site, siteKey, kind: 'video',
      mediaUrl: url, mediaUrls: null,
      title: (prev && prev.title) || null, uploader: (prev && prev.uploader) || null, coverUrl: null,
      headers: { 'User-Agent': ses.getUserAgent(), 'Referer': cfg.referer },
      timestamp: Date.now(),
    };
    this._emit({ siteKey, type: 'captured', msg: '已截获媒体流：点受控窗口里的【📥 归档】即可保存' });
  }

  /** 页面加载完成后注入悬浮归档条（已注入则幂等跳过）并启动归档标记轮询。 */
  _injectToolbar(win, siteKey) {
    try {
      win.webContents.executeJavaScript(TOOLBAR_JS, true).catch(() => {});
    } catch (e) {}
    this._startPoll(win, siteKey);
  }

  _startPoll(win, siteKey) {
    if (this._pollTimer[siteKey]) clearInterval(this._pollTimer[siteKey]);
    this._pollTimer[siteKey] = setInterval(async () => {
      try {
        if (!win || win.isDestroyed()) { clearInterval(this._pollTimer[siteKey]); this._pollTimer[siteKey] = null; return; }
        const flag = await win.webContents.executeJavaScript('window.__ksArchiveReq === true', true);
        if (flag) {
          await win.webContents.executeJavaScript('window.__ksArchiveReq = false', true);
          this.archiveCurrent(siteKey);
        }
      } catch (e) { /* 页面跳转瞬间 executeJavaScript 会失败，忽略等下一轮 */ }
    }, 900);
  }

  /** 一键归档：DOM 抓标题/作者 + 取截获媒体/小红书图组 → onPayload 入队（免二次嗅探直落）。 */
  async archiveCurrent(siteKey) {
    const cfg = SITES[siteKey];
    const win = this._wins[siteKey];
    if (!cfg || !win || win.isDestroyed()) return;
    let meta = {};
    try {
      const raw = await win.webContents.executeJavaScript(META_JS[siteKey] || 'JSON.stringify({})', true);
      if (raw) meta = JSON.parse(raw) || {};
    } catch (e) {}
    const ua = win.webContents.session.getUserAgent();
    const headers = { 'User-Agent': ua, 'Referer': cfg.referer };
    const cap = this._captured[siteKey];

    // 小红书：图组归档（__INITIAL_STATE__ 无水印图）优先，其次视频直链，最后网络层截获流
    if (siteKey === 'xhs' && Array.isArray(meta.imageUrls) && meta.imageUrls.length) {
      return this._dispatch({
        site: 'xiaohongshu', kind: 'images', directUrl: null, directUrls: meta.imageUrls,
        title: meta.title || '', uploader: meta.uploader || '', vid: meta.vid || '', coverUrl: null, headers,
      }, siteKey);
    }
    if (siteKey === 'xhs' && meta.videoUrl) {
      return this._dispatch({
        site: 'xiaohongshu', kind: 'video', directUrl: meta.videoUrl, directUrls: null,
        title: meta.title || '', uploader: meta.uploader || '', vid: meta.vid || '', coverUrl: null, headers,
      }, siteKey);
    }
    if (cap && cap.mediaUrl) {
      return this._dispatch({
        site: cfg.site, kind: 'video', directUrl: cap.mediaUrl, directUrls: null,
        title: meta.title || cap.title || '', uploader: meta.uploader || cap.uploader || '',
        vid: meta.vid || '', coverUrl: cap.coverUrl || null, headers: cap.headers,
      }, siteKey);
    }
    this._emit({ siteKey, type: 'archive-fail', msg: cfg.hint });
  }

  _dispatch(payload, siteKey) {
    if (!this._onPayload) { this._emit({ siteKey, type: 'archive-fail', msg: '归档通道未就绪（下载队列未初始化）' }); return; }
    try {
      this._onPayload(payload);
      this._emit({ siteKey, type: 'archived', msg: '已加入下载队列：' + String(payload.title || payload.directUrl || '').slice(0, 40) });
      this._captured[siteKey] = null;   // 归档后清空截获，防同一直链重复入队
    } catch (e) {
      this._emit({ siteKey, type: 'archive-fail', msg: '入队失败：' + String(e && e.message || e).slice(0, 80) });
    }
  }

  /** 当前窗口与截获状态（channels:state / xhs:state 返回值）。 */
  state(siteKey) {
    const win = this._wins[siteKey];
    let currentTitle = null;
    try { if (win && !win.isDestroyed()) currentTitle = win.webContents.getURL(); } catch (e) {}
    return { isOpen: !!(win && !win.isDestroyed()), hasCaptured: !!this._captured[siteKey], currentTitle };
  }

  getCaptured(siteKey) { return this._captured[siteKey] || null; }

  /** 关闭窗口（只销毁界面实体，不清理 session 数据——persist 分区由 Chromium 管理在磁盘）。 */
  closeWindow(siteKey) {
    const win = this._wins[siteKey];
    if (win && !win.isDestroyed()) { try { win.destroy(); } catch (e) {} }
    this._wins[siteKey] = null;
  }

  closeAll() {
    for (const k of Object.keys(this._wins)) this.closeWindow(k);
    for (const k of Object.keys(this._pollTimer)) {
      if (this._pollTimer[k]) { clearInterval(this._pollTimer[k]); this._pollTimer[k] = null; }
    }
  }

  /** 清理站点持久会话（登录态/Cookie/缓存）——用户登出或换号时用。返回是否成功。 */
  async clearSession(siteKey) {
    const cfg = SITES[siteKey];
    if (!cfg) return false;
    this.closeWindow(siteKey);
    try {
      const ses = session.fromPartition(cfg.partition);
      await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'service_workers'] });
      await ses.clearCache();
      return true;
    } catch (e) { return false; }
  }
}

module.exports = { EmbedBrowserManager, SITES };
