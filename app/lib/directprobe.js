// 直连探测：隐藏窗口加载视频/笔记页，让页面自己过反爬，webRequest 截获播放器真实 CDN 流。
// 适用于抖音/快手/小红书等 yt-dlp/gallery-dl 均无法解析（JSVMP 签名/GraphQL+cookie/动态渲染）
// 的国内站。设计约束：纯探测不执行页面脚本之外的任何签名逻辑——反爬对抗交给 Chromium 本体，
// 永远比手写 a_bogus 移植活得久。
//
// 统一数据契约（#32）：所有站点返回同一形态——
//   成功：{ ok:true, site, kind:'video'|'images', url, urls, title, uploader, vid, coverUrl?, headers }
//   失败：{ ok:false, error }
// headers 携带下载请求必需的 UA/Referer（与探测窗口同环境，CDN 防盗链对齐）。
const path = require('path');

const MEDIA_URL_RE = /\.(mp4|m3u8|flv)(\?|$)|douyinvod\.com|bytecdn\.cn|zjcdn\.com\/aweme|kwaicdn\.com|gifshow\.com|yximgs\.com|appdirtybyte|finder\.video\.qq\.com|sns-video/i;
const IMG_RE = /\.(jpg|jpeg|png|webp|heic|gif|ico|svg|css|js|woff2?|ts|json)(\?|$)/i;

// 移动端 UA：抖音/快手分享页按 UA 出移动版，播放器才会发起带签名的 CDN 请求
const UA_MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
// 桌面 UA：小红书网页版 __INITIAL_STATE__ 在桌面渲染最稳（移动版会跳转 App 引导页）
const UA_XHS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function sanitizeName(s, fallback = 'video') {
  const t = String(s || '').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (t || fallback).slice(0, 80);
}

// 站点识别：从页面链接推断站点名（落盘目录与 headers 用）
function siteOf(pageUrl) {
  const u = String(pageUrl || '');
  if (/douyin\.com|iesdouyin/i.test(u)) return 'douyin';
  if (/kuaishou\.com|chenzhongtech/i.test(u)) return 'kuaishou';
  if (/xiaohongshu\.com|xhslink\.com/i.test(u)) return 'xiaohongshu';
  return 'direct';
}

// 页面 URL 里能抓到的内容 ID（媒体库溯源/文件名排重用）
function vidOf(pageUrl) {
  const m = String(pageUrl || '').match(/\/video\/(\d+)/) || String(pageUrl || '').match(/\/note\/(\d+)/)
    || String(pageUrl || '').match(/\/explore\/([\w-]+)/) || String(pageUrl || '').match(/\/discovery\/item\/([\w-]+)/)
    || String(pageUrl || '').match(/modal_id=(\d+)/) || String(pageUrl || '').match(/short-video\/([\w-]+)/);
  return m ? m[1] : null;
}

// ---- 小红书 __INITIAL_STATE__ 纯解析（可离线单测，不依赖 electron）----
// 返回 { kind, url, urls, title, uploader, vid } 或 null（页面结构变化/非笔记页）
function pickXhsImage(im) {
  // 无水印优先级：urlDefault（原始高清）> infoList 里 WB_DFT 场景 > infoList 最后一项（越靠后越高清）> url
  // livePhoto（实况图）没有可用的 urlDefault，取其静态高清帧
  if (!im) return null;
  if (im.urlDefault && !im.livePhoto) return im.urlDefault;
  const scenes = Array.isArray(im.infoList) ? im.infoList : [];
  for (const s of scenes) if (s && s.url && s.imageScene === 'WB_DFT') return s.url;
  for (let i = scenes.length - 1; i >= 0; i--) if (scenes[i] && scenes[i].url) return scenes[i].url;
  return im.url || null;
}

function parseXhsState(state) {
  try {
    const map = state && state.note && state.note.noteDetailMap;
    if (!map) return null;
    const cur = (state.note.currentNoteId && map[state.note.currentNoteId]) ? state.note.currentNoteId : Object.keys(map)[0];
    if (!cur) return null;
    const nd = map[cur] && map[cur].note;
    if (!nd) return null;
    const title = String(nd.title || nd.desc || '');
    const uploader = String((nd.user && (nd.user.nickname || nd.user.nickName)) || '');
    const vid = String(nd.noteId || cur || '');
    // 视频笔记：videoStream 里优先选码率最高的 mp4 完整流（m3u8 分段流仅在无 mp4 时兜底返回，
    // 由下载侧提示不支持合并，见 queue.runDirect）
    const streams = nd.video && nd.video.media && Array.isArray(nd.video.media.videoStream) ? nd.video.media.videoStream : null;
    if (streams && streams.length) {
      let best = null;
      for (const s of streams) {
        if (!s || !s.masterUrl) continue;
        if (!best) { best = s; continue; }
        const sMp4 = /\.mp4/i.test(s.masterUrl);
        const bMp4 = /\.mp4/i.test(best.masterUrl);
        if ((sMp4 && !bMp4) || (sMp4 === bMp4 && (s.videoBitrate || 0) > (best.videoBitrate || 0))) best = s;
      }
      if (best) return { kind: 'video', url: best.masterUrl, urls: null, title, uploader, vid };
    }
    // 图文笔记：无水印图组（去重保序）
    const list = Array.isArray(nd.imageList) ? nd.imageList : [];
    const urls = [];
    for (const im of list) {
      const u = pickXhsImage(im);
      if (u && !urls.includes(u)) urls.push(u);
    }
    if (urls.length) return { kind: 'images', url: null, urls, title, uploader, vid };
    return null;
  } catch (e) { return null; }
}

// 归一化成功结果（补 headers，保证契约字段齐整）
function okResult(site, kind, { url = null, urls = null, title = null, uploader = null, vid = null, coverUrl = null, ua = '', referer = '' } = {}) {
  return {
    ok: true, site, kind, url, urls,
    title: title || null, uploader: uploader || null, vid: vid || null, coverUrl,
    headers: { 'User-Agent': ua, 'Referer': referer },
  };
}

function originOf(pageUrl) {
  try { return new URL(pageUrl).origin + '/'; } catch (e) { return ''; }
}

// ---- 小红书探测：隐藏窗口读 __INITIAL_STATE__（图组/MP4 直链），兜底 webRequest 截获 MP4 ----
function _probeXiaohongshu(pageUrl, { BrowserWindow, timeoutMs = 25000 }) {
  return new Promise(resolveP => {
    let settled = false, win = null, mediaUrl = null, imgs = null;
    let meta = { title: null, uploader: null, vid: vidOf(pageUrl) };
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
      resolveP(val);
    };
    const tryFinish = () => {
      if (imgs && imgs.length) {
        finish(okResult('xiaohongshu', 'images', {
          urls: imgs, title: meta.title, uploader: meta.uploader, vid: meta.vid, ua: UA_XHS, referer: 'https://www.xiaohongshu.com/',
        }));
        return true;
      }
      if (mediaUrl) {
        finish(okResult('xiaohongshu', 'video', {
          url: mediaUrl, title: meta.title, uploader: meta.uploader, vid: meta.vid, ua: UA_XHS, referer: 'https://www.xiaohongshu.com/',
        }));
        return true;
      }
      return false;
    };
    const timer = setTimeout(() => {
      if (!tryFinish()) finish({ ok: false, error: '页面加载超时或需要安全验证，请在【设置 → 本土平台受控浏览】打开小红书受控浏览器中浏览并点击【📥 归档】' });
    }, timeoutMs);
    try {
      win = new BrowserWindow({
        show: false, width: 420, height: 760,
        webPreferences: { partition: 'xhsprobe-' + Date.now(), javascript: true, sandbox: true },
      });
      win.webContents.session.setUserAgent(UA_XHS);
      // 兜底截获：state 读取失败（安全验证/结构变更）时至少抓到播放器发出的 MP4
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
        try {
          if (details.url && !IMG_RE.test(details.url) && /\.mp4(\?|$)/i.test(details.url) && !mediaUrl) mediaUrl = details.url;
        } catch (e) {}
        cb({});
      });
      const readState = async () => {
        try {
          const raw = await win.webContents.executeJavaScript(
            'JSON.stringify(window.__INITIAL_STATE__ && window.__INITIAL_STATE__.note ? { note: window.__INITIAL_STATE__.note } : null)', true);
          if (raw && raw !== 'null') {
            const parsed = parseXhsState(JSON.parse(raw));
            if (parsed) {
              if (parsed.title) meta.title = parsed.title;
              if (parsed.uploader) meta.uploader = parsed.uploader;
              if (parsed.vid) meta.vid = parsed.vid;
              if (parsed.kind === 'video' && parsed.url) mediaUrl = parsed.url;
              if (parsed.kind === 'images' && Array.isArray(parsed.urls)) imgs = parsed.urls;
            }
          }
        } catch (e) {}
      };
      win.webContents.on('did-finish-load', async () => {
        // 短链（xhslink）要经一跳重定向才到笔记页，分 3 次读 state（每次间隔 2s）
        for (let i = 0; i < 3 && !settled; i++) {
          await readState();
          if (tryFinish()) return;
          await new Promise(r => setTimeout(r, 2000));
        }
        if (!settled) setTimeout(() => {
          if (settled) return;
          if (!tryFinish()) finish({ ok: false, error: '未能从页面提取内容（可能需要登录或触发验证），请改用小红书受控浏览器浏览并一键归档' });
        }, 2500);
      });
      win.webContents.on('did-fail-load', () => { if (!mediaUrl && !imgs && !settled) finish({ ok: false, error: '页面加载失败（网络不可达或链接已失效）' }); });
      win.loadURL(pageUrl).catch(() => {});
    } catch (e) {
      finish({ ok: false, error: '探测窗口创建失败: ' + String(e && e.message || e).slice(0, 80) });
    }
  });
}

// ---- 抖音/快手探测：移动 UA 隐藏窗口 + 播放器流截获 + DOM 作者抓取 ----
// 抓标题/作者：优先读页面内嵌数据（__INITIAL_STATE__），回落 DOM 选择器，全 try/catch 防结构变更
const _metaJs = `(function(){
  var out = { title: null, uploader: null };
  try {
    var st = window.__INITIAL_STATE__ || null;
    var d = st && (st.awemeDetail || (st.aweme && st.aweme.detail)) || null;
    if (d) {
      out.title = d.desc || d.title || null;
      out.uploader = (d.author && (d.author.nickname || d.author.name)) || null;
    }
  } catch (e) {}
  try {
    if (!out.uploader) {
      var el = document.querySelector('.author-name, [class*="author-name"], [class*="nickname"]');
      if (el) out.uploader = el.textContent.trim().slice(0, 60) || null;
    }
    if (!out.title) {
      var de = document.querySelector('.video-info-detail, [class*="video-info"], [class*="title"], [class*="desc"]');
      if (de) out.title = de.textContent.trim().slice(0, 120) || null;
    }
    if (!out.title) out.title = document.title || null;
  } catch (e) {}
  return JSON.stringify(out);
})()`;

function _probeGeneric(pageUrl, { BrowserWindow, timeoutMs = 25000, site = 'direct' }) {
  return new Promise(resolveP => {
    let settled = false, win = null, mediaUrl = null, meta = { title: null, uploader: null };
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
      resolveP(val);
    };
    const tryFinish = () => {
      if (!mediaUrl) return false;
      finish(okResult(site, 'video', {
        url: mediaUrl, title: meta.title, uploader: meta.uploader, vid: vidOf(pageUrl), ua: UA_MOBILE, referer: originOf(pageUrl),
      }));
      return true;
    };
    const timer = setTimeout(() => {
      if (!tryFinish()) finish({ ok: false, error: '页面加载超时或未探测到视频流（站点可能弹验证/需登录，稍后重试）' });
    }, timeoutMs);
    try {
      win = new BrowserWindow({
        show: false, width: 420, height: 760,   // 手机竖屏比例：抖音/快手分享页都按 UA 出移动版
        webPreferences: { partition: 'directprobe-' + Date.now(), javascript: true, sandbox: true },
      });
      win.webContents.session.setUserAgent(UA_MOBILE);
      // 截获媒体请求：只认媒体 CDN/扩展名，排除图片静态资源
      win.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
        if (!details.url || IMG_RE.test(details.url)) return cb({});
        if (MEDIA_URL_RE.test(details.url)) {
          if (!mediaUrl || /mp4/i.test(details.url)) mediaUrl = details.url;   // mp4 优先（比 m3u8 免合并）
        }
        cb({});
      });
      win.webContents.on('did-finish-load', async () => {
        setTimeout(async () => {
          try {
            const raw = await win.webContents.executeJavaScript(_metaJs, true);
            if (raw) { const m = JSON.parse(raw) || {}; meta.title = m.title || null; meta.uploader = m.uploader || null; }
          } catch (e) {}
          if (!tryFinish()) {
            // 无流再等 2s 给播放器一次机会，仍无流按超时错误收场
            setTimeout(() => { if (!settled && !tryFinish()) finish({ ok: false, error: '页面加载超时或未探测到视频流（站点可能弹验证/需登录，稍后重试）' }); }, 2000);
          }
        }, 2500);   // 给播放器 2.5s 发起视频请求
      });
      win.webContents.on('did-fail-load', () => { if (!mediaUrl && !settled) finish({ ok: false, error: '页面加载失败（网络不可达）' }); });
      win.loadURL(pageUrl).catch(() => {});
    } catch (e) {
      finish({ ok: false, error: '探测窗口创建失败: ' + String(e && e.message || e).slice(0, 80) });
    }
  });
}

// 统一入口：probe(pageUrl, opts) -> Promise<DirectProbeResult>
//   site 参数可显式指定（外部已知站点时免二次推断），缺省由 URL 推断
async function probe(pageUrl, { timeoutMs = 25000, site = 'direct', electron = null } = {}) {
  let electronMod = null;
  try { electronMod = electron || require('electron'); } catch (e) { electronMod = null; }
  const BrowserWindow = electronMod && electronMod.BrowserWindow;
  if (!BrowserWindow) return { ok: false, error: '探测模块仅在主进程可用（Electron 运行时）' };
  const s = site !== 'direct' ? site : siteOf(pageUrl);
  if (s === 'xiaohongshu') return _probeXiaohongshu(pageUrl, { BrowserWindow, timeoutMs });
  return _probeGeneric(pageUrl, { BrowserWindow, timeoutMs, site: s });
}

// 归档落盘路径拼装（queue.runDirect 与单测共用）：
//   视频：{outDir}/{site}/{uploader}/{title} [{vid}].mp4
//   图文：{outDir}/{site}/{uploader}/{title} [{vid}]/（目录，图片由下载侧编号写入）
// uploader 空 → 「未分类作者」（媒体库 {站点}/{作者} 二级归拢不散落）
function directOutPath({ outDir, site, uploader, title, vid, kind = 'video' }) {
  const up = sanitizeName(uploader, '未分类作者');
  const tt = sanitizeName(title || vid || 'video', 'video');
  const suffix = vid ? ' [' + sanitizeName(String(vid), 'video') + ']' : '';
  return path.join(String(outDir), site, up, tt + suffix + (kind === 'images' ? '' : '.mp4'));
}

module.exports = { probe, sanitizeName, siteOf, vidOf, parseXhsState, pickXhsImage, directOutPath, MEDIA_URL_RE, IMG_RE, UA_MOBILE, UA_XHS };
