// 公众号订阅追更（M-A5）：微信读书接口路线（wewe-rss 同原理，clean-room 重写）。
// 设计文档：deliverables/software-company/keepsake-gongzhonghong-sub-design-2026-10-31.md
//
// 核心约束：
//   ① 登录态只存 session 分区（persist:weread，Chromium 加密存储），Node 侧每次请求前实时
//      动态拼装 Cookie 头——绝不落明文 cookie 文件（项目此前吃过凭证散落的亏）。
//   ② 节流闸：同一时刻只放行 1 个读书接口请求，任意两次请求间隔 ≥60s；订阅级检查间隔 ≥30 分钟
//      由 subs.js update 白名单强制。与 RSS/B站 共享 _subChain 串行队列天然错峰。
//   ③ 失效判定矩阵（§3.3）：errCode -2010/-2012/-2013 / 登录页特征 HTML / 缺 wr_skey → expired，
//      不计 failStreak（失效不是站点错误），卡片红标 + 重新扫码后自动恢复。
//   ④ 契约校准声明（§3.1）：以下端点/参数为非官方接口，**以小号实测为准**——端点与字段映射
//      全部集中在本文件常量区，微信改版只需修这一个文件。
//      2026-11 端点全线校准：带有效 Cookie 逐条实测，/web/mp/search、/web/mp/subscribe、
//      /web/mp/<id>/articlelist、/web/login/renewal 全是 404 死链（不是登录过期）；现行路线改为
//      现行路线：/api/mp/cover 打底（实测 200，返回最新一篇）→ 文章链接 __biz 离线算出 bookId；
//      /web/mp/articles?bookId=&offset= 仅作风控放行时的历史增强（当前必现 -2041，静默回退）。
//      微信读书网页端搜不到公众号（scope/type 六种组合全返回出版书 type:0），按昵称搜索这条路不存在。
const { BrowserWindow, session } = require('electron');
const https = require('https');
const path = require('path');
const { atomicWrite, readJson } = require('./jsonfile');

// ---- 契约常量区（⚠ 以小号实测为准；改版只动这里）----
const PARTITION = 'persist:weread';
const HOME = 'https://weread.qq.com/';
// 2026-11 带有效登录 Cookie 逐条实测（wr_skey/wr_vid/wr_rt 全在）：下列 5 个端点 200；
// 旧 mpSearch / mpSubscribe / articleList / renewal 四个端点均 404 HTML，已删除，绝不再发请求。
// articles 的 offset 是「列表偏移量」（每页按返回条数递增），不是时间戳——旧 maxTime 游标已废弃。
const ENDPOINTS = {
  shelfSync: 'https://weread.qq.com/web/shelf/sync',
  bookIds: 'https://weread.qq.com/web/shelf/bookIds',
  articles: (bookId, offset) => `https://weread.qq.com/web/mp/articles?bookId=${encodeURIComponent(bookId)}&offset=${encodeURIComponent(offset)}`,
  content: (reviewId) => `https://weread.qq.com/web/mp/content?reviewId=${encodeURIComponent(reviewId)}`,
  cover: (bookId) => `https://weread.qq.com/api/mp/cover?bookId=${encodeURIComponent(bookId)}`,
};
// /web/mp/articles 响应字段（社区情报 we-mp-rss 解析代码，待真实文章链接带凭证实测校准；逐级回落）
// 结构：reviews[].subReviews[].review.{ reviewId, createTime, mpInfo.{ title, pic_url, time, originalId } }
const REVIEW_LIST_FIELDS = ['reviews', 'data', 'items', 'list'];      // 顶层列表容器
const SUB_REVIEW_FIELDS = ['subReviews', 'sub_reviews', 'reviews'];    // 每组子评论容器
const MP_INFO_FIELDS = ['mpInfo', 'mp_info', 'mpInfoVO'];              // 公众号信息容器
const EXPIRED_CODES = new Set([-2010, -2012, -2013]);   // -2010 缺登录态/用户不存在（content 无凭证实测）→ 需重新扫码；-2012 Cookie 过期；-2013 类似鉴权码
const RISK_CODES = new Set([-2041]);                    // 风控/旧 Cookie：普通失败，不判过期、不盲目重试
const RISK_REASON = '读书接口暂时拒绝请求，稍后再试';   // -2041 对外人话文案
// 登录页特征（2026-11 实测收窄：/web/mp/* 端点登录态下也可能 404+HTML，「HTML 一律判过期」会误报
// 登录已过期——只认登录页文案/路由特征，404 页、风控页、改版页走普通失败路径并带诊断信息）
const LOGIN_PAGE_RE = /weread\.qq\.com\/#login|扫码登录|请登录|登录微信读书|去登录/i;
const EXPIRED_REASON = '微信读书登录已过期，请重新扫码';   // 失效统一文案（诊断尾巴由 rawGet 追加）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MIN_GAP_MS = 60 * 1000;            // 模块级请求闸：任意两次读书接口请求最小间隔
const API_TIMEOUT_MS = 15000;
const ARTICLE_PAGE_TIMEOUT_MS = 5000;    // 文章页探针超时（实测正文页 ~3.5MB，5s 够用；风控页也要快失败）
const NO_BIZ_REASON = '这条链接读不到公众号标识。请在微信里打开该公众号任意一篇文章 → 右上角「…」→「复制链接」，再粘贴到这里';

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
//   30x 重定向 / 登录页特征 HTML / errCode ∈ {-2010,-2012,-2013} → 登录已过期
//   其余 HTML（404/风控/改版页）、-2041 风控码与其他业务码 → 非失效（调用方按普通失败处理）
function isExpiredSignal(statusCode, bodyText) {
  if (statusCode === 301 || statusCode === 302) return true;
  const text = String(bodyText || '').trim();
  if (!text) return false;                       // 空 body：按请求失败处理，不判失效
  // 收窄（2026-11 实测）：返回 HTML ≠ 被踢到登录页——旧 mp/* 端点全是 404+HTML 死链，
  // 只有带登录页特征的 HTML 才判过期，其余落「HTTP <状态码>」普通失败路径
  if (text.startsWith('<')) return LOGIN_PAGE_RE.test(text);
  try {
    const j = JSON.parse(text);
    if (j && EXPIRED_CODES.has(Number(j.errCode))) return true;
  } catch (e) { /* 半截 JSON：不判失效，调用方按解析失败处理 */ }
  return false;
}

// ---- /web/mp/articles 响应 → feed 条目（纯函数，单测覆盖；§4.1 刻意 type:'feed' 复用 onNew 分流）----
// 结构（社区情报 we-mp-rss，待真实文章链接带凭证实测校准）：
//   reviews[].subReviews[].review.{ reviewId, createTime, mpInfo.{ title, pic_url, time, originalId } }
//   reviewId 形如 <BOOK_ID>_<ARTICLE_TOKEN>；mpInfo.originalId 直接是 mp.weixin.qq.com/s/<token> 的短链 token
// 字段做多级回落；url 取不到就 null，调用方 itemUrl 兜底跳过该条，绝不拼出坏链。
// 文章短链 token：优先 mpInfo.originalId（可能是 token 也可能是整链，原样保留）；
// 缺失时从 reviewId 最后一段 _ 后取——实测读书把 token 里的 _ 编码成 ~（避免与 bookId 自身的 _ 冲突），
// 直接拼会拿到 31768B 风控空页，回落分支必须把 ~ 还原成 _ 才是可打开的短链。
// 只放行 URL 路径安全字符集——危险字符仍全拒，拿不到就 null。
function articleToken(originalId, reviewId) {
  const o = String(originalId || '').trim();
  if (o) {
    const bare = o.replace(/^(?:https?:\/\/)?mp\.weixin\.qq\.com\/s\//i, '').split(/[?#]/)[0];
    if (/^[A-Za-z0-9_~\-]{4,}$/.test(bare)) return bare;   // 显式 originalId 不做 ~ 还原
  }
  const parts = String(reviewId || '').split('_');
  const tail = (parts[parts.length - 1] || '').replace(/~/g, '_');   // 仅 reviewId 回落分支还原
  return /^[A-Za-z0-9_~\-]{4,}$/.test(tail) ? tail : null;
}

// /api/mp/cover 响应 → 1 条 feed（纯函数，单测覆盖）。
// 实测形态：{ name, title, reviewId, pic, avatar, template }——无 errCode 字段、只有最新一篇；
// name/pic/avatar 本期不用（显示名已有 subs 兜底；文章正文走 mp.weixin 短链交 article 引擎）。
function coverToFeedItem(data) {
  const c = data && typeof data === 'object' ? data : {};
  const reviewId = String(c.reviewId || c.review_id || '');   // 缺 reviewId → id 为空，调用方按 cover 不可用处理
  const token = articleToken(null, reviewId);
  return {
    id: reviewId,
    type: 'feed',
    text: String(c.title || '').slice(0, 80),
    url: token ? 'https://mp.weixin.qq.com/s/' + token : null,
  };
}

// 摊平出所有 review 对象：容器字段逐级回落，兼容「直接就是 review 列表」的返回形态。
// 无 reviewId 的条目不收（没 id 无法做增量 diff），也不计入 offset：fetchForSub 用本函数结果数推进偏移。
function flattenReviews(data) {
  let roots = [];
  if (Array.isArray(data)) roots = data;
  else if (data && typeof data === 'object') {
    for (const k of REVIEW_LIST_FIELDS) {
      const v = data[k];
      if (Array.isArray(v)) { roots = v; break; }
      if (v && typeof v === 'object' && Array.isArray(v.reviews)) { roots = v.reviews; break; }  // { data: { reviews: [] } }
    }
  }
  const out = [];
  for (const r of roots) {
    if (!r || typeof r !== 'object') continue;
    let nest = null;
    for (const k of SUB_REVIEW_FIELDS) if (Array.isArray(r[k])) { nest = r[k]; break; }
    const list = nest || [r];
    for (const s of list) {
      const rv = s && (s.review || s);
      if (rv && rv.reviewId) out.push(rv);
    }
  }
  return out;
}

function articleListToFeedItems(data) {
  return flattenReviews(data).map(rv => {
    let info = {};
    for (const k of MP_INFO_FIELDS) if (rv[k] && typeof rv[k] === 'object') { info = rv[k]; break; }
    const token = articleToken(info.originalId || info.original_id, rv.reviewId);
    return {
      id: String(rv.reviewId),
      type: 'feed',
      text: String(info.title || rv.title || '').slice(0, 80),
      url: token ? 'https://mp.weixin.qq.com/s/' + token : null,
    };
  });
}

// __biz（base64 数字串）→ 读书 bookId：'MP_WXS_' + base64_decode(__biz)（2026-11 社区情报，待带凭证实测校准）。
// 先 urldecode、补 = 到 4 的倍数、base64 解码成 utf8、去空白；/^\d+$/ 才拼前缀。
// 解不出纯数字就原样返回 biz 交给接口自己报错（绝不拼出假 bookId 把诊断带偏）。
function bizToBookId(biz) {
  const raw = String(biz || '').trim();
  if (!raw) return null;
  let s = raw;
  try { s = decodeURIComponent(s); } catch (e) { /* 非法 % 转义：按原文继续 */ }
  s = s.replace(/\s+/g, '');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);   // 复制链接常丢 padding
  let decoded = '';
  try { decoded = Buffer.from(s, 'base64').toString('utf8').trim(); } catch (e) { /* 解码失败走回落 */ }
  return /^\d+$/.test(decoded) ? 'MP_WXS_' + decoded : raw;
}

// 从公众号文章链接提取 __biz（weread:add 用；base64 风格值）。
// 复制出来的长链常把 & 转义成 &amp;、值写成 %3D%3D；参数也可能落在 #fragment 里；biz / __biz 两种别名都认。
// 只回传页面里真实存在的那段值，绝不编造 biz。
function extractBiz(url) {
  const s = String(url || '').replace(/&amp;/gi, '&');
  const m = s.match(/[?&#](?:__biz|biz)=([^&#\s]+)/i);
  if (!m) return null;
  let v = m[1];
  try { v = decodeURIComponent(v); } catch (e) { /* 非法 % 转义：按原值返回 */ }
  return v || null;
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
  state.lastExpiredDetail = null;   // 失效恢复后旧诊断随之作废
  saveState();
  return true;
}

// 登录状态查询（weread:state）：cookie 实时探针 + state 文件
async function wereadState() {
  return {
    loggedIn: await hasSkey(),
    nickname: state.nickname || null,
    expired: !!state.expired,
    lastRenewalAt: state.lastRenewalAt || 0,   // 兼容旧状态文件；续期端点已下线，此值不再更新
    // 最近一次失效诊断（statusCode/bodyHead/url/at；UI/日志可据此区分「真过期」与「端点异常」）
    lastExpiredDetail: state.lastExpiredDetail || null,
  };
}

async function logout() {
  closeLoginWindow();
  try {
    const ses = session.fromPartition(PARTITION);
    await ses.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] });
  } catch (e) {}
  state = { nickname: null, lastRenewalAt: 0, expired: false, lastExpiredDetail: null };
  saveState();
  return { ok: true };
}

// ---- HTTP 层（Node https 直连，非浏览器窗口；§3.2 请求头）----
// 返回统一形态（§5.2）：
//   { ok:true, errCode, data } | { ok:false, expired, newlyExpired?, reason }
// Cookie 头每次调用实时从分区拼装（不缓存副本，续期后自动生效）

// ---- 诊断摘要（2026-11 BugFix：失效/失败 reason 带结构化上下文，否则多种失败混进「过期」无法定位）----
// body 摘要：剥 HTML 标签 + 压空白后取前 60 字符（不回传完整 body，避免泄敏感信息）
function bodyDigest(bodyText) {
  return String(bodyText || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}
// body 形态标签：肉眼快速分类失败形态
function bodyKind(bodyText) {
  const t = String(bodyText || '').trim();
  if (!t) return '空 body';
  if (t.startsWith('<')) return 'HTML 页';
  try { JSON.parse(t); return 'JSON'; } catch (e) { return '非 JSON'; }
}
// 主机+路径（不含 query：bookId / keyword 等入参不进日志/状态文件）
function siteOf(url) {
  try { const u = new URL(url); return u.host + u.pathname; } catch (e) { return String(url || '').slice(0, 60); }
}
// 失败 reason 的结构化尾巴，如：（HTTP 404 | HTML 页 | weread.qq.com/web/mp/articles | <摘要>）
function diagSuffix(statusCode, bodyText, url) {
  const d = bodyDigest(bodyText);
  return `（HTTP ${statusCode} | ${bodyKind(bodyText)} | ${siteOf(url)}${d ? ' | ' + d : ''}）`;
}

async function rawGet(url) {
  const cookie = await ensureSessionCookie();
  if (!/(^|;\s*)wr_skey=/.test(cookie)) {
    // 缺 wr_skey：从未登录 / 已被清（§3.3 第 4 行）——确凿失效，无条件标记
    return { ok: false, expired: true, newlyExpired: markExpired(), reason: EXPIRED_REASON };
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
          const reason = EXPIRED_REASON + diagSuffix(res.statusCode, d, url);
          // 诊断信息随失效标记一并落盘（markExpired 内 saveState）；先写 detail 再标记，保证同一落盘包含诊断
          state.lastExpiredDetail = { statusCode: res.statusCode, bodyHead: bodyDigest(d), url: siteOf(url), at: Date.now() };
          const newly = markExpired();
          if (!newly) saveState();   // 早已是失效态：markExpired 跳过落盘，补一次保证最新诊断可查
          resolve({ ok: false, expired: true, newlyExpired: newly, reason });
          return;
        }
        if (res.statusCode !== 200) {
          // 404/风控/限流等：不是登录失效（2026-11 实测旧 mp/* 端点全是 404 死链），带诊断让改版可定位
          resolve({ ok: false, expired: false, reason: '读书接口请求失败' + diagSuffix(res.statusCode, d, url) });
          return;
        }
        try {
          const j = JSON.parse(d);
          // 部分端点（实测：/api/mp/cover、/web/shelf/bookIds）成功响应不带 errCode 字段，缺字段按 0 处理；
          // 否则 Number(undefined)=NaN 会被当成非零错误码，cover 主路径永远进不来
          const code = (j && j.errCode !== undefined && j.errCode !== null) ? Number(j.errCode) : 0;
          // -2041 风控/旧 Cookie：普通失败，人话文案，不判过期也不盲目重试
          if (RISK_CODES.has(code)) {
            resolve({ ok: false, expired: false, errCode: j.errCode, reason: RISK_REASON + diagSuffix(res.statusCode, d, url) });
            return;
          }
          if (code !== 0) {
            resolve({ ok: false, expired: false, errCode: j.errCode, reason: '读书接口返回错误码 ' + code + diagSuffix(res.statusCode, d, url) });
            return;
          }
          resolve({ ok: true, errCode: j.errCode, data: j });
        } catch (e) {
          resolve({ ok: false, expired: false, reason: '读书接口返回非 JSON（可能已改版，需校准端点）' + diagSuffix(res.statusCode, d, url) });
        }
      });
      res.on('error', e => resolve({ ok: false, expired: false, reason: '网络中断: ' + e.message + diagSuffix(0, '', url) }));
    }).on('error', e => resolve({ ok: false, expired: false, reason: '网络请求失败: ' + e.message + diagSuffix(0, '', url) }))
      .setTimeout(API_TIMEOUT_MS, function () { this.destroy(new Error('读书接口请求超时')); });
  });
}

// 统一出口：所有读书接口请求（检查/回溯/校准探针）共享同一个 60s 节流闸（§4.3）。
// 续期端点已下线（404），请求前不再做任何续期探测——真过期由业务响应的 -2010/-2012 按矩阵判定。
async function apiGet(url) {
  return gate.run(() => rawGet(url));
}

// ---- 接口封装（§3.1；端点全部集中在 ENDPOINTS，改版只动常量区）----
// 书架同步（登录态探针/备用；公众号在书架中以 MP_WXS_ 前缀 bookId 呈现）
async function shelfSync() { return apiGet(ENDPOINTS.shelfSync); }
// 书架 bookId 列表（校准备用；实测 200 {"data":[]}）
async function bookIds() { return apiGet(ENDPOINTS.bookIds); }
// 单篇文章内容（reviewId 来自列表；常规追更不拉正文——入口是 mp.weixin 短链走 article 引擎）
async function mpContent(reviewId) { return apiGet(ENDPOINTS.content(reviewId)); }
// 公众号封面（2026-11 实测可用主路径：200 返回最新一篇 name/title/reviewId/pic；见 fetchForSub）
async function mpCover(bookId) { return apiGet(ENDPOINTS.cover(bookId)); }

// 微信读书网页端搜不到公众号：scope=2/4、type=2 六种组合实测只返回出版书（bookId 纯数字、type:0），
// 社区工具 weread-mp-fetcher README 亦记录六种接口/参数组合全部无效。旧 /web/mp/search 是 404 死链，
// 故这里不发请求，直接给「贴文章链接」的人话提示（保留 IPC 形参兼容 UI 调用）。
async function mpSearch(keyword) {
  // keyword 仅保留 IPC 形参兼容（UI 仍会传），不再参与任何逻辑
  void keyword;
  return { ok: false, expired: false, candidates: [], reason: '微信读书不支持按名字搜公众号，请粘贴该公众号的一篇文章链接' };
}

// 公众号文章列表 → feed 条目。pages=1 增量检查；pages≤5 手动回溯。
// 2026-11 实测：/api/mp/cover 是可用主路径（200，最新一篇）；/web/mp/articles 当前必现 -2041 风控，只能当增强。
// 故 cover 打底 1 条，articles 可用再叠加历史（按 id 去重，cover 优先）；articles 任何普通失败静默忽略，
// 绝不让风控把整个检查判失败、也绝不误计 failStreak。offset 是列表偏移量（按返回条数递增），不是时间戳。
// _get 可注入（离线单测用假响应，不真发网络请求）；默认走共享 60s 节流闸的 apiGet。
async function fetchForSub(sub, pages = 1, _get = apiGet) {
  if (!sub || !sub.mpId) throw new Error('订阅缺少公众号 mpId');
  const n = Math.max(1, Math.min(5, Number(pages) || 1));
  const coverUrl = ENDPOINTS.cover(sub.mpId);

  // ① 主路径：cover。只有 expired 抛带标记的错；其余按普通失败抛（rawGet 的 reason 已带 diagSuffix 尾巴）。
  let coverRes = null;
  try { coverRes = await _get(coverUrl); }
  catch (e) { throw new Error('读书接口请求失败: ' + String(e && e.message || e) + diagSuffix(0, '', coverUrl)); }
  if (coverRes && coverRes.expired) {
    const e = new Error(coverRes.reason || EXPIRED_REASON);
    e.wereadExpired = true;   // main.js catch 据此跳过 failStreak（失效≠站点错误）
    throw e;
  }
  const item = coverRes && coverRes.ok ? coverToFeedItem(coverRes.data) : null;
  if (!coverRes || !coverRes.ok || !item || !item.id) {
    const baseReason = (coverRes && coverRes.reason) || '读书接口请求失败';
    // rawGet 的失败 reason 自带诊断尾巴；注入式依赖/异常路径不带时补上，保证 UI 能定位失败形态
    throw new Error(/（HTTP \d+ \|/.test(baseReason) ? baseReason : baseReason + diagSuffix(0, '', coverUrl));
  }
  const out = [item];
  // cover 带回公众号真名：挂在返回数组上（不改 fetchForSub 的数组返回契约），subs.checkSub 见到
  // items.mpName 会调 adoptName 认领，卡片显示「数字生命卡兹克」而不是「公众号 · T9_acg...」
  out.mpName = String((coverRes.data && (coverRes.data.name || coverRes.data.nickname)) || '').slice(0, 40) || null;
  const seen = new Set([item.id]);

  // ② 增强：articles 可用时叠加。只有 r.expired 才抛（真失效信号），其余一律静默忽略、不盲翻。
  let offset = 0;
  for (let i = 0; i < n; i++) {
    let r = null;
    try { r = await _get(ENDPOINTS.articles(sub.mpId, offset)); }
    catch (e) { break; }               // 请求失败：静默，cover 结果照常返回
    if (!r || !r.ok) {
      if (r && r.expired) {
        const e = new Error(r.reason || EXPIRED_REASON);
        e.wereadExpired = true;
        throw e;
      }
      break;                          // -2041/非零 errCode/非 200/非 JSON：静默，不抛错不判过期
    }
    const raw = flattenReviews(r.data);
    for (const it of articleListToFeedItems(r.data)) {
      if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
    }
    if (!raw.length) break;           // 空页即停
    offset += raw.length;             // 按原始条数推进，被过滤的无效条目不会造成重复拉取
  }
  return out;
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
          state.lastExpiredDetail = null;   // 旧诊断随之作废
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

// ---- 公众号文章页元数据（贴短链路径用；一次请求同时拿 biz + nickname）----
// host 白名单：主进程此前对用户传入 URL 直接 https.get，可构造 https://内网地址/?__biz=... 做内网探测
// （QA 报告问题 1）。对齐 main.js app:openExternal 的 URL 解析锚定主机名做法：只认 https +
// mp.weixin.qq.com 及其子域，其他一律不发请求。前缀/同前缀伪造域、userinfo 混淆都挡得住。
function weixinArticleUrl(articleUrl) {
  try {
    const u = new URL(String(articleUrl || ''));
    if (u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    return (host === 'mp.weixin.qq.com' || host.endsWith('.mp.weixin.qq.com')) ? u : null;
  } catch (e) { return null; }
}
function isWeixinArticleUrl(articleUrl) { return !!weixinArticleUrl(articleUrl); }

// 页内 biz：真实短链页实测 var biz = "MzIyMzA5NjEyMA=="（出现 17 次）；兼容 window.biz / "__biz":"..."。
// 只放行 /^Mz.../ 的 base64 形态——别的字符串一律不认，绝不编造 biz。
function extractBizFromHtml(html) {
  const s = String(html || '');
  const patterns = [
    /\bvar\s+biz\s*=\s*"([^"]+)"/i,
    /\bwindow\.biz\s*=\s*"([^"]+)"/i,
    /"__biz"\s*:\s*"([^"]+)"/i,
    /\bvar\s+biz\s*=\s*'([^']+)'/i,
    /\bwindow\.biz\s*=\s*'([^']+)'/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && /^Mz[A-Za-z0-9+/=]+$/.test(m[1])) return m[1];
  }
  return null;
}

// 页内常见实体解码（htmlDecode 包裹的字符串里会有 &amp; 之类）
function decodeHtmlText(text) {
  return String(text || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ').trim();
}

// 从公众号文章页提取昵称：真实短链页是 nickname = htmlDecode("数字生命卡兹克"（无 var、带函数调用），
// 旧正则匹配不到；其余形态（var nickname / "nick_name" / id="js_name"）保持兼容。
function extractNicknameFromHtml(html) {
  const s = String(html || '');
  const m = s.match(/var\s+nickname\s*=\s*"([^"]+)"/i)
    || s.match(/"nick_name"\s*:\s*"([^"]+)"/i)
    || s.match(/\bnickname\s*=\s*htmlDecode\(\s*"([^"]+)"/i)
    || s.match(/\bnickname\s*=\s*htmlDecode\(\s*'([^']+)'/i)
    || s.match(/\bnickname\s*=\s*htmlDecode\(\s*"([^"\n;)]+)/i)   // 页内脚本被截断/无闭合引号时也认
    || s.match(/var\s+nickname\s*=\s*'([^']+)'/i)
    || s.match(/id="js_name"[^>]*>\s*([^<]+?)\s*</i);
  return m ? decodeHtmlText(m[1]).slice(0, 40) : null;
}

// 文章页正文抓取（封顶 4MB：实测正常页 ~3.5MB，风控空页 31KB；异常大响应不撑内存）。
// 只由 fetchArticleMeta 在白名单通过后调用；_get 可注入供离线单测。
function fetchArticlePageHtml(articleUrl) {
  return new Promise(resolve => {
    try {
      https.get(articleUrl, {
        headers: { 'User-Agent': UA, 'Referer': 'https://mp.weixin.qq.com/' },
      }, res => {
        let d = '';
        res.on('data', c => { if (d.length < 4 * 1024 * 1024) d += c; });
        res.on('end', () => resolve(d));
        res.on('error', () => resolve(null));
      }).on('error', () => resolve(null))
        .setTimeout(ARTICLE_PAGE_TIMEOUT_MS, function () { this.destroy(new Error('文章页超时')); });
    } catch (e) { resolve(null); }
  });
}

// 一次请求同时返回 { biz, nickname }；非白名单直接 null 且绝不发请求（修内网探测面）。
async function fetchArticleMeta(articleUrl, _get = fetchArticlePageHtml) {
  const u = weixinArticleUrl(articleUrl);
  if (!u) return null;                       // 非白名单：直接 null，绝不发请求
  let html = null;
  // 用已校验过的规范化 URL 发请求，杜绝传入字符串被 https.get 二次解析绕过
  try { html = await _get(u.href); } catch (e) { return null; }
  if (!html) return null;
  return { biz: extractBizFromHtml(html), nickname: extractNicknameFromHtml(html) };
}

// 薄封装：旧调用点只要昵称（保持导出契约；同样受白名单与 5s 超时保护）
async function fetchArticleNickname(articleUrl) {
  const meta = await fetchArticleMeta(articleUrl);
  return meta ? meta.nickname : null;
}

module.exports = {
  configure, wereadState, logout, openLoginWindow, closeLoginWindow, clearExpired, markExpired,
  shelfSync, bookIds, mpContent, mpCover, mpSearch, fetchForSub, fetchArticleMeta, fetchArticleNickname,
  // 纯函数（离线单测）
  isExpiredSignal, articleListToFeedItems, coverToFeedItem, flattenReviews, articleToken, bizToBookId, extractBiz,
  createThrottleGate, extractNicknameFromHtml, extractBizFromHtml, isWeixinArticleUrl,
  // 常量（单测断言 / 校准参照 / 对外文案）
  PARTITION, ENDPOINTS, MIN_GAP_MS, EXPIRED_CODES, RISK_CODES, LOGIN_PAGE_RE, NO_BIZ_REASON,
};
