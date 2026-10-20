// 订阅管理：UP 主/频道更新即自动下载（M1 核心）
// 策略：
//   B站 UP 主  → 动态 feed API 单次请求（游客 cookie），覆盖图文+视频动态，轻量防风控
//   YouTube 频道 → yt-dlp --flat-playlist --playlist-items 1-5（增量只看最新几条）
//   首次检查只记录 knownIds（不回溯轰炸），之后每轮检查增量入队
//   源头删除感知：knownIds 里的 id 若从最新列表消失 → 标记 sourceDeleted（仅标记，绝不删本地文件）
const fs = require('fs');
const path = require('path');

// 平台化引擎文件名：win 加 .exe，mac/linux 裸名
function exe(n) { return process.platform === 'win32' ? n + '.exe' : n; }
const https = require('https');
const { spawn } = require('child_process');
const { atomicWrite, readJson } = require('./jsonfile');

let COOKIE = null;
let BIN = null;
let FILE = null;
let PROXY = null;
let GDL_CFG = null;   // gallery-dl 配置：stdout/stderr 强制 UTF-8（否则韩/日/emoji 被内部替换成字面 '???',环境变量救不回）
let PIXIV_AUTH = null;   // pixiv-auth.json：OAuth refresh_token 存放处（cookie 对 Pixiv 完全无效，见 lib/pixivauth.js）
let PIXIV_CFG = null;    // gdl-pixiv.json：gallery-dl 的 refresh-token 配置（授权后由 pixivauth 写入）
let COOKIE_BROWSER = ''; // 浏览器登录态来源（''=用 cookies.txt；chrome/edge/firefox/brave=引擎 --cookies-from-browser 直读，主程序经 setCookieBrowser 热更）
let subs = [];

function configure({ binDir, cookiePath, file }) {
  BIN = binDir; COOKIE = cookiePath; FILE = file;
  subs = readJson(FILE, [], Array.isArray);
  // 生成/刷新 gallery-dl 配置文件（随 subs.json 同目录）
  try {
    GDL_CFG = path.join(path.dirname(FILE), 'gdl-utf8.json');
    atomicWrite(GDL_CFG, JSON.stringify({ output: {
      stdout: { encoding: 'utf-8', errors: 'replace' },
      stderr: { encoding: 'utf-8', errors: 'replace' },
    } }));
  } catch (e) { GDL_CFG = null; console.warn('[subs] gdl config write fail:', e.message); }
  PIXIV_AUTH = path.join(path.dirname(FILE), 'pixiv-auth.json');
  PIXIV_CFG = path.join(path.dirname(FILE), 'gdl-pixiv.json');
}
// gallery-dl 启动参数前缀：配置文件先行（所有 spawn 共用）。
// gdl-pixiv.json 只在已授权后存在 → spawn 时才查，授权即时生效不用重启
function gdlBaseArgs() {
  const args = [];
  if (GDL_CFG) args.push('--config', GDL_CFG);
  if (PIXIV_CFG && fs.existsSync(PIXIV_CFG)) args.push('--config', PIXIV_CFG);
  return args;
}
function setCookieBrowser(b) { COOKIE_BROWSER = ['', 'chrome', 'edge', 'firefox', 'brave'].includes(b) ? b : ''; }

// cookie 来源参数（gallery-dl 用）：浏览器直读优先，回落 cookies.txt
function cookieArgs() {
  if (COOKIE_BROWSER) return ['--cookies-from-browser', COOKIE_BROWSER];
  return (COOKIE && fs.existsSync(COOKIE)) ? ['--cookies', COOKIE] : [];
}

// Pixiv 是否已 OAuth 授权（gallery-dl 的 Pixiv 通道只认 refresh-token，2026-10-17 实测）
function pixivAuthorized() {
  try { return !!JSON.parse(fs.readFileSync(PIXIV_AUTH, 'utf-8')).refresh_token; } catch (e) { return false; }
}
function setProxy(p) { PROXY = p || null; }
function save() { try { atomicWrite(FILE, JSON.stringify(subs, null, 2)); } catch (e) { console.warn('[subs] save fail:', e.message); } }
function list() { return subs.map(s => ({ ...s, known: undefined, knownCount: (s.known || []).length, goneSeen: undefined })); }
function get(id) { return subs.find(s => s.id === id); }

// （cookieHeader 已移除：全项目无调用的死代码，

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36', 'Referer': 'https://www.bilibili.com/', ...headers } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 80))); } });
    }).on('error', reject);
  });
}

function classify(url) {
  // B站合集/系列（/lists/{sid}、/channel/collectiondetail、/channel/seriesdetail）→ 独立 kind：
  // 走 yt-dlp BilibiliCollectionList/SeriesList（实测 119 项 flat 秒回），增量追更 + 全量回溯都在合集内
  const col = url.match(/space\.bilibili\.com\/(\d+)\/lists\/(\d+)/i)
    || url.match(/space\.bilibili\.com\/(\d+)\/channel\/(?:collectiondetail|seriesdetail)\?[^#]*?sid=(\d+)/i);
  if (col) return { kind: 'bili-collection', uid: col[1], sid: col[2], url: url.trim() };
  const m = url.match(/space\.bilibili\.com\/(\d+)/i);
  if (m) return { kind: 'bilibili', uid: m[1] };
  // X/Twitter 用户主页（不含单条推文 status 链接——那是任务队列的事）
  const x = url.match(/^(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/@?([A-Za-z0-9_]{1,15})\/?(\?.*)?$/i);
  if (x) return { kind: 'x', handle: x[1], url: 'https://x.com/' + x[1] };
  if (/youtube\.com\/(@|channel\/|c\/)/i.test(url) || /youtube\.com\/.*(\/videos)?$/i.test(url)) return { kind: 'youtube', url };
  // gallery-dl 通用订阅：用户/收藏/标签页 → simulate 清单做增量（机制对 gallery-dl 的 387 站通用）
  if (GDL_SITES.some(s => s.re.test(url))) return { kind: 'gdl', url: url.trim() };
  return null;
}

// gallery-dl 型订阅支持的站点（节选主流；其余贴链接走任务队列全量下）
const GDL_SITES = [
  { re: /pixiv\.net\/users?\//i, name: 'Pixiv 用户' },
  { re: /weibo\.(com|cn)\/[uUn]/i, name: '微博用户' },
  { re: /danbooru\.donmai\.us/i, name: 'Danbooru' },
  { re: /gelbooru\.com/i, name: 'Gelbooru' },
  { re: /yande\.re/i, name: 'yande.re' },
  { re: /konachan\.(com|net)/i, name: 'Konachan' },
  { re: /artstation\.com\/[^/]+\/?$/i, name: 'ArtStation 用户' },
  { re: /deviantart\.com\/[^/]+\/?$/i, name: 'DeviantArt 用户' },
  { re: /imgur\.com\/user\//i, name: 'Imgur 用户' },
  { re: /flickr\.com\/photos\//i, name: 'Flickr 相册' },
  { re: /pinterest\.\w+\/[^/]+\/?$/i, name: 'Pinterest 用户' },
  { re: /tumblr\.com\/blog\//i, name: 'Tumblr 博客' },
  { re: /reddit\.com\/(user|r)\//i, name: 'Reddit' },
  { re: /tiktok\.com\/@/i, name: 'TikTok 用户' },
  { re: /instagram\.com\/[A-Za-z0-9_.]+\/?(\?.*)?$/i, name: 'Instagram 用户' },
];

// 已知游客态必失败的站点（2026-10-17 实测：pixiv 用户页直接 AuthenticationError 要 refresh-token、
// instagram graphql 401、x 时间线需登录）——无对应域名 cookie 时添加阶段就告知，
// 别让用户点完「立即检查」才看到失败，再连点三次触发「连续失败暂停」
const GUEST_HOSTILE = ['pixiv.net', 'instagram.com', 'twitter.com', 'x.com'];
// cookies.txt 域清单（add 时一次性读；导入 cookie 后由 main.js 调 resetCookieCache 失效缓存）
let _cookieDomainsCache = null;
function cookieDomains() {
  if (_cookieDomainsCache) return _cookieDomainsCache;
  const set = [];
  try {
    if (COOKIE && fs.existsSync(COOKIE)) {
      for (const line of fs.readFileSync(COOKIE, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || (t.startsWith('#') && !t.startsWith('#HttpOnly_'))) continue;
        const d = (t.startsWith('#HttpOnly_') ? t.slice('#HttpOnly_'.length) : t).split('\t')[0];
        if (d) set.push(d.replace(/^\./, '').toLowerCase());
      }
    }
  } catch (e) {}
  _cookieDomainsCache = set;
  return set;
}
function resetCookieCache() { _cookieDomainsCache = null; }

// URL 推导兜底名（添加时即刻命名，不等网络回合）：
//   instagram.com/nasa → Instagram · nasa；x.com/foo → @foo；pixiv.net/users/6373294 → Pixiv · 6373294
// 拿到真名后由 adoptName 替换（_auto 标记=自动名，可被覆盖）；拿不到真名就保持这个，远比「订阅 6」清晰
function fallbackName(url, kind, handle) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  const segs = u.pathname.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } });
  if (kind === 'x') return handle ? '@' + handle : null;
  if (kind === 'youtube') {
    const at = segs.find(s => s.startsWith('@'));
    if (at) return at;
    if (segs[0] === 'channel' && segs[1]) return 'YouTube 频道 ' + segs[1].slice(0, 24);
    if (segs[0] === 'c' && segs[1]) return 'YouTube · ' + segs[1];
    return null;
  }
  if (kind !== 'gdl') return null;
  const gdlSite = GDL_SITES.find(s => s.re.test(url));
  const label = String((gdlSite && gdlSite.name) || u.hostname.replace(/^www\./i, '')).replace(/\s*(用户|相册|博客)$/, '');
  // 结构性段优先：/users/6373294/illustrations 取 users 后的 id，而不是尾段 illustrations
  let id = '';
  for (let i = 0; i < segs.length; i++) {
    if (/^(users?|u|member|members)$/i.test(segs[i]) && segs[i + 1]) { id = segs[i + 1]; break; }
  }
  if (!id) id = segs.find(s => /^\d{3,}$/.test(s)) || segs[segs.length - 1] || '';
  if (!id) return null;
  return label + ' · ' + String(id).slice(0, 30);
}

function add(url, name) {
  const c = classify(url.trim());
  if (!c) return { ok: false, reason: '支持 B站UP主/合集、YouTube频道、X用户、Pixiv/微博/Reddit/Instagram/Danbooru 等图站用户页（部分站点需先导入 cookie）' };
  const auto = name ? null : fallbackName(c.url, c.kind, c.handle);   // 用户没起名 → URL 兜底名（_auto 可被真名替换）
  const sub = {
    id: 's' + Date.now().toString(36), url: c.url || url.trim(),
    kind: c.kind, uid: c.uid || null, handle: c.handle || null,
    name: name || auto || ('订阅 ' + (subs.length + 1)),
    _auto: !!auto,                    // 自动兜底名标记：adoptName 见到就替换（区别于用户手起的名）
    lastCheck: 0, lastNew: 0, known: [], checked: 0,
    autoBackfill: false,   // 是否回溯历史由添加后的确认弹窗决定（用户拒绝必须生效，不许 10 分钟后偷跑）
    group: '',             // #70②：分组名（空=未分组）
    intervalMin: 0,        // #70②：检查频率档位（0=跟随全局 10 分钟；可选 10/30/60）
    userPaused: false,     // #70②：用户手动暂停（与连续失败自动暂停 paused 区分）
    autoTranscribe: false, // #70④：新下载自动转写出字幕
    latestN: 0,            // ★★#7：增量检查只入队最新 N 条（0=不限制；追更连载只留最新话的场景）
  };
  subs.push(sub);
  save();
  // 已知游客态必失败的站点：cookie 里没有该域名 → 添加时就提醒（检查只会 401/AuthenticationError）
  let warning = null;
  if ((c.kind === 'gdl' || c.kind === 'x') && !name) {
    let host = '';
    try { host = new URL(sub.url).hostname.toLowerCase(); } catch (e) {}
    if (host.includes('pixiv.net')) {
      // Pixiv 特殊：cookie 完全无效（官方接口只认 OAuth refresh-token），有 cookie 也要走授权
      if (!pixivAuthorized()) warning = 'Pixiv 无法用 cookie 下载（官方接口只认 OAuth refresh-token）：设置 → Cookie 管理 → Pixiv 授权（一次性，登录即完成）';
    } else if (GUEST_HOSTILE.some(h => host.includes(h)) && !cookieDomains().some(d => host.includes(d))) {
      warning = '该站点需要登录 Cookie 才能检查更新：设置 → Cookie 管理，导入该站点的 cookies.txt 后再点订阅卡片的 ⟳';
    }
  }
  // B 站：异步拿真实 UP 主昵称（card 公开接口）；x/gdl：猜主页名（oEmbed / -K 元数据）——拿到就替换占位名
  if (c.kind === 'bilibili' && c.uid && !name) {
    biliName(c.uid).then(n => adoptName(sub.id, n)).catch(() => {});
  } else if ((c.kind === 'gdl' || c.kind === 'x') && !name) {
    guessName(sub.id);
  }
  return { ok: true, sub: { ...sub, known: undefined }, warning };
}

// 占位名（"订阅 N"）或自动兜底名（_auto）→ 真名替换（仅当还没被用户认领过）；改名后广播回调（队列标题同步用）
let _onName = null;
function onNameChange(cb) { _onName = cb; }
function adoptName(id, n) {
  if (!n) return;
  const s = get(id);
  if (!s) return;
  if ((s.name || '').startsWith('订阅 ') || s._auto) {
    s.name = String(n).slice(0, 40); s._auto = false; save();   // 真名落定，清自动名标记
    if (_onName) { try { _onName(id, s.name); } catch (e) {} }
  }
}

// X 主页显示名：oEmbed 公开接口（免 cookie、UTF-8 干净）。
// 不用 gallery-dl -K 取名的原因：其管道输出按 GBK+errors=replace 重编码，韩/日文名会被写成字面 '???'，环境变量救不回
async function xName(url) {
  try {
    const j = await getJson('https://publish.twitter.com/oembed?url=' + encodeURIComponent(url),
      { Referer: 'https://publish.twitter.com/' });
    const m = /Posts by ([^<]+?)</.exec(j.html || '');
    return m ? m[1].trim() : null;
  } catch (e) { return null; }
}

// gallery-dl 型订阅猜主页名：-K 拉单条元数据（不下载）。
// 注意 -j 不行——时间线这类目录型 URL 只输出目录结构拿不到作者信息；-K 是「key行 + 两空格value行」文本
function gdlName(url) {
  return new Promise(resolve => {
    const args = [...gdlBaseArgs(), '-K', '--range', '1-1'];
    args.push(...cookieArgs());
    if (PROXY) args.push('--proxy', PROXY);
    args.push(url);
    const dec = new TextDecoder('utf-8');
    const child = spawn(path.join(BIN, exe('gallery-dl')), args, { windowsHide: true });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.stdout.on('data', d => { buf = Buffer.concat([buf, d]); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => { clearTimeout(timer); resolve(parseKeywordsName(dec.decode(buf))); });
  });
}

// -K 文本解析：author['nick']/author['name']（twitter）等，按显示名优先级取
function parseKeywordsName(text) {
  const map = {};
  const re = /^([\w$]+)(?:\['(\w+)'\])?\s*$/;
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = re.exec(raw);
    if (m) { cur = m[2] ? m[1] + '.' + m[2] : m[1]; continue; }
    if (cur !== null && /^ {2}\S/.test(raw) && !(cur in map)) {
      const v = raw.slice(2).trim();
      if (v && v.length <= 40 && !/^\d+$/.test(v) && !/https?:\/\//i.test(v)) map[cur] = v;
    }
  }
  return map['author.nick'] || map['user.nick'] || map['author.name'] || map['user.name'] || map['screen_name'] || map['uploader'] || null;
}

// 统一取名入口：X 先 oEmbed（回落 -K），gdl 直接 -K；拿到就认领
function guessName(id) {
  const s = get(id);
  if (!s) return;
  const url = s.url;
  let p = s.kind === 'x' ? xName(url) : Promise.resolve(null);
  p.then(n => n || gdlName(url)).then(n => adoptName(id, n)).catch(() => {});
}

// B 站用户昵称（card 公开接口，轻量、一般不触发风控；失败静默回落占位名）
async function biliName(uid) {
  try {
    const j = await getJson(`https://api.bilibili.com/x/web-interface/card?mid=${uid}`);
    return (j.data && j.data.card && j.data.card.name) || null;
  } catch (e) { return null; }
}
function remove(id) {
  const i = subs.findIndex(s => s.id === id);
  if (i < 0) return false;
  subs.splice(i, 1); save(); return true;
}

// #70② 订阅属性更新（白名单字段，防注入未知键）
const UPDATABLE = ['userPaused', 'group', 'intervalMin', 'autoTranscribe', 'latestN'];
function update(id, patch) {
  const s = get(id);
  if (!s) return { ok: false, reason: '订阅不存在' };
  if (!patch || typeof patch !== 'object') return { ok: false, reason: '无效的更新内容' };
  for (const k of UPDATABLE) {
    if (patch[k] === undefined) continue;
    if (k === 'userPaused' || k === 'autoTranscribe') s[k] = !!patch[k];
    else if (k === 'group') s[k] = String(patch[k] || '').trim().slice(0, 20);
    else if (k === 'intervalMin') s[k] = [0, 10, 30, 60].includes(Number(patch[k])) ? Number(patch[k]) : 0;
    else if (k === 'latestN') {   // ★★#7：0=不限制；1-100 有效，越界归 0（宁可不限制也不静默吞更新）
      const n = Math.floor(Number(patch[k]));
      s[k] = Number.isFinite(n) && n >= 1 && n <= 100 ? n : 0;
    }
  }
  save();
  return { ok: true, sub: { ...s, known: undefined } };
}

// ★★#7（机制借鉴 VidBee 的 onlyDownloadLatest，clean-room 重写）：增量清单按「只下最新 N 条」截取。
// 纯函数便于单测。items 顺序 = 源站枚举顺序：图站/B站动态/YouTube 最新在前；合集按时间正序、最新在尾。
// 语义：被截掉的不是「下轮重试」而是「本轮直接记 known 跳过」——用户开了这档就是只要最新的，
// 老的增量若每轮都留作 fresh 会永久反复入队（去重闸只挡活跃任务，挡不住 done 后的重复入队）
function latestCut(items, latestN, newestAtTail) {
  const arr = Array.isArray(items) ? items : [];
  const n = Math.floor(Number(latestN) || 0);
  if (n < 1 || n >= arr.length) return { enqueue: arr, skipped: 0 };
  const enqueue = newestAtTail ? arr.slice(arr.length - n) : arr.slice(0, n);
  return { enqueue, skipped: arr.length - n };
}

// B站订阅检查：bili-probe.exe 探针（wbi 签名 + 每次刷新游客指纹）拉动态列表（投稿视频+图文动态）。
// 背景：直接 Node 调 API 被 TLS 指纹风控 -352；探针是 PyInstaller 独立 exe（Python 指纹可过），只读列表不下载。
// pages：翻页数。登录态下充电专属图文会占满动态列表前排，多翻页才能看到穿插其中的投稿视频。
function fetchBiliDynamic(uid, pages = 1) {
  return new Promise((resolve, reject) => {
    const args = [uid];
    if (COOKIE && fs.existsSync(COOKIE)) args.push(COOKIE);
    args.push(String(pages));
    // 探针内部已 reconfigure UTF-8 输出
    const dec = new TextDecoder('utf-8');
    const child = spawn(path.join(BIN, exe('bili-probe')), args, { windowsHide: true });
    let out = '', err = '';
    // 全量翻页可能几百页（每页 1.5s 间隔+请求耗时），给足 15 分钟
    const timer = setTimeout(() => child.kill('SIGKILL'), pages === 'all' ? 15 * 60000 : (pages > 1 ? 120000 : 40000));
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out.trim().split('\n').pop() || '{}');
        if (j.code !== 0) return reject(new Error('探针风控 code=' + j.code + '（稍后自动重试，或登录账号解除）'));
        resolve(j.items || []);
      } catch (e) { reject(new Error('探针输出异常: ' + (err || out).slice(0, 80))); }
    });
  });
}

// YouTube 频道检查：yt-dlp flat-playlist（maxItems=0 时拉全部视频）
function fetchViaYtDlp(url, maxItems = 5) {
  return new Promise((resolve, reject) => {
    const args = ['--dump-single-json', '--flat-playlist', '--no-warnings', '--skip-download', '--encoding', 'utf-8'];
    if (maxItems > 0) args.push('--playlist-items', `1-${maxItems}`);
    if (COOKIE_BROWSER) args.push('--cookies-from-browser', COOKIE_BROWSER);
    else if (fs.existsSync(COOKIE)) args.push('--cookies', COOKIE);
    if (PROXY) args.push('--proxy', PROXY);
    args.push(url);
    // 编码：yt-dlp 已强制 --encoding utf-8，按 UTF-8 解码；全量/大量条目清单超时放宽（X 时间线 200 条约需数分钟）
    const dec = new TextDecoder('utf-8');
    const child = spawn(path.join(BIN, exe('yt-dlp')), args, { windowsHide: true });
    let buf = Buffer.alloc(0), err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'),
      maxItems === 0 ? 10 * 60000 : (maxItems > 20 ? 5 * 60000 : 60000));
    child.stdout.on('data', d => { buf = Buffer.concat([buf, d]); });
    child.stderr.on('data', d => err += dec.decode(d, { stream: true }));
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      const out = dec.decode(buf);
      if (code !== 0) return reject(new Error((err.split('\n').find(l => l.includes('ERROR')) || ('yt-dlp exit ' + code)).slice(0, 120)));
      try {
        const j = JSON.parse(out);
        const items = (j.entries || []).map(e => ({ id: e.id, type: 'video', text: e.title || '', url: e.url || null }));
        items.channel = j.channel || j.uploader || null;   // 频道名（首次检查后替换订阅占位名）
        items.playlistTitle = j.title || null;             // 合集/播放列表标题（bili-collection 订阅名用）
        resolve(items);
      } catch (e) { reject(new Error('bad json from yt-dlp')); }
    });
  });
}

// gallery-dl 通用订阅检查：--simulate 拉清单（`# 文件名` 行，顺序=页面枚举顺序），文件名作 known id
function fetchViaGdl(url, maxItems = 20) {
  return new Promise((resolve, reject) => {
    const args = [...gdlBaseArgs(), '--simulate', '--range', `1-${maxItems}`];
    args.push(...cookieArgs());
    if (PROXY) args.push('--proxy', PROXY);
    args.push(url);
    const dec = new TextDecoder('utf-8');   // 配置文件已强制 gallery-dl 输出 UTF-8
    const child = spawn(path.join(BIN, exe('gallery-dl')), args, { windowsHide: true });
    let buf = Buffer.alloc(0), err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), maxItems > 20 ? 5 * 60000 : 120000);
    child.stdout.on('data', d => { buf = Buffer.concat([buf, d]); });
    child.stderr.on('data', d => { err += dec.decode(d, { stream: true }); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = dec.decode(buf);
      const items = [];
      let seq = 0;
      for (const raw of out.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.startsWith('#')) continue;
        const fname = line.slice(1).trim();
        if (!fname) continue;
        seq++;
        items.push({ id: fname, type: 'gdl', seq, text: fname });
      }
      if (!items.length) {
        const em = (err.split('\n').find(l => /error/i.test(l)) || '').trim();
        if (em) return reject(new Error(em.slice(0, 120)));
        // 退出码非 0 且无内容 = 拉取失败，绝不能当「空清单」把存量全判成删帖
        if (code !== 0) return reject(new Error('gallery-dl 退出码 ' + code + '（网络波动或 cookie 失效，下轮重试）'));
      }
      resolve(items);
    });
  });
}

// 老订阅补救：名字还是占位（如订阅时缺 cookie / API 瞬断）→ 每轮检查前后重试认领。
// _auto（URL 兜底名）同样要补救——真名到了就换掉「Instagram · nasa」这类临时名
// 返回 Promise（供入队前 await，标题才带真名）；非占位名/不支持的类型返回 null
function refreshName(id) {
  const s = get(id);
  if (!s) return null;
  if (!(s.name || '').startsWith('订阅 ') && !s._auto) return null;
  if (s.kind === 'bilibili' && s.uid) return biliName(s.uid).then(n => adoptName(id, n)).catch(() => {});
  if (s.kind === 'gdl' || s.kind === 'x') return guessName(id);
  return null;
}

// 检查一轮。回调 onNew(sub, item) 通知新内容
async function checkSub(sub, onNew) {
  let items = null;
  if (sub.kind === 'bilibili') items = await fetchBiliDynamic(sub.uid, 2);   // 翻 2 页——充电专属图文会占满第一页，投稿视频常被推到第二页
  else if (sub.kind === 'x') {
    // X 走 gallery-dl：yt-dlp 根本没有用户时间线提取器（--list-extractors 只有单条推文），
    // flat-playlist 必报 Unsupported URL；gallery-dl 的 twitter 提取器原生支持主页时间线，图+视频一起下（需 x.com cookie）
    items = await fetchViaGdl(sub.url, 20);
  }
  else if (sub.kind === 'gdl') items = await fetchViaGdl(sub.url, 20);
  else if (sub.kind === 'youtube') items = await fetchViaYtDlp(sub.url);
  // 合集订阅：flat-playlist 全量秒回（实测 119 项几秒），必须拉全量——合集按时间正序追加，
  // 只看前 N 条永远看不到新集（新内容在尾部）；known 集合本身有去重，全量不炸
  else if (sub.kind === 'bili-collection') items = await fetchViaYtDlp(sub.url, 0);
  if (!items) return { ok: false, reason: '未知订阅类型' };

  const known = new Set(sub.known || []);
  const fresh = items.filter(it => !known.has(it.id));
  // gone（源头删除）判定 v2（主人实证旧版误报）：只和「上一轮实际看到的窗口」比对——
  // 旧版拿全量 known（500条）对最新一页（12/20条），老帖滑出列表就被误判删除。
  // 窗口滑动宽容：本轮新增 freshCount 条新帖，会把 lastSeen 最老的 freshCount 条挤出列表（items 最新在前，被挤的在尾部），
  // 剩下的 missing 才算真删除。
  // gone（源头删除）判定 v3（连续 2 轮检查都消失才判定为删除。
  // 背景：B 站动态接口偶发瞬断/只返回部分列表，单轮「不见了」直接报删帖会误报。
  // 保留 v2 的窗口滑动宽容：本轮新增 freshCount 条新帖会把 lastSeen 最老的 freshCount 条挤出列表（正常滑动，非删除）。
  // goneSeen 记 { n: 连续消失轮数, t: 最近一次判消失的时间 }——id 滑出 lastSeen 窗口后观察不中断，
  // 30 分钟没有再次观察到即过期清除（防旧帖残留计数把「自然滑出」误判成删帖）
  const visible = new Set(items.map(it => it.id));
  const gs = sub.goneSeen || {};
  const nowMs = Date.now();
  const gone = [];
  let candidates;
  if (sub.kind === 'bili-collection') {
    // 合集=全量拉取（flat-playlist 秒回）：known 与 visible 均为全量，直接比对。
    // 旧代码拿 lastSeen(tail 100) 对全量窗口，头部老条目每轮都「不在窗口」→ 连续 2 轮后
    // 被误判源头删除（>100 项的合集每轮检查必误报，确定性 bug，主人实证）
    candidates = [...known].filter(id => !visible.has(id));
  } else {
    // 部分窗口类型（bilibili 翻 2 页 / gdl、x 取 20 条）：只与上一轮实际窗口比对 + 新帖挤出宽容。
    // 新帖在最前（倒序），把 lastSeen 最老的（尾部）挤出列表属正常滑动，不判删除。
    const missing = (sub.lastSeen || []).filter(id => !visible.has(id));
    // 部分返回防护：本轮条数不足上轮 60%（翻页瞬断只拿回部分列表）→ 本轮整体跳过判定，
    // 宁可漏报也不误报；下轮拉完整了再判（漏报可下轮补救，误报已骚扰用户）
    candidates = items.length < (sub.lastSeen || []).length * 0.6
      ? []
      : missing.slice(0, Math.max(0, missing.length - fresh.length));
  }
  for (const id of candidates) gs[id] = { n: (gs[id] ? gs[id].n : 0) + 1, t: nowMs };
  for (const id of Object.keys(gs)) {
    if (visible.has(id)) { delete gs[id]; continue; }   // 复活即清除
    if (candidates.includes(id)) continue;   // 本轮已计数，勿重复累加
    if (nowMs - (gs[id].t || 0) < 30 * 60 * 1000) {   // 仍在观察期内（约 3 轮检查）
      gs[id].n++; gs[id].t = nowMs;
    } else delete gs[id];   // 观察过期
  }
  // 统一判定：n >= 2 即删除。必须放在计数之后独立成环——
  // 旧写法把判定塞进上面的循环里，而本轮候选会被 continue 跳过，导致合集型
  // （候选每轮都出现）永远涨到 n 却永不判定，真删帖全部漏报（测试实锤）
  for (const id of Object.keys(gs)) {
    if (gs[id].n >= 2) { gone.push(id); delete gs[id]; }
  }
  sub.goneSeen = gs;
  // lastSeen = 最近观察窗口（gone 判定基准）：普通订阅列表最新在前取头部；
  // 合集按时间正序追加，新内容在尾部 → 取尾部 100，否则合集变长会误报「源头删帖」
  const seenIds = items.map(it => it.id);
  sub.lastSeen = (sub.kind === 'bili-collection' ? seenIds.slice(-100) : seenIds.slice(0, 100));

  // 基线判定：首次 或 known 为空（此前全失败空转的订阅，第一次真正拉到清单时也要做基线防轰炸）
  if (sub.checked === 0 || !(sub.known || []).length) {
    // 基线：只记录不下载；YouTube 用频道名，B 站由 card API 异步补，x/gdl 由元数据猜名
    sub.known = items.map(it => it.id);
    if (sub.kind === 'bili-collection' && items.playlistTitle) { sub.name = items.playlistTitle.replace(/^合集·/, ''); sub._auto = false; }
    else if (items.channel) { sub.name = items.channel; sub._auto = false; }
    else if (sub.kind === 'gdl' || sub.kind === 'x') guessName(sub.id);   // 加订阅时没名字的（如当时缺 cookie），检查通了再补一次
  } else {
    let recorded = 0, skippedLatest = 0;
    // ★★#7 只下最新 N 条：先截取本轮要入队的窗口，窗口外的 fresh 直接记 known（跳过语义见 latestCut 注释）
    const cut = latestCut(fresh, sub.latestN, sub.kind === 'bili-collection');
    skippedLatest = cut.skipped;
    const cutIds = new Set(cut.enqueue.map(i => i.id));
    for (const it of fresh) {
      if (!cutIds.has(it.id)) { known.add(it.id); continue; }
      // onNew 返回 false = 调用方判定本条未真正入队（如队列去重命中，而既有任务可能失败/被取消）。
      // 此时不记 known——下轮仍算 fresh 重查，防止增量被永久吞掉
      if (onNew && onNew(sub, it) === false) continue;
      known.add(it.id);
      recorded++;
    }
    sub.known = [...known].slice(-500);   // 防无限膨胀
    sub.lastNew = recorded;
    sub.lastSkippedLatest = skippedLatest;   // UI 展示「本轮因只下最新 N 条跳过 K 条」；0/undefined=未启用或无跳过
  }
  sub.lastCheck = Date.now();
  sub.checked++;
  sub.sourceDeleted = gone.length ? gone.length : 0;   // 仅提示用
  sub.gone = gone.slice(0, 20);   // 具体哪几条：供 UI 展示明细（只存 id，链回源用 itemUrl 规则）
  save();
  return { ok: true, fresh: fresh.length, total: items.length, gone: gone.length, skippedLatest: sub.lastSkippedLatest || 0, items: items.map(i => ({ id: i.id, type: i.type })) };
}

// 回溯下载（主人需求「订阅后立即下载」）：拉全部动态并逐条回调，不管 known——
// 由调用方按队列已有 URL 查重。youtube 回溯多拉一些（50 条）
async function backfill(id, onItem) {
  const sub = get(id);
  if (!sub) throw new Error('订阅不存在');
  let items = null;
  // 回溯拉全量：B站一直翻到没有更多动态；YouTube 拉频道全部视频；X 时间线拉最近 200 条媒体推文
  // （X 全量易触发限流且混入大量转推，200 条是速度与覆盖的平衡点）
  if (sub.kind === 'bilibili') items = await fetchBiliDynamic(sub.uid, 'all');
  else if (sub.kind === 'bili-collection') items = await fetchViaYtDlp(sub.url, 0);   // 合集回溯=全量清单（flat 秒回）
  else if (sub.kind === 'x') items = [];   // X 回溯由 main.js 的一个 gdl range 任务完成（yt-dlp 无时间线提取器，见 checkSub 注释）
  else if (sub.kind === 'youtube') items = await fetchViaYtDlp(sub.url, 0);
  else if (sub.kind === 'gdl') items = await fetchViaGdl(sub.url, 200);   // gallery-dl 型回溯：最近 200 项清单
  if (!items) throw new Error('未知订阅类型');
  const media = items.filter(it => it.type !== 'text');
  for (const it of media) { if (onItem) onItem(sub, it); }
  return { total: items.length, media: media.length };
}

function itemUrl(sub, it) {
  if (sub.kind === 'bilibili') return it.type === 'video'
    ? `https://www.bilibili.com/video/${it.id}`
    : `https://www.bilibili.com/opus/${it.id}`;
  if (sub.kind === 'bili-collection') return it.url || `https://www.bilibili.com/video/${it.id}`;
  if (sub.kind === 'x') return it.url || `https://x.com/i/web/status/${it.id}`;
  if (sub.kind === 'youtube') return `https://www.youtube.com/watch?v=${it.id}`;
  return null;
}

module.exports = { configure, list, get, add, remove, update, checkSub, itemUrl, backfill, setProxy, setCookieBrowser, refreshName, onNameChange, save, classify, resetCookieCache, gdlBaseArgs, pixivAuthorized, latestCut };
