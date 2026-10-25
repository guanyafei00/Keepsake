// Pixiv OAuth 授权（PKCE）：gallery-dl 的 Pixiv 提取器走 app-api + OAuth2，只认
// extractor.pixiv.refresh-token 配置项——cookies.txt 里的 PHPSESSID 对它完全无效
// （2026-10-17 实测 v1.32.15/1.32.17 均报 AuthenticationError: 'refresh-token' required）。
// 授权契约来自 gppt 5.1.0 源码逆向：浏览器完成 OAuth 登录 → 深链 pixiv://account/login?code=...
// → 用 code + code_verifier 换 token（端点已探针验证：假 code 返回 HTTP 400 invalid_request，契约正确）。
// 登录窗注入 cookies.txt 里的 PHPSESSID：已登录用户大概率免输密码，直接跳到授权确认。
// token 只存本机 userData/pixiv-auth.json；gallery-dl 配置独立写 userData/gdl-pixiv.json——
// 不并进 gdl-utf8.json，因为 subs.js 和 queue.js 都会写那个文件，谁后写谁生效，独立才不被互相覆盖。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const LOGIN_URL = 'https://app-api.pixiv.net/web/v1/login';
const TOKEN_HOST = 'oauth.secure.pixiv.net';
const TOKEN_PATH = '/auth/token';
const REDIRECT_URI = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback';
// Pixiv Android 官方 app 的公开常量（gppt 同款；OAuth 公开客户端本就无保密性可言）
const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const PARTITION = 'persist:pixiv-login';   // 持久 session：浏览器侧登录态保留，下次授权免重复登录
// Electron 默认 UA 带 Electron 字样，Pixiv 登录页前面的云盾可能拦——伪装成普通 Chrome
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function authFile(userData) { return path.join(userData, 'pixiv-auth.json'); }
function gdlCfgFile(userData) { return path.join(userData, 'gdl-pixiv.json'); }

// PKCE（RFC 7636 S256）：verifier = base64url(32 随机字节)，challenge = base64url(sha256(verifier))
function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// 深链提取 code：pixiv://account/login?code=xxx&via=login → xxx
function extractCode(url) {
  const m = /[?&]code=([^&]+)/.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]) : null;
}

// cookies.txt（Netscape）→ pixiv.net 域的 cookie 清单（注入登录窗用，免重复输密码）
function pixivCookiesFrom(file) {
  const out = [];
  try {
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || (t.startsWith('#') && !t.startsWith('#HttpOnly_'))) continue;
      const p = (t.startsWith('#HttpOnly_') ? t.slice('#HttpOnly_'.length) : t).split('\t');
      if (p.length < 7) continue;
      if (!/pixiv\.net$/i.test(p[0].replace(/^\./, ''))) continue;
      out.push({ domain: p[0], path: p[2] || '/', secure: p[3].toUpperCase() === 'TRUE',
        expiry: Number(p[4]) || 0, name: p[5], value: p[6] });
    }
  } catch (e) {}
  return out;
}

// code + verifier → refresh_token（POST 表单，Pixiv iOS app UA——契约固定，换 UA 会被拒）
function exchangeToken(code, verifier) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET, include_policy: 'true',
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URI,
    }).toString();
    const req = https.request({
      hostname: TOKEN_HOST, path: TOKEN_PATH, method: 'POST', timeout: 30000,
      headers: {
        'User-Agent': 'PixivIOSApp/7.13.3 (iOS 14.6; iPhone13,2)',
        'App-OS': 'ios', 'App-OS-Version': '14.6',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j && j.refresh_token) return resolve(j);
          reject(new Error('Pixiv 返回 HTTP ' + res.statusCode + '：' + d.slice(0, 100)));
        } catch (e) { reject(new Error('Pixiv 响应异常 HTTP ' + res.statusCode)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Pixiv 授权服务器连接超时')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// 授权状态（设置页显示用）
function pixivState(userData) {
  try {
    const j = JSON.parse(fs.readFileSync(authFile(userData), 'utf-8'));
    return { authorized: !!j.refresh_token, userName: j.user_name || '', account: j.account || '', savedAt: j.savedAt || 0 };
  } catch (e) { return { authorized: false, userName: '', account: '', savedAt: 0 }; }
}

function saveAuth(userData, token) {
  const j = {
    refresh_token: token.refresh_token,
    user_id: token.user && token.user.id, user_name: token.user && token.user.name,
    account: token.user && token.user.account, savedAt: Date.now(),
  };
  fs.writeFileSync(authFile(userData), JSON.stringify(j, null, 2));
  fs.writeFileSync(gdlCfgFile(userData), JSON.stringify({ extractor: { pixiv: { 'refresh-token': token.refresh_token } } }, null, 2));
  return j;
}

function pixivLogout(userData) {
  try { fs.unlinkSync(authFile(userData)); } catch (e) {}
  try { fs.unlinkSync(gdlCfgFile(userData)); } catch (e) {}
  return { ok: true };
}

// ===== pixiv:// 内部协议接管（第 4 层，也是唯一真正拦得住的一层）=====
// 背景（实测）：页面用 window.location = 'pixiv://…' 跳转时，Chromium 不走
// 网络栈、也不触发 will-navigate——直接落给 OS「外部协议启动」，没装 Pixiv App 就弹
// 「获取打开此 pixiv 链接的应用」对话框，登录 code 就此丢失。前三种截获全被绕过。
// 修法：ready 前 registerSchemesAsPrivileged（standard）+ ready 后 protocol.handle 把
// pixiv:// 注册成 App 内部协议——导航永远进本进程 handler，绝不出手给系统。
// installPixivProtocol 在 main.js 的 app ready 后调用；registerSchemesAsPrivileged 在 main.js 顶层
// （Electron 限制：该函数全局只能调一次且必须在 ready 前）。
let _deepLinkSink = null;   // 当前授权窗口的深链回调（openPixivLoginWindow 挂载/清理）

function installPixivProtocol() {
  const { session } = require('electron');
  // 坑（实测）：授权窗口挂在 persist:pixiv-login 独立 session（webPreferences.partition），
  // 而 protocol.handle 是按 session 隔离的——只注册默认 session 等于白注册，授权窗里的 pixiv://
  // 照样落 OS 弹「获取应用」。必须把 handler 同时挂到默认 session 和授权窗用的 partition session。
  const handler = req => {
    try { if (_deepLinkSink && req && req.url) _deepLinkSink(req.url); } catch (e) {}
    // 返回一个空壳页（页面导航需要响应体）：提示用户可以关窗了，别留白屏
    return new Response('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#fff;color:#333;text-align:center;padding-top:40vh">✅ 授权处理中，本窗口可以关闭了</body>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  const targets = [session.defaultSession];
  try { targets.push(session.fromPartition(PARTITION)); } catch (e) {}
  let ok = true;
  for (const ses of targets) {
    try { ses.protocol.handle('pixiv', handler); }
    catch (e) { ok = false; console.warn('[pixivauth] protocol.handle fail (' + (ses === session.defaultSession ? 'default' : PARTITION) + '):', e.message); }
  }
  return ok;
}

// 打开授权窗口。onDone({ok, reason?|userName?}) 只回调一次
let win = null;
function openPixivLoginWindow(userData, opts, onDone) {
  if (win && !win.isDestroyed()) { win.focus(); return { ok: false, reason: 'Pixiv 授权窗口已打开' }; }
  const { BrowserWindow } = require('electron');   // 惰性 require：纯函数（pkce/extractCode…）单测可在非 Electron 环境跑
  const cc = pkce();
  win = new BrowserWindow({
    width: 420, height: 720, title: 'Pixiv 授权（登录后自动完成）', autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  let settled = false;
  let timer = null;
  const finish = (ok, extra = {}) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    _deepLinkSink = null;   // 窗口结束即摘钩子：protocol.handle 收到迟到深链也不再分发
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
    win = null;
    onDone({ ok, ...extra });
  };
  const onDeepLink = url => {
    const code = extractCode(url);
    if (!code) return;
    exchangeToken(code, cc.verifier)
      .then(tok => {
        try {
          const j = saveAuth(userData, tok);
          finish(true, { userName: j.user_name || j.account || '' });
        } catch (e) { finish(false, { reason: '保存授权失败：' + e.message }); }
      })
      .catch(e => finish(false, { reason: String(e.message || e).slice(0, 120) }));
  };

  // cookie 注入必须在 loadURL 之前完成（PHPSESSID 带上 → 已登录用户直接跳授权确认）
  (async () => {
    try {
      win.webContents.setUserAgent(BROWSER_UA);
      const ses = win.webContents.session;
      if (opts.proxy) { try { await ses.setProxy({ proxyRules: String(opts.proxy) }); } catch (e) {} }
      for (const c of pixivCookiesFrom(opts.cookieFile || '')) {
        try {
          await ses.cookies.set({
            url: 'https://www.pixiv.net/', name: c.name, value: c.value,
            domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain, path: c.path || '/',
            secure: c.secure, expirationDate: c.expiry > 0 ? c.expiry : undefined,
          });
        } catch (e) { /* 单条失败不阻塞（domain/path 组合偶发不合法） */ }
      }
    } catch (e) { /* 注入失败不等于授权失败：窗口仍可手动登录 */ }
    win.loadURL(LOGIN_URL + `?code_challenge=${cc.challenge}&code_challenge_method=S256&client=pixiv-android`);
  })();

  // 四重截获 pixiv:// 深链：
  // ④ protocol.handle（内部协议接管，installPixivProtocol 已在 app ready 时安装）——主框架
  //    location 跳转的必经之路，唯一能 100% 拦住不落 OS 的层
  // ① will-navigate；② did-fail-load 的 ERR_UNKNOWN_URL_SCHEME；③ webRequest——前两层在新版
  //    Electron 仍可能拦到部分场景（window.open/子资源），全留着兜底，宁可重复回调（settled 幂等）
  _deepLinkSink = onDeepLink;
  win.webContents.on('will-navigate', (e, url) => {
    if (/^pixiv:\/\//i.test(url)) { e.preventDefault(); onDeepLink(url); return; }
    // 登录窗只许访问 pixiv.net 域名（防页内外链跳走）
    if (!/^https:\/\/([a-z0-9-]+\.)*pixiv\.net/i.test(url)) e.preventDefault();
  });
  win.webContents.on('did-fail-load', (e, errorCode, desc, url) => {
    if (/^pixiv:\/\//i.test(url || '')) onDeepLink(url);
  });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['pixiv://*/*'] }, (details, cb) => {
    onDeepLink(details.url);
    cb({ cancel: true });
  });

  timer = setTimeout(() => finish(false, { reason: '授权超时（5 分钟），请重试' }), 5 * 60000);
  win.on('closed', () => {
    if (!settled) { settled = true; clearTimeout(timer); win = null; onDone({ ok: false, reason: '已取消' }); }
    else win = null;
  });

  return { ok: true };
}

// Promise 包装（IPC handler 用）
function pixivLogin(userData, opts = {}) {
  return new Promise(resolve => {
    const r = openPixivLoginWindow(userData, opts, res => resolve(res));
    if (!r.ok) resolve(r);   // 同步失败（窗口已开）立即返回
  });
}

module.exports = { pixivLogin, pixivState, pixivLogout, saveAuth, authFile, gdlCfgFile, pkce, extractCode, pixivCookiesFrom, exchangeToken, installPixivProtocol };
