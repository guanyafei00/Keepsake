// 公众号订阅追更（M-A5）：微信读书接口路线（wewe-rss 同原理，clean-room 重写）。
// 设计文档：deliverables/software-company/keepsake-gongzhonghong-sub-design-2026-10-31.md
//
// 核心约束：
//   ① 登录态只存 session 分区（persist:weread，Chromium 加密存储），Node 侧每次请求前实时
//      动态拼装 Cookie 头——绝不落明文 cookie 文件（项目此前吃过凭证散落的亏）。
//   ② 节流闸：同一时刻只放行 1 个读书接口请求，任意两次请求间隔 ≥60s；订阅级检查间隔 ≥30 分钟
//      由 subs.js update 白名单强制。与 RSS/B站 共享 _subChain 串行队列天然错峰。
//   ③ 失效判定矩阵（§3.3）：errCode -2012/-2013 / 返回 HTML / 缺 wr_skey → expired，
//      不计 failStreak（失效不是站点错误），卡片红标 + 重新扫码后自动恢复。
//   ④ 契约校准声明（§3.1）：以下端点/参数为非官方接口，**以小号实测为准**——端点与字段映射
//      全部集中在本文件常量区，微信改版只需修这一个文件。
const { BrowserWindow, session } = require('electron');
const https = require('https');
const path = require('path');
const { atomicWrite, readJson } = require('./jsonfile');

// ---- 契约常量区（⚠ 以小号实测为准；改版只动这里）----
const PARTITION = 'persist:weread';
const HOME = 'https://weread.qq.com/';
const ENDPOINTS = {
  shelfSync: 'https://weread.qq.com/web/shelf/sync',
  mpSearch: 'https://weread.qq.com/web/mp/search',
  mpSubscribe: 'https://weread.qq.com/web/mp/subscribe',
  articleList: (mpId) => `https://weread.qq.com/web/mp/${encodeURIComponent(mpId)}/articlelist`,
  renewal: 'https://weread.qq.com/web/login/renewal',
};
// articlelist 条目 → 文章链接的字段映射（wewe-rss 实践拼法；实测确认后修订）
const ARTICLE_URL_FIELDS = { biz: '__biz', mid: 'mid', idx: 'idx', sn: 'sn' };
// articlelist 分页游标字段（实测确认后修订；逐级回落）
const CURSOR_FIELDS = ['nextMaxTime', 'maxTime', 'lastMaxTime'];
// articlelist 响应里条目数组的字段名（实测确认后修订；逐级回落）
const LIST_FIELDS = ['articles', 'list', 'items', 'data'];
const EXPIRED_CODES = new Set([-2012, -2013]);   // 读书侧登录失效信号码（wewe-rss 同款 + 类似鉴权码）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MIN_GAP_MS = 60 * 1000;            // 模块级请求闸：任意两次读书接口请求最小间隔
const RENEWAL_INTERVAL_MS = 12 * 3600 * 1000;   // 续期节流：距上次成功续期 >12h 才先续期
const API_TIMEOUT_MS = 15000;

let STATE_FILE = null;
let state = { nickname: null, lastRenewalAt: 0, expired: false };

function configure({ userData }) {
  STATE_FILE = path.join(userData, 'weread-state.json');
  state = readJson(STATE_FILE, {}, v => v && typeof v === 'object' && !Array.isArray(v));
  if (state.expired === undefined) state.expired = false;
  if (state.lastRenewalAt === undefined) state.lastRenewalAt = 0;
}
function saveState() {
  if (!STATE_FILE) return;
  try { atomicWrite(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { /* 状态文件写失败不致命 */ }
}

// ---- 失效判定矩阵（纯函数，单测覆盖；§3.3）----
// statusCode: HTTP 状态码；bodyText: 响应体原文
//   30x 重定向 / HTML 响应体 / errCode ∈ {-2012,-2013} → 登录已过期
//   errCode 0 或其他业务码 → 非失效（调用方按普通失败处理）
function isExpiredSignal(statusCode, bodyText) {
  if (statusCode === 301 || statusCode === 302) return true;
  const text = String(bodyText || '').trim();
  if (!text) return false;                       // 空 body：按请求失败处理，不判失效
  if (text.startsWith('<')) return true;         // 返回 HTML = 被 302 到登录页
  try {
    const j = JSON.parse(text);
    if (j && EXPIRED_CODES.has(Number(j.errCode))) return true;
  } catch (e) { /* 半截 JSON：不判失效，调用方按解析失败处理 */ }
  return false;
}

// ---- articlelist 响应 → feed 条目（纯函数，单测覆盖；§4.1 刻意 type:'feed' 复用 onNew 分流）----
// 条目 url 拼法：读书若直接回传 url 优先用；否则按 ARTICLE_URL_FIELDS 组装 mp.weixin 链接；
// 字段缺失 → url=null（调用方 itemUrl 兜底跳过该条，绝不拼出坏链）
function articleUrl(entry) {
  if (!entry) return null;
  if (entry.url && /^https?:\/\//i.test(String(entry.url))) return String(entry.url);
  const f = ARTICLE_URL_FIELDS;
  const biz = entry[f.biz], mid = entry[f.mid], idx = entry[f.idx], sn = entry[f.sn];
  if (biz && mid && idx && sn) {
    return `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=${encodeURIComponent(mid)}&idx=${encodeURIComponent(idx)}&sn=${encodeURIComponent(sn)}`;
  }
  return null;
}

function articleListToFeedItems(data) {
  const raw = Array.isArray(data) ? data : (data && LIST_FIELDS.map(k => data[k]).find(Array.isArray)) || [];
  return raw
    .filter(e => e && (e.articleId || e.id))
    .map(e => ({
      id: String(e.articleId || e.id),
      type: 'feed',
      text: String(e.title || '').slice(0, 80),
      url: articleUrl(e),
    }));
}

// 分页游标提取（实测确认后修订；取不到游标 = 首页即停，绝不盲翻）
function extractCursor(data) {
  if (!data || typeof data !== 'object') return 0;
  for (const k of CURSOR_FIELDS) {
    const v = Number(data[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

// 从公众号文章链接提取 __biz（weread:add 用；base64 风格值）
function extractBiz(url) {
  const m = String(url || '').match(/[?&]__biz=([A-Za-z0-9+/=]+)&?/);
  return m ? m[1] : null;
}

// ---- 节流闸（纯逻辑，可注入时钟单测）：串行 + 任意两次执行起始间隔 ≥ minGapMs ----
function createThrottleGate(minGapMs = MIN_GAP_MS, now = () => Date.now()) {
  let chain = Promise.resolve();
  let lastStart = -Infinity;
  return {
    run(fn) {
      const exec = async () => {
        const wait = Math.max(0, lastStart + minGapMs - now());
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastStart = now();
        return fn();
      };
      const p = chain.then(exec, exec);
      chain = p.then(() => {}, () => {});
      return p;
    },
  };
}
const gate = createThrottleGate();

// ---- 登录态与 cookie（Electron 侧）----
async function sessionCookies() {
  try {
    const ses = session.fromPartition(PARTITION);
    const all = await ses.cookies.get({});
    return all.filter(c => /(^|\.)weread\.qq\.com$/i.test(c.domain));
  } catch (e) { return []; }
}

async function hasSkey() {
  return (await sessionCookies()).some(c => c.name === 'wr_skey' && c.value);
}

// 每次请求前实时从分区拼 Cookie 头（不缓存副本，续期后自动生效；设计 §3.2）
async function ensureSessionCookie() {
  const cookies = await sessionCookies();
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

function markExpired() {
  if (state.expired) return false;
  state.expired = true;
  saveState();
  return true;
}

function clearExpired() {
  if (!state.expired) return false;
  state.expired = false;
  saveState();
  return true;
}

// 登录状态查询（weread:state）：cookie 实时探针 + state 文件
async function wereadState() {
  return {
    loggedIn: await hasSkey(),
    nickname: state.nickname || null,
    expired: !!state.expired,
    lastRenewalAt: state.lastRenewalAt || 0,
  };
}

async function logout() {
  closeLoginWindow();
  try {
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
  } catch (e) {}
  state = { nickname: null, lastRenewalAt: 0, expired: false };
  saveState();
  return { ok: true };
}

// ---- HTTP 层（Node https 直连，非浏览器窗口；§3.2 请求头）----
// 返回统一形态（§5.2）：
//   { ok:true, errCode, data } | { ok:false, expired, newlyExpired?, reason }
// Cookie 头每次调用实时从分区拼装（不缓存副本，续期后自动生效）
async function rawGet(url) {
  const cookie = await ensureSessionCookie();
  if (!/(^|;\s*)wr_skey=/.test(cookie)) {
    // 缺 wr_skey：从未登录 / 已被清（§3.3 第 4 行）
    return { ok: false, expired: true, newlyExpired: markExpired(), reason: '微信读书登录已过期，请重新扫码' };
  }
  return new Promise(resolve => {
    https.get(url, {
      headers: {
        'Cookie': cookie,
        'User-Agent': UA,
        'Referer': HOME,
        'Accept': 'application/json, text/plain, */*',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (isExpiredSignal(res.statusCode, d)) {
          resolve({ ok: false, expired: true, newlyExpired: markExpired(), reason: '微信读书登录已过期，请重新扫码' });
          return;
        }
        if (res.statusCode !== 200) {
          resolve({ ok: false, expired: false, reason: '读书接口 HTTP ' + res.statusCode });
          return;
        }
        try {
          const j = JSON.parse(d);
          resolve({ ok: Number(j.errCode) === 0, errCode: j.errCode, data: j });
        } catch (e) {
          resolve({ ok: false, expired: false, reason: '读书接口返回非 JSON（可能已改版，需校准端点）' });
        }
      });
      res.on('error', e => resolve({ ok: false, expired: false, reason: '网络中断: ' + e.message }));
    }).on('error', e => resolve({ ok: false, expired: false, reason: '网络请求失败: ' + e.message }))
      .setTimeout(API_TIMEOUT_MS, function () { this.destroy(new Error('读书接口请求超时')); });
  });
}

// 续期策略（§3.3）：距上次成功续期 >12h 先续一次；续期失败不判死（skey 可能未到期），
// 下次真实请求 -2012 再走判定矩阵
async function ensureRenewed() {
  if (Date.now() - (state.lastRenewalAt || 0) <= RENEWAL_INTERVAL_MS) return;
  const r = await rawGet(ENDPOINTS.renewal);
  if (r.ok) { state.lastRenewalAt = Date.now(); saveState(); }
}

// 统一出口：所有读书接口请求（检查/回溯/续期/搜索）共享同一个 60s 节流闸（§4.3）
async function apiGet(url) {
  return gate.run(async () => {
    await ensureRenewed();
    return rawGet(url);
  });
}

// ---- 5 个接口封装（§3.1）----
// 书架同步（登录态探针/备用；公众号在书架中以 MP_WX_ 前缀 bookId 呈现）
async function shelfSync() { return apiGet(ENDPOINTS.shelfSync); }

// 搜索公众号候选
async function mpSearch(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return { ok: false, expired: false, candidates: [], reason: '请输入公众号昵称' };
  const r = await apiGet(`${ENDPOINTS.mpSearch}?keyword=${encodeURIComponent(kw)}&maxCount=10`);
  if (!r.ok) return { ok: false, expired: !!r.expired, candidates: [], reason: r.reason };
  // 候选数组字段名以实测为准（逐级回落）
  const d = r.data || {};
  const arr = Array.isArray(d) ? d : (d.candidates || d.list || d.items || []);
  return {
    ok: true,
    candidates: arr.filter(x => x && (x.mpId || x.id)).map(x => ({
      mpId: String(x.mpId || x.id),
      title: String(x.title || x.nickname || '').slice(0, 40),
    })),
  };
}

// 关注公众号（加入读书书架；失败则后续拉不到列表）
async function mpSubscribe(mpId) {
  if (!mpId) return { ok: false, expired: false, reason: '缺少 mpId' };
  return apiGet(`${ENDPOINTS.mpSubscribe}?mpId=${encodeURIComponent(mpId)}`);
}

// 公众号文章列表 → feed 条目。pages=1 增量检查（首页 ~20 条窗口）；pages≤5 手动回溯。
// 增量语义（§3.1）：只对首页 + 至多 1 页翻页 diff，绝不高频全量翻页
async function fetchForSub(sub, pages = 1) {
  if (!sub || !sub.mpId) throw new Error('订阅缺少公众号 mpId');
  const out = [];
  let maxTime = 0;
  const n = Math.max(1, Math.min(5, Number(pages) || 1));
  for (let i = 0; i < n; i++) {
    const r = await apiGet(`${ENDPOINTS.articleList(sub.mpId)}?listMode=1&maxTime=${maxTime}&count=20`);
    if (!r.ok) {
      if (r.expired) {
        const e = new Error(r.reason);
        e.wereadExpired = true;   // main.js catch 据此跳过 failStreak（失效≠站点错误）
        throw e;
      }
      throw new Error(r.reason || '读书接口请求失败');
    }
    const items = articleListToFeedItems(r.data);
    out.push(...items);
    const cursor = extractCursor(r.data);
    if (!cursor || !items.length) break;   // 无游标/空页：首页即停
    maxTime = cursor;
  }
  return out;
}

// skey 续期（暴露给 UI/测试；常规路径由 ensureRenewed 自动触发）
async function renewal() {
  const r = await apiGet(ENDPOINTS.renewal);
  if (r.ok) { state.lastRenewalAt = Date.now(); saveState(); }
  return r;
}

// ---- 登录窗口（persist:weread 分区；参照 login.js 先例）----
let _loginWin = null;
function closeLoginWindow() {
  if (_loginWin && !_loginWin.isDestroyed()) { try { _loginWin.destroy(); } catch (e) {} }
  _loginWin = null;
}

function openLoginWindow() {
  if (_loginWin && !_loginWin.isDestroyed()) { _loginWin.show(); _loginWin.focus(); return Promise.resolve({ ok: false, reason: '登录窗口已打开' }); }
  return new Promise(resolve => {
    let settled = false, poll = null, bail = null;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (bail) clearTimeout(bail);   // M1：结算即清理 5 分钟兜底定时器，防残留定时器误杀下一次登录窗口
      resolve(val);
    };
    let win;
    try {
      win = new BrowserWindow({
        width: 430, height: 620, title: '登录微信读书（扫码）', autoHideMenuBar: true,
        webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
    } catch (e) {
      return finish({ ok: false, reason: '登录窗口创建失败: ' + String(e && e.message || e).slice(0, 80) });
    }
    _loginWin = win;
    // 导航限制：只许微信读书域名（尾锚 $|[/?#] 防 weread.qq.com.evil.com 同前缀伪造域绕过）；window.open 显式 deny（不重蹈 embed_browser QA 覆辙）
    win.webContents.on('will-navigate', (e, url) => { if (!/^https:\/\/([a-z0-9-]+\.)*weread\.qq\.com($|[/?#])/i.test(url)) e.preventDefault(); });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => { _loginWin = null; finish({ ok: false, reason: '登录窗口已关闭' }); });
    win.loadURL(HOME + '#login').catch(() => {});
    win.show();
    // 轮询分区 cookie：wr_vid 出现 = 扫码确认完成（读书登录成功即下发会话 cookie 组）
    poll = setInterval(async () => {
      try {
        if (!win || win.isDestroyed()) { finish({ ok: false, reason: '登录窗口已关闭' }); return; }
        const cookies = await sessionCookies();
        if (cookies.some(c => c.name === 'wr_vid' && c.value) && cookies.some(c => c.name === 'wr_skey' && c.value)) {
          state.expired = false;   // 登录成功即复位失效标记（weread:clearExpired 语义内建）
          saveState();
          finish({ ok: true });   // m1：先结算成功再关窗——destroy() 同步触发 'closed' 时 finish({ok:false}) 不得抢先
          closeLoginWindow();
        }
      } catch (e) { /* cookie 读取瞬时失败，等下一轮 */ }
    }, 1200);
    // 5 分钟兜底：扫码不会更久了，防窗口永久滞留；句柄入 bail，finish 时统一清理（M1）
    bail = setTimeout(() => { if (!settled) finish({ ok: false, reason: '登录超时（5 分钟未完成扫码），请重试' }); closeLoginWindow(); }, 5 * 60 * 1000);
  });
}

// 从公众号文章页提取公众号昵称（weread:add 贴链接路径用；公开页抓取，契约外辅助步骤，
// 字段模式以实测校准：页内 var nickname / json nick_name 两种常见形态）
function extractNicknameFromHtml(html) {
  const s = String(html || '');
  const m = s.match(/var\s+nickname\s*=\s*"([^"]+)"/) || s.match(/"nick_name"\s*:\s*"([^"]+)"/)
    || s.match(/var\s+nickname\s*=\s*'([^']+)'/) || s.match(/id="js_name"[^>]*>\s*([^<]+?)\s*</);
  return m ? m[1].trim().slice(0, 40) : null;
}

function fetchArticleNickname(articleUrl) {
  return new Promise(resolve => {
    try {
      https.get(articleUrl, {
        headers: { 'User-Agent': UA, 'Referer': 'https://mp.weixin.qq.com/' },
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(extractNicknameFromHtml(d)));
      }).on('error', () => resolve(null))
        .setTimeout(10000, function () { this.destroy(new Error('文章页超时')); });
    } catch (e) { resolve(null); }
  });
}

module.exports = {
  configure, wereadState, logout, openLoginWindow, closeLoginWindow, clearExpired, markExpired,
  shelfSync, mpSearch, mpSubscribe, fetchForSub, renewal,
  // 纯函数（离线单测）
  isExpiredSignal, articleListToFeedItems, articleUrl, extractCursor, extractBiz,
  createThrottleGate, extractNicknameFromHtml,
  // 常量（单测断言 / 校准参照）
  PARTITION, ENDPOINTS, MIN_GAP_MS, EXPIRED_CODES,
};
