// 首启引擎引导（发布闸门②配套）：安装包不捆绑 gallery-dl（GPL-3.0）与 ffmpeg，
// 用户首次运行时由本模块在线下载到引擎目录 —— Keepsake 自身代码保持专有、可收费。
//
// 下载源实测（2026-10-08）：
// - gallery-dl 官方二进制实际发布在 **Codeberg**（GitHub releases 只有源码包！
//   autoupdate.js 同源）；Codeberg API 不限流。
// - ffmpeg：gyan.dev essentials(~109MB) 优先，BtbN(~200MB) 兜底；
//   GitHub 资产直连失败自动切换国内镜像（ghproxy 系）。
// 不覆盖：yt-dlp（win 随包附带）、bili-probe、whisper-cli（MIT，随包附带）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const HDRS = { headers: { 'User-Agent': 'Keepsake/0.1 (github release bootstrap)' } };

// GitHub 资产国内镜像前缀（直连优先，镜像顺序无关紧要，逐个试）
const MIRRORS = ['', 'https://ghproxy.net/', 'https://gh-proxy.com/', 'https://ghfast.top/'];

// 单源下载：连接/响应头 20s 超时；正文 10 分钟超时；<200KB 视为错误页拒绝落盘
async function dlOnce(url, dest) {
  const ctrl = new AbortController();
  const t1 = setTimeout(() => ctrl.abort(), 20 * 1000);
  let res;
  try {
    res = await fetch(url, { ...HDRS, signal: ctrl.signal });
  } catch (e) {
    throw new Error(/abort/i.test(String(e)) ? '连接超时' : String(e.message || e));
  } finally {
    clearTimeout(t1);
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const t2 = setTimeout(() => ctrl.abort(), 600 * 1000);
  let buf;
  try { buf = Buffer.from(await res.arrayBuffer()); }
  finally { clearTimeout(t2); }
  if (buf.length < 200 * 1024) throw new Error(`响应仅 ${Math.round(buf.length / 1024)}KB，疑似错误页`);
  fs.writeFileSync(dest, buf);
  fs.chmodSync(dest, 0o755);
}

// 多源下载：GitHub 资产自动展开为「直连+镜像」候选列表，逐个试到成功
async function dl(urlOrList, dest) {
  const list = Array.isArray(urlOrList) ? urlOrList
    : /^https:\/\/github\.com\//.test(urlOrList) ? MIRRORS.map(m => m + urlOrList)
    : [urlOrList];
  let last;
  for (const c of list) {
    try { await dlOnce(c, dest); return; } catch (e) { last = e; }
  }
  throw new Error(`${last && last.message || last}（已试 ${list.length} 个源${list.length > 1 ? '，含国内镜像' : ''}）`);
}

// gallery-dl 官方 sha256 pin（版本→exe 哈希，抄自 Codeberg SHA256SUMS；离线可用，新版本靠 gdlExpected 拉 SHA256SUMS 自校验）
const GDL_PIN = { '1.32.15': 'd6c8ac8ffdc9194e90787225e70d0a7c9eeed23dd41c9574e235632b6f9593a4' };
// 自家 Release 兜底源（官方 gallery-dl.exe 原样上传到 Keepsake Release 资产即生效；github.com URL 自动吃镜像链）
const SELF_GDL_URL = 'https://github.com/guanyafei00/Keepsake/releases/latest/download/gallery-dl.exe';

// 期望哈希 fail-closed——pin 表优先，否则拉 Codeberg 官方 SHA256SUMS（覆盖未来新版本，无需发版更新 pin 表）
const _sumsCache = {};   // tag → sha256
async function gdlExpected(tag) {
  if (GDL_PIN[tag]) return GDL_PIN[tag];
  if (!(tag in _sumsCache)) {
    const r = await fetch(`https://codeberg.org/mikf/gallery-dl/releases/download/${tag}/SHA256SUMS`, HDRS);   // 实测文件名无 .txt
    if (!r.ok) throw new Error('SHA256SUMS HTTP ' + r.status);
    const txt = await r.text();
    const line = txt.split(/\r?\n/).find(l => l.trim().endsWith('gallery-dl.exe'));
    if (!line) throw new Error('SHA256SUMS 里没有 gallery-dl.exe 条目');
    _sumsCache[tag] = line.trim().split(/\s+/)[0].toLowerCase();
  }
  return _sumsCache[tag];
}

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// gallery-dl 最新「带 gallery-dl.exe 二进制」的 tag（Codeberg API 不限流）
// 实测：新版发布初期可能只有源码资产（v1.32.16 无二进制），要往后找最近一个带 exe 的版本
async function gdlTag() {
  const r = await fetch('https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases?limit=10', HDRS);
  if (!r.ok) throw new Error('codeberg API ' + r.status);
  for (const j of await r.json()) {
    if ((j.assets || []).some(x => x.name === 'gallery-dl.exe')) return j.tag_name;
  }
  throw new Error('codeberg 最近 10 个 release 均无 gallery-dl.exe');
}

// win 解压：PowerShell Expand-Archive（把 zip 内的 ffmpeg.exe 提到 destDir）
// 路径里的单引号会截断 PS 字符串（甚至注入命令），PS 单引号串里 '' 才是一个字面单引号
// v0.1.9 修复：解压出的 ffmpeg-*-essentials_build 目录（含 doc/ 约 500MB）此前从不清理，
// 每次重下都往安装目录里堆一座垃圾山——复制出 ffmpeg.exe 后整个删掉
function winExpand(zipPath, destDir) {
  return new Promise((res, rej) => {
    const q = s => String(s).replace(/'/g, "''");
    const ps = `Expand-Archive -LiteralPath '${q(zipPath)}' -DestinationPath '${q(destDir)}' -Force; ` +
      `$f = Get-ChildItem -Path '${q(destDir)}' -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1; ` +
      `if ($f) { Copy-Item $f.FullName '${q(path.join(destDir, 'ffmpeg.exe'))}' -Force; 'OK' } else { 'MISS' }`;
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('error', rej);
    p.on('exit', code => {
      if (!(code === 0 && out.includes('OK'))) return rej(new Error('Expand-Archive 失败 code=' + code));
      // 清理：解压残留目录 + zip 本体（ffmpeg.exe 已提到 destDir 顶层；失败也只是留垃圾，不阻断）
      try {
        for (const ent of fs.readdirSync(destDir, { withFileTypes: true })) {
          if (ent.isDirectory() && /essentials_build|^ffmpeg-/i.test(ent.name)) {
            fs.rmSync(path.join(destDir, ent.name), { recursive: true, force: true });
          }
        }
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      } catch (e) { console.warn('[engines] 清理解压残留失败:', e.message); }
      res();
    });
  });
}

async function ensureEngines(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const out = { ok: true, installed: [] };
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  if (!isWin && !isMac) return { skip: true };
  const exeName = n => isWin ? n + '.exe' : n;

  // 需要的引擎清单（存在的跳过）：mac 三件套；win 只补 gallery-dl + ffmpeg（yt-dlp 随包）
  const all = isMac ? ['yt-dlp', 'ffmpeg', 'gallery-dl'] : ['gallery-dl', 'ffmpeg'];
  const need = all.filter(n => {
    const p = path.join(binDir, exeName(n));
    if (!fs.existsSync(p)) return true;
    // 空文件（上次下载中断的残骸）视为缺失
    try { return fs.statSync(p).size < 1024 * 512; } catch (e) { return true; }
  });
  if (!need.length) return { ok: true, fresh: false };

  for (const n of need) {
    let installedAs = n;
    try {
      if (n === 'yt-dlp') {
        // 固定资产名免 API（api.github.com 会限流 403），镜像自动重试
        await dl('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
                 path.join(binDir, 'yt-dlp'));
      } else if (n === 'gallery-dl') {
        if (isWin) {
          // 降级链（顺序写死，禁止静默换源；结果带来源标注供 UI 明示）：
          // ① Codeberg 官方 ② 自家 Release 副本（自动吃镜像）③ GitHub official（万一恢复发布）
          // 三个源都必须过期望哈希（pin 或官方 SHA256SUMS），拿不到期望哈希直接拒绝（fail-closed 防镜像投毒）
          const dest = path.join(binDir, 'gallery-dl.exe');
          let tag = null;
          try { tag = await gdlTag(); } catch (e) {}
          let expect = null;
          if (tag) { try { expect = await gdlExpected(tag); } catch (e) {} }
          if (!expect) throw new Error('无法获取官方 SHA-256（pin 表无此版本且 SHA256SUMS 拉取失败），拒绝下载以防供应链投毒；可稍后重启重试，或在设置页「从本地文件安装」手动导入');
          const sources = [];
          if (tag) sources.push({ label: 'Codeberg官方', url: `https://codeberg.org/mikf/gallery-dl/releases/download/${tag}/gallery-dl.exe` });
          sources.push({ label: 'KeepsakeRelease副本', url: SELF_GDL_URL });
          sources.push({ label: 'GitHub镜像', url: 'https://github.com/mikf/gallery-dl/releases/latest/download/gallery-dl.exe' });
          let lastErr, used = null;
          for (const s of sources) {
            try {
              await dl(s.url, dest);
              const got = sha256File(dest);
              if (got !== expect) throw new Error('sha256 与官方清单不符(' + got.slice(0, 12) + ')，已丢弃');
              used = s.label;
              break;
            } catch (e) { lastErr = e; }
          }
          if (!used) throw new Error(String(lastErr && lastErr.message || lastErr).slice(0, 160));
          installedAs = 'gallery-dl(' + used + ')';
        } else {
          // mac 无官方二进制：GitHub 资产探测（可能 403/404），失败给出 pip 指引
          let url = null;
          for (const re of [/gallery-dl_macos$/i, /gallery-dl-macos$/i]) {
            try {
              const r = await fetch('https://github.com/mikf/gallery-dl/releases/latest', { redirect: 'follow', headers: HDRS });
              const tag = (r.url || '').split('/tag/')[1];
              if (!tag) break;
              url = 'https://github.com/mikf/gallery-dl/releases/download/' + tag + (re.source.includes('_macos') ? '/gallery-dl_macos' : '/gallery-dl-macos');
              break;
            } catch (e) {}
          }
          if (!url) throw new Error('无 macOS 二进制，请手动执行: python3 -m pip install -U gallery-dl');
          await dl(url, path.join(binDir, 'gallery-dl'));
        }
      } else if (n === 'ffmpeg') {
        if (isWin) {
          // 主源 gyan.dev essentials(~109MB)，兜底 BtbN(~200MB，直连+镜像)
          const urls = [
            'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
            ...MIRRORS.map(m => m + 'https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip'),
          ];
          const zip = path.join(binDir, 'ffmpeg-dl.zip');
          try {
            await dl(urls, zip);
            await winExpand(zip, binDir);
          } finally { try { fs.unlinkSync(zip); } catch (e) {} }
          if (!fs.existsSync(path.join(binDir, 'ffmpeg.exe'))) throw new Error('zip 内未找到 ffmpeg.exe');
        } else {
          const zip = path.join(binDir, 'ffmpeg.zip');
          await dl('https://evermeet.cx/ffmpeg/get/zip', zip);   // 302 到最新版单文件 zip
          await new Promise((res, rej) => execFile('unzip', ['-o', zip, '-d', binDir], e => e ? rej(e) : res()));
          fs.chmodSync(path.join(binDir, 'ffmpeg'), 0o755);
          try { fs.unlinkSync(zip); } catch (e) {}
        }
      }
      out.installed.push(installedAs);
    } catch (e) {
      out.ok = false;
      out[n] = String(e.message || e).slice(0, 160);
    }
  }
  return out;
}

module.exports = { ensureEngines, winExpand };
