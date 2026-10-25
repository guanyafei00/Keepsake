// 引擎自更新：风控对抗第一道防线——上游社区（yt-dlp/gallery-dl）每天在更新对抗规则，
// 我们只负责保持引擎最新。 yt-dlp: GitHub latest（重定向法绕 API 限流）
//                    gallery-dl: Codeberg API（不限流）
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

let BIN = null;          // 可写引擎目录（userData/engines）：更新落这里（装到 Program Files 时 resources/bin 只读）
let FALLBACK_BIN = null; // 随包目录（resources/bin）：本地版本探测的回退位
function configure({ binDir, fallbackBinDir }) { BIN = binDir; FALLBACK_BIN = fallbackBinDir || null; }

// 国内镜像回退（主人 2026-10-25：直连 GitHub/Codeberg 失败时自动换镜像重试）
// ghfast.top / gh-proxy.com 是通用 URL 前缀代理：原样转发官方文件，不改动内容；
// yt-dlp 下载后仍有官方 SHA2-256SUMS 校验兜底，gallery-dl 走 engine-stable.json 里的哈希（有就验）
const GH_MIRRORS = ['https://ghfast.top/', 'https://gh-proxy.com/'];
function urlCandidates(url) {
  const u = String(url || '');
  if (/^https:\/\/(github\.com|codeberg\.org)\//.test(u)) return [u, ...GH_MIRRORS.map(m => m + u)];
  return [u];
}

// 通用超时 GET（GitHub 半开连接不再让检查永久挂死）
function getWithTimeout(url, headers, handler, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      try { handler(res, resolve, reject); } catch (e) { reject(e); }
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}
function getRedirect(url) {
  return getWithTimeout(url, { 'User-Agent': 'Mozilla/5.0' }, (res, resolve, reject) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) resolve(res.headers.location);
    else { res.resume(); reject(new Error('no redirect: ' + res.statusCode)); }
  });
}
function getJson(url) {
  return getWithTimeout(url, { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, (res, resolve, reject) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
  });
}
function getText(url) {
  return getWithTimeout(url, { 'User-Agent': 'Mozilla/5.0' }, (res, resolve, reject) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => resolve(d));
  });
}
// 带镜像重试的文本拉取（yt-dlp SHA2-256SUMS 在 github.com，直连不通时走镜像）
async function getTextMirrored(url) {
  let lastErr = null;
  for (const u of urlCandidates(url)) {
    try { return await getText(u); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
// onProgress(received, total) 可选：引擎下载 20~30MB 要几十秒，没进度条用户以为卡死
// 直连失败自动换镜像前缀重试（主人 2026-10-25）
function download(url, dest, onProgress) {
  const cands = urlCandidates(url);
  const attempt = u => new Promise((resolve, reject) => {
    const get = (uu, redirects = 0) => {
      if (redirects > 5) return reject(new Error('too many redirects'));
      https.get(uu, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
        res.on('error', reject);   // 网络半途断开不再变未捕获异常（
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 镜像可能回相对路径重定向（实测 ghfast.top 回 '/https://...' 形式）——
          // new URL 解析成绝对再跟进；解析失败 reject 而不是让同步抛错击穿（ERR_INVALID_URL 实锤）
          try {
            const next = new URL(res.headers.location, uu).toString();
            try { return get(next, redirects + 1); }
            catch (e) { return reject(e); }   // https.get 对怪 URL 会同步抛，res 回调里必须接住
          } catch (e) { return reject(new Error('bad redirect: ' + res.headers.location)); }
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        // 停滞超时：连接挂起/半路断开时 https.get 可以永远不触发 error（实测 TLS 被网络层掐时直挂）。
        // 60s 无任何数据流动就主动断，别让「更新中」卡成无底洞
        res.setTimeout(60000);
        res.on('timeout', () => res.destroy(new Error('下载停滞超过 60 秒（网络中断？）')));
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let received = 0;
        res.on('data', c => { received += c.length; if (onProgress) { try { onProgress(received, total); } catch (e) {} } });
        const f = fs.createWriteStream(dest);
        res.pipe(f);
        f.on('finish', () => f.close(() => resolve(dest)));
        f.on('error', reject);
      }).on('error', reject);
    };
    get(u);
  });
  return (async () => {
    let lastErr = null;
    for (const u of cands) {
      try { return await attempt(u); } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('download failed');
  })();
}

// 引擎更新白名单（engine 只许这两个文件名，URL 只许可信发布域名——
// 堵死 renderer 被攻破后借 applyUpdate 任意下载/任意路径写 exe 的口子）。
// 每个引擎允许多个来源：官方稳定版 + 官方/自建开发版。
const ENGINE_ALLOW = {
  'yt-dlp.exe': [
    /^https:\/\/github\.com\/yt-dlp\/yt-dlp\/releases\/download\//,                 // 稳定版
    /^https:\/\/github\.com\/yt-dlp\/yt-dlp-master-builds\/releases\/download\//    // 官方 master 构建（每日）
  ],
  'gallery-dl.exe': [
    /^https:\/\/codeberg\.org\/mikf\/gallery-dl\/releases\/download\//,             // 稳定版
    /^https:\/\/github\.com\/guanyafei00\/Keepsake\/releases\/(download|latest\/download)\/gallery-dl-dev\.exe$/  // 自建开发版（上游 master 构建）
  ]
};

async function latestYtDlp() {
  const loc = await getRedirect('https://github.com/yt-dlp/yt-dlp/releases/latest');
  const tag = (loc.match(/tag\/(.+?)(?:\?|$)/) || [])[1];
  return { version: tag, url: `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/yt-dlp.exe`,
    page: 'https://github.com/yt-dlp/yt-dlp/releases/tag/' + tag,
    notes: await ghReleaseBody('yt-dlp/yt-dlp', tag) };
}
// yt-dlp 官方每日 master 构建（开发版通道）
async function latestYtDlpNightly() {
  const loc = await getRedirect('https://github.com/yt-dlp/yt-dlp-master-builds/releases/latest');
  const tag = (loc.match(/tag\/(.+?)(?:\?|$)/) || [])[1];
  return { version: tag, url: `https://github.com/yt-dlp/yt-dlp-master-builds/releases/download/${tag}/yt-dlp.exe`,
    page: 'https://github.com/yt-dlp/yt-dlp-master-builds/releases/tag/' + tag,
    notes: '官方每日自动构建，含最新修复（未经过完整测试，偶尔有副作用）' };
}
// GitHub release 正文（未认证 API 60 次/小时够用；失败降级为空，不挡检查）
async function ghReleaseBody(repo, tag) {
  try {
    const j = await getJson(`https://api.github.com/repos/${repo}/releases/tags/${tag}`);
    return String(j.body || '').slice(0, 800);
  } catch (e) { return ''; }
}
async function latestGalleryDl() {
  // releases/latest 可能只有源码资产（v1.32.16 实测无二进制，旧逻辑返回的 URL 404）。
  // 改为扫描最近 10 个 release，找最近一个带 gallery-dl.exe 的（与 engines_boot.gdlTag 同策略）
  const list = await getJson('https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases?limit=10');
  for (const rel of (Array.isArray(list) ? list : [])) {
    const asset = (rel.assets || []).find(a => a.name === 'gallery-dl.exe');
    if (asset) return { version: rel.tag_name, url: asset.browser_download_url,
      page: rel.html_url || 'https://codeberg.org/mikf/gallery-dl/releases',
      notes: String(rel.body || '').slice(0, 800) };
  }
  throw new Error('codeberg 最近 10 个 release 均无 gallery-dl.exe');
}

// ===== 自建开发版元数据（engine-dev.json 放 Pages 更新源同仓库）=====
// 结构：{ "gallery-dl.exe": { version, url, sha256, notes, built } }
// 为什么 gallery-dl 的 dev 要自建：上游只在正式 release 发 exe，master 分支没有现成二进制，
// 我们用 PyInstaller 从上游源码构建后传到 Keepsake Release（构建命令见工作区 2026-10-25 日志）。
// 为什么 yt-dlp 不需要：官方 yt-dlp/yt-dlp-master-builds 仓库每天发构建。
const DEV_META_URL = 'https://guanyafei00.github.io/fetchie-rules/engine-dev.json';
let _devMeta = null, _devMetaAt = 0, _stableMeta = null, _stableMetaAt = 0;
async function getDevMeta() {
  if (_devMeta && Date.now() - _devMetaAt < 600000) return _devMeta;   // 10 分钟缓存
  try {
    const j = await getJson(DEV_META_URL);
    _devMeta = (j && typeof j === 'object') ? j : {};
  } catch (e) { _devMeta = {}; }   // 拉不到 = 无 dev 通道，静默
  _devMetaAt = Date.now();
  return _devMeta;
}

// ===== 稳定版元数据兜底（engine-stable.json，与 dev 同仓库）=====
// 上游 API（github redirect / codeberg API）直连失败时用：Pages 直读 → jsdelivr 国内 CDN 镜像。
// 维护约定：每次确认有新引擎稳定版时更新此文件（sha256 有就带上，镜像下载的防篡改全靠它）
const STABLE_META_URLS = [
  'https://guanyafei00.github.io/fetchie-rules/engine-stable.json',
  'https://cdn.jsdelivr.net/gh/guanyafei00/fetchie-rules@main/engine-stable.json',
];
async function getStableMeta() {
  // 10 分钟成功缓存（对齐 getDevMeta）：打开设置页不必每次都重新拉 Pages——
  // 缓存只在成功时写入，全断不缓存，下次照常重试（兜底语义不变）
  if (_stableMeta && Date.now() - _stableMetaAt < 600000) return _stableMeta;
  for (const u of STABLE_META_URLS) {
    try {
      const j = await getJson(u);
      if (j && typeof j === 'object' && !Array.isArray(j)) { _stableMeta = j; _stableMetaAt = Date.now(); return j; }
    } catch (e) {}   // 试下一个源
  }
  return {};
}

// ===== 版本比较（显示用 + 自动更新降级防护）=====
// '1.33.0-dev' → 取数字段 [1,33,0]；解析不了返回 null（调用方只判相等）
function verKey(v) {
  const m = String(v || '').replace(/^v/, '').match(/(\d+(?:\.\d+)+)/);
  return m ? m[1].split('.').map(Number) : null;
}
function cmpVer(a, b) {
  const pa = verKey(a), pb = verKey(b);
  if (!pa || !pb) return String(a) === String(b) ? 0 : null;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x > y) return 1; if (x < y) return -1; }
  return 0;
}
// dev 构建识别：-dev / -nightly / master 字样的版本号（自动更新绝不碰这类本地版本）
function isDevVer(v) { return /-dev|-nightly|master/i.test(String(v || '')); }
function localVersion(engine) {
  return new Promise(resolve => {
    // 主目录优先（自更新新版），回退随包目录（首装未更新时 bundled 版也算本地版本）
    const exe = fs.existsSync(path.join(BIN, engine)) ? path.join(BIN, engine)
      : (FALLBACK_BIN && fs.existsSync(path.join(FALLBACK_BIN, engine)) ? path.join(FALLBACK_BIN, engine) : path.join(BIN, engine));
    if (!fs.existsSync(exe)) return resolve(null);
    let child;
    try { child = spawn(exe, ['--version'], { windowsHide: true }); }
    catch (e) { return resolve(null); }   // 文件损坏/非 PE：spawn 会同步抛错（实测 errno -4094），不能让它击穿 updateEngine
    let out = '';
    child.stdout.on('data', d => out += d);
    child.on('error', () => resolve(null));
    child.on('close', () => resolve((out.trim().split('\n')[0] || '').replace(/^v/, '')));
  });
}

// 检查全部引擎：每引擎给 稳定 stable + 开发 dev 两个可选通道
// 兼容字段（remote/url/needUpdate）保留 = 稳定通道语义，自动更新等旧消费方继续用
// 上游 API 全断 → 稳定版信息回落 Pages 固化元数据（engine-stable.json，jsdelivr 镜像兜底）
async function checkAll() {
  const [yLocal, gLocal, yRemote, gRemote, yNightly, devMeta, stableMeta] = await Promise.all([
    localVersion('yt-dlp.exe'), localVersion('gallery-dl.exe'),
    latestYtDlp().catch(() => null), latestGalleryDl().catch(() => null),
    latestYtDlpNightly().catch(() => null), getDevMeta(), getStableMeta()
  ]);
  const yUse = yRemote || (stableMeta['yt-dlp.exe'] ? stableMeta['yt-dlp.exe'] : null);
  const gUse = gRemote || (stableMeta['gallery-dl.exe'] ? stableMeta['gallery-dl.exe'] : null);
  const out = [];
  if (yUse) out.push({
    engine: 'yt-dlp.exe', local: yLocal,
    remote: yUse.version, url: yUse.url,
    needUpdate: yLocal !== String(yUse.version).replace(/^v/, ''),
    stable: { version: yUse.version, url: yUse.url, sha256: yUse.sha256 || '', notes: yUse.notes || '', page: yUse.page || (yRemote ? yRemote.page : '') || '' },
    dev: yNightly ? { version: yNightly.version, url: yNightly.url, sha256: '', notes: yNightly.notes || '', page: yNightly.page || '', built: '' } : null
  });
  if (gUse) out.push({
    engine: 'gallery-dl.exe', local: gLocal,
    remote: gUse.version, url: gUse.url,
    needUpdate: gLocal !== String(gUse.version).replace(/^v/, ''),
    stable: { version: gUse.version, url: gUse.url, sha256: gUse.sha256 || '', notes: gUse.notes || '', page: gUse.page || (gRemote ? gRemote.page : '') || '' },
    dev: (devMeta && devMeta['gallery-dl.exe']) ? { ...devMeta['gallery-dl.exe'], page: 'https://codeberg.org/mikf/gallery-dl/commits/branch/master' } : null
  });
  return out;
}

// 流式 sha256（外部大文件不再整包读进内存）
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', d => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}
// yt-dlp 官方 SHA2-256SUMS 里抽 yt-dlp.exe 行的哈希（无官方哈希的引擎返回 null，调用方降级为仅 allowlist+HTTPS）
function parseEngineSha(sumsText, engine) {
  const line = String(sumsText || '').split(/\r?\n/).find(l => l.trim().endsWith(engine));
  if (!line) return null;
  const m = /^([0-9a-fA-F]{64})\s+/.exec(line.trim());
  return m ? m[1].toLowerCase() : null;
}
// 从 release 下载 URL 推同 tag 的校验和文件 URL（仅 yt-dlp 官方发布 SHA2-256SUMS）
function sumsUrlFor(engine, url) {
  if (engine !== 'yt-dlp.exe') return null;
  const m = /releases\/download\/([^/]+)\//.exec(url);
  return m ? 'https://github.com/yt-dlp/yt-dlp/releases/download/' + m[1] + '/SHA2-256SUMS' : null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 更新单个引擎：下载 temp → 校验（大小+SHA-256 可得时）→ 备份旧版 → 替换。
// onProgress(received, total) 可选：供 UI 画下载进度条。
// 占用处理：Windows 下正被下载任务 spawn 的 exe 是锁住的——旧逻辑让用户「等队列完成后更新」，
// 现在下载随时可点，只让替换这一步等当前引擎进程结束（重试 12 次×10s≈2 分钟，覆盖绝大多数任务时长）；
// 仍失败则留下 .new 并报错，下次点「更新」检测到 30 分钟内暂存的新版会跳过下载直接换。
// expectSha：dev 构建的可选校验（我们自建的 gallery-dl-dev 在 engine-dev.json 里带哈希）；
// 官方发布走官方 SHA2-256SUMS，没有官方哈希的引擎该参数为空 → 降级为仅 allowlist+HTTPS
async function updateEngine(engine, url, onProgress, expectSha) {
  const allowRe = ENGINE_ALLOW[engine];
  if (!allowRe || !allowRe.some(re => re.test(String(url || '')))) throw new Error('update url not allowed');
  // 目标目录必须先建：userData/engines 平时不存在（Windows 引擎装在随包 resources/bin，
  // 只有自更新第一次落 userData）——不建目录 createWriteStream 直接 ENOENT（0.2.5 主人机器实锤，
  // 全新环境第一次引擎自动更新 100% 复现）
  try { fs.mkdirSync(BIN, { recursive: true }); } catch (e) {}
  const exe = path.join(BIN, engine);
  const tmp = exe + '.new';
  const bak = exe + '.bak';
  // 已暂存的新版（上次下载完但没换成）且够新 → 跳过重复下载，直接进替换
  let staged = false;
  try { staged = fs.existsSync(tmp) && Date.now() - fs.statSync(tmp).mtimeMs < 30 * 60000 && fs.statSync(tmp).size > 1_000_000; } catch (e) {}
  let hashChecked = false;
  if (!staged) {
    try { await download(url, tmp, onProgress); }
    catch (e) {
      // 半截文件必须删：留在盘上会被 30 分钟内的 staged 快路径当成「完整新版」直接换上（损坏引擎）
      try { fs.unlinkSync(tmp); } catch (e2) {}
      throw e;
    }
    const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    if (size < 1_000_000) { try { fs.unlinkSync(tmp); } catch (e) {} throw new Error('downloaded file too small: ' + size); }
    // SHA-256 校验（外部引擎是被 spawn 的可执行文件，官方提供校验和就必须验
    const sumsUrl = sumsUrlFor(engine, url);
    if (sumsUrl) {
      const sumsText = await getTextMirrored(sumsUrl).catch(() => null);
      const expect = sumsText ? parseEngineSha(sumsText, engine) : null;
      if (expect) {
        const got = await sha256File(tmp);
        if (got !== expect) {
          try { fs.unlinkSync(tmp); } catch (e) {}
          throw new Error('SHA-256 校验失败（期望 ' + expect.slice(0, 12) + '…，实得 ' + got.slice(0, 12) + '…），已丢弃下载');
        }
        hashChecked = true;
      }
    }
  }
  // dev 构建自建哈希校验：暂存快路径也要验（暂存文件可能来自中断的旧下载）
  if (expectSha) {
    const got = await sha256File(tmp);
    if (got !== String(expectSha).toLowerCase()) {
      try { fs.unlinkSync(tmp); } catch (e) {}
      throw new Error('SHA-256 校验失败（期望 ' + String(expectSha).slice(0, 12) + '…，实得 ' + got.slice(0, 12) + '…），已丢弃下载');
    }
    hashChecked = true;
  }
  // 替换（含占用重试）：unlink 成功但 rename 失败的窗口里必须回滚旧版——
  // 留空档期会让正在跑的下载任务 ENOENT（引擎文件凭空消失）
  let swapped = false, lastErr = null;
  for (let i = 0; i < 12 && !swapped; i++) {
    try {
      if (fs.existsSync(exe)) fs.copyFileSync(exe, bak);
      if (fs.existsSync(exe)) fs.unlinkSync(exe);
      fs.renameSync(tmp, exe);
      swapped = true;
    } catch (e) {
      lastErr = e;
      try { if (!fs.existsSync(exe) && fs.existsSync(bak)) fs.copyFileSync(bak, exe); } catch (e2) {}
      if (i < 11) await sleep(10000);
    }
  }
  if (!swapped) throw new Error('新版已下载，但引擎文件正被下载任务占用——当前任务完成后重试即可直接替换（无需重新下载）' + (lastErr ? '：' + String(lastErr.message || lastErr).slice(0, 60) : ''));
  const v = await localVersion(engine);
  return { engine, newVersion: v, backup: bak, hashChecked, installDir: BIN };
}

module.exports = { configure, checkAll, updateEngine, localVersion, cmpVer, isDevVer, getJsonPublic: getJson, downloadPublic: download, sha256File, parseEngineSha, sumsUrlFor };
