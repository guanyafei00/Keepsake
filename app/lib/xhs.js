// lib/xhs.js — 小红书受控抓取（B 落地）：订阅主页笔记清单（user_posted）+ 单条笔记媒体解析
// 机制（MediaCrawler 思路 clean-room 自研，一行未搬）：persist:xhs 分区的隐藏窗口里加载官方页面，
//   让页面自己滚动自己请求——fetch/XHR hook 只「记录」页面自签名的 user_posted 响应体，
//   不做任何签名逆向（x-s/x-t 由页面环境自己算，天然有效）；笔记媒体从 __INITIAL_STATE__ 读。
// 登录态与受控浏览器窗口（embed_browser 的 xhs 分区）共享 persist:xhs，扫码一次长期复用。
// 失败语义：登录态失效抛 e.xhsExpired（main 短路不计 failStreak，同公众号 wereadExpired 模式）。
'use strict';
const { BrowserWindow } = require('electron');

// 固定正常 Chrome UA：Electron 默认 UA 带 Electron 字样，小红书会风控
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PARTITION = 'persist:xhs';
const REFERER = 'https://www.xiaohongshu.com/';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// 隐藏窗口公共创建（受控分区 + 域名锁 + 禁开新窗）
function _hiddenWindow() {
  const win = new BrowserWindow({
    show: false, width: 480, height: 900,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.webContents.setUserAgent(UA);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // dom-ready 尽早注入 hook：挂载时客户端发出的 user_posted 第一页若在注入前发出就永久漏掉
  win.webContents.on('dom-ready', () => { win.webContents.executeJavaScript(HOOK_JS, true).catch(() => {}); });
  return win;
}

// 被跳到登录页 = 分区登录态失效
function _assertLoggedIn(wc) {
  const u = wc.getURL() || '';
  if (/website-login|\/login/i.test(u)) {
    const e = new Error('小红书登录态失效（受控会话被跳转登录页）');
    e.xhsExpired = true;
    throw e;
  }
}

// 页面内 hook（幂等注入）：包裹 fetch/XHR，把 user_posted 响应体记到 window.__ksPosted。
// 只记录页面自己发起的签名请求，绝不主动构造 API 调用。
const HOOK_JS = `(function(){
  if (window.__ksHooked) return; window.__ksHooked = true;
  window.__ksPosted = [];
  function RECORD(j){ try { var d = j && j.data; if (d && Array.isArray(d.notes)) window.__ksPosted.push(d); } catch(e){} }
  try {
    var of = window.fetch;
    window.fetch = function(){ var args = arguments;
      var u = (args[0] && args[0].url) || args[0] || '';
      return of.apply(this, args).then(function(r){
        try { if (String(u).indexOf('/api/sns/web/v1/user_posted') >= 0) r.clone().json().then(RECORD).catch(function(){}); } catch(e){}
        return r;
      }); };
    var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, u){ this.__ksUrl = u; return oo.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function(){ var xhr = this;
      xhr.addEventListener('load', function(){
        try { if (String(xhr.__ksUrl || '').indexOf('/api/sns/web/v1/user_posted') >= 0) RECORD(JSON.parse(xhr.responseText)); } catch(e){}
      });
      return os.apply(this, arguments); };
  } catch(e){}
})()`;

// 主页 SSR 首屏提取：第一页笔记是服务端渲染进 __INITIAL_STATE__ 的，不走 user_posted 请求，
// hook 永远抓不到（此前最新一页整体缺失、顺序看似乱）。防御式兼容 snake/camel 与 noteCard 包装；
// 带 xsec_token 才收（无 token 打不开笔记页）。
const SSR_NOTES_JS = `(function(){
  var out = [];
  try {
    var st = window.__INITIAL_STATE__;
    var arr = st && st.user && (st.user.notes || st.user.userNotes);
    if (!Array.isArray(arr) && st && st.user && st.user.userPageData) arr = st.user.userPageData.notes;
    if (Array.isArray(arr)) {
      for (var i = 0; i < arr.length; i++) {
        var n = arr[i] || {}, nc = n.noteCard || n.note_card || {};
        var id = n.id || n.noteId || nc.noteId || '';
        var token = n.xsec_token || n.xsecToken || nc.xsec_token || nc.xsecToken || '';
        if (!id || !token) continue;
        out.push({
          id: id,
          type: (nc.type === 'video' || n.type === 'video') ? 'video' : 'normal',
          text: nc.displayTitle || nc.display_title || '',
          time: n.time || nc.time || n.lastUpdateTime || nc.lastUpdateTime || n.last_update_time || 0,
          token: token
        });
      }
    }
  } catch (e) {}
  return JSON.stringify({ userFound: !!(st && st.user), notes: out });
})()`;

// 笔记页媒体提取（页面环境执行）：与 embed_browser META_JS.xhs 同族（图组 WB_DFT 无水印 / 视频选最优流）
const NOTE_META_JS = `(function(){
  var out = {};
  try {
    var st = window.__INITIAL_STATE__;
    var m = st && st.note && st.note.noteDetailMap;
    if (m) {
      var cur = (st.note.currentNoteId && m[st.note.currentNoteId]) ? st.note.currentNoteId : Object.keys(m)[0];
      var nd = cur && m[cur] && m[cur].note;
      if (nd) {
        out.title = nd.title || nd.desc || '';
        out.uploader = (nd.user && (nd.user.nickname || nd.user.nickName)) || '';
        out.vid = nd.noteId || cur || '';
        var vs = (nd.video && nd.video.media && (nd.video.media.stream || nd.video.media.videoStream)) || null;
        // 真实结构（2026-11-19 探针实证）：nd.video.media.stream 是按流组号分的对象（EF4/EF5/EF6/EF7，
        // 多数为空数组，非空数组内才有 masterUrl/videoBitrate）；兼容数组形旧结构
        var flats = [];
        if (Array.isArray(vs)) flats = vs;
        else if (vs && typeof vs === 'object') {
          for (var kk in vs) {
            var gr = vs[kk];
            if (Array.isArray(gr)) flats = flats.concat(gr);
            else if (gr && gr.masterUrl) flats.push(gr);
          }
        }
        var best = null;
        for (var i = 0; i < flats.length; i++) {
          var s = flats[i];
          if (!s || !s.masterUrl) continue;
          if (!best || (/\\.mp4/i.test(s.masterUrl) && !/\\.mp4/i.test(best.masterUrl))
            || (/\\.mp4/i.test(s.masterUrl) === /\\.mp4/i.test(best.masterUrl) && (s.videoBitrate || 0) > (best.videoBitrate || 0))) best = s;
        }
        if (best) out.videoUrl = best.masterUrl;
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
  } catch (e) {}
  return JSON.stringify(out);
})()`;

/** 抓博主主页笔记清单（订阅检查/回溯共用）。
 * 返回 { items: [{id,type,text,url}], mpName: 作者昵称|null }——items.mpName 走 checkSub 的 adoptName 通道。
 * 一页清单（~10-20 条）够增量窗口用；回溯同此窗口（诚实边界：受控翻页深度有限，全量历史不承诺）。 */
async function fetchPosted(uid, opts = {}) {
  const win = _hiddenWindow();
  try {
    const wc = win.webContents;
    await wc.loadURL('https://www.xiaohongshu.com/user/profile/' + uid, { timeout: 30000 }).catch(() => {});
    await delay(2500);
    _assertLoggedIn(wc);
    await wc.executeJavaScript(HOOK_JS, true).catch(() => {});
    // 页面进入时已发第一页 user_posted；滚动触发页面自己翻页（只滚几轮，拿一页窗口即可）
    let pages = [];
    for (let i = 0; i < 4; i++) {
      await wc.executeJavaScript('window.scrollBy(0, 1200)', true).catch(() => {});
      await delay(1800);
      const raw = await wc.executeJavaScript('JSON.stringify(window.__ksPosted || [])', true).catch(() => '[]');
      try { pages = JSON.parse(raw) || []; } catch (e) {}
      if (pages.length >= 1 && i >= 1) break;   // 至少一页且多滚一轮确认没有更多 → 收
    }
    // 作者昵称（页头 state）：首次检查回填订阅名
    const nickRaw = await wc.executeJavaScript(`(function(){
      var n = null;
      try {
        var st = window.__INITIAL_STATE__, u = st && st.user;
        n = (u && (u.nickname || (u.userPageData && u.userPageData.nickname) || (u.userData && u.userData.nickname))) || null;
        if (!n) { var el = document.querySelector('.username, [class*="nickname"]'); n = el ? el.textContent.trim() : null; }
      } catch(e){}
      return JSON.stringify({ n: n });
    })()`, true).catch(() => '{"n":null}');
    let nickname = null;
    try { nickname = (JSON.parse(nickRaw) || {}).n || null; } catch (e) {}
    // SSR 首屏（最新一页）在前，hook 翻页在后——整体保持最新在前（subs latestCut/lastSeen 窗口语义）
    const ssrRaw = await wc.executeJavaScript(SSR_NOTES_JS, true).catch(() => '{}');
    let ssr = [], userFound = false;
    try { const o = JSON.parse(ssrRaw) || {}; ssr = o.notes || []; userFound = !!o.userFound; } catch (e) {}
    // 汇总去重；time（unix 秒）供标题带发帖日期
    const seen = new Set(), items = [];
    const pushItem = (n) => {
      const id = n.id || n.note_id || '';
      if (!id || seen.has(id)) return;
      seen.add(id);
      const token = n.token || n.xsec_token || '';
      // time 归一成秒（SSR noteCard.time / user_posted time 可能是毫秒）：xhsDate 按秒处理
      const rawT = Number(n.time) || 0;
      items.push({
        id,
        type: n.type === 'video' ? 'video' : 'normal',
        time: rawT > 1e12 ? Math.floor(rawT / 1000) : rawT,
        text: (n.text || n.display_title || '小红书笔记 ' + id).slice(0, 80),
        url: token
          ? 'https://www.xiaohongshu.com/explore/' + id + '?xsec_token=' + encodeURIComponent(token) + '&xsec_source=pc_user'
          : null,
      });
    };
    for (const n of ssr) pushItem(n);
    for (const d of pages) for (const n of (d.notes || [])) pushItem(n);
    if (!items.length) {
      if (userFound) {
        // 用户态存在但 0 条笔记：真·空主页（新注册/没发过），合法返回空清单，不算失败
        return { items: [], mpName: nickname || null };
      }
      // 用户态都解析不到：页面结构变化或被风控，显式失败（UI 可见）而非静默空转
      console.warn('[xhs] fetchPosted 0 items 且 __INITIAL_STATE__.user 缺失 — 可能站点改版');
      const e = new Error('主页笔记清单为空（可能页面结构变化或被风控）');
      e.xhsParseEmpty = true;
      throw e;
    }
    return { items, mpName: nickname || null };
  } finally {
    try { win.destroy(); } catch (e) {}
  }
}

/** 解析单条笔记页 → 媒体直链（图组/视频）。入参须带 xsec_token（主页清单/分享链接自带）。
 * 返回 { title, uploader, vid, videoUrl?, imageUrls?, headers }——headers 供 direct 引擎带对来源下载。 */
async function resolveNote(noteUrl) {
  const win = _hiddenWindow();
  try {
    const wc = win.webContents;
    await wc.loadURL(noteUrl, { timeout: 30000 }).catch(() => {});
    await delay(2500);
    _assertLoggedIn(wc);
    // 等笔记 state 就绪（SPA 渲染 ~1-3s）
    for (let i = 0; i < 8; i++) {
      const ready = await wc.executeJavaScript(
        `(function(){try{var st=window.__INITIAL_STATE__,m=st&&st.note&&st.note.noteDetailMap;
          var cur=(st.note.currentNoteId&&m[st.note.currentNoteId])?st.note.currentNoteId:Object.keys(m||{})[0];
          return !!(cur&&m[cur]&&m[cur].note)}catch(e){return false}})()`, true).catch(() => false);
      if (ready) break;
      await delay(1200);
    }
    const raw = await wc.executeJavaScript(NOTE_META_JS, true).catch(() => '{}');
    const meta = JSON.parse(raw) || {};
    if (!meta.videoUrl && !(Array.isArray(meta.imageUrls) && meta.imageUrls.length)) {
      const e = new Error('笔记媒体解析为空（需登录态或笔记已删除/仅文字）');
      e.xhsParseEmpty = true;
      throw e;
    }
    return { ...meta, headers: { 'User-Agent': UA, 'Referer': REFERER } };
  } finally {
    try { win.destroy(); } catch (e) {}
  }
}

module.exports = { fetchPosted, resolveNote, UA, REFERER };
