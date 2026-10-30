// 媒体库索引：递归扫描下载目录，按 {站点}/{UP主}/ 聚合统计
// 目录结构由两个引擎的输出模板天然对齐：
//   yt-dlp:    {outDir}/{site}/{uploader}/{title} [id].mp4
//   gallery-dl:{outDir}/{site}/{author}/...
// 只读不写、永不删除——本地媒体库是用户资产。

const fs = require('fs');
const fsp = fs.promises;   // #22：全量改用 Promise 版 fs，彻底避免同步 IO 阻塞 IPC 主线程
const path = require('path');

let OUTDIR = null;
let SOURCE_GET = null;   // 来源索引 getter（main.js 注入）：path → { url, via, subId, title }，可空

function configure({ outDir, sourceGet }) { OUTDIR = outDir; if (sourceGet !== undefined) SOURCE_GET = sourceGet; }

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.m4a', '.mp3']);
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);

function fileKind(ext) {
  const e = ext.toLowerCase();
  if (VIDEO_EXT.has(e)) return 'video';
  if (IMG_EXT.has(e)) return 'image';
  return 'other';
}

// 文章归档目录（文章引擎 4 件套）识别：目录里有 index.html + meta.json 且 meta.kind === 'keepsake-article'
// → 整目录算一个「article」条目（assets 里的图不再拆散进媒体库）。非文章目录返回 null（零成本跳过：
// 只有存在 index.html 的目录才读一次 meta.json）
// #22：全程 fs.promises，不阻塞事件循环
async function readArticleEntry(dir, rel) {
  try {
    try { await fsp.access(path.join(dir, 'index.html')); } catch { return null; }   // index.html 不存在直接跳过
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf-8'));
    if (!meta || meta.kind !== 'keepsake-article') return null;
    let size = 0;
    for (const f of ['index.html', 'article.md', 'meta.json']) {
      try { size += (await fsp.stat(path.join(dir, f))).size; } catch (e) {}
    }
    const assets = path.join(dir, 'assets');
    try {
      for (const a of await fsp.readdir(assets)) {
        try { const s = await fsp.stat(path.join(assets, a)); if (s.isFile()) size += s.size; } catch (e) {}
      }
    } catch (e) {}
    const st = await fsp.stat(dir);
    return {
      name: meta.title || path.basename(dir),
      path: dir,
      rel,
      size,
      mtime: st.mtimeMs,
      kind: 'article',
      // 删帖检测最小版的状态（recheck 写回 meta.json）：UI 显示「源头已删除 / 内容有编辑」徽标
      article: {
        author: meta.author || '',
        publishTime: meta.publishTime || '',
        imagesTotal: meta.imagesTotal || 0,
        imagesLocal: meta.imagesLocal || 0,
        imagesFailed: meta.imagesFailed || 0,
        status: meta.status || 'ok',
        editedAt: meta.editedAt || null,
        lastCheckedAt: meta.lastCheckedAt || null,
      },
    };
  } catch (e) { return null; }
}

function fmtSize(bytes) {
  if (bytes >= 1 << 30) return (bytes / (1 << 30)).toFixed(2) + ' GB';
  if (bytes >= 1 << 20) return (bytes / (1 << 20)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

// 递归扫描（异步分片让出主线程 + 文件数/深度上限 + 跳过符号链接防循环
// #22：readdir/stat/readFile 全部走 fs.promises；每 200 个文件 await setImmediate 让出事件循环，IPC 不冻结
async function walk(dir, base, out, ctx) {
  if (ctx.files >= ctx.maxFiles || ctx.depth >= ctx.maxDepth) return;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ctx.files >= ctx.maxFiles) return;
    const full = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;   // junction/symlink：防目录循环与越界扫描
    if (ent.isDirectory()) {
      // 文章归档目录：整目录一个条目，不再深入（assets 图不拆散）
      const art = await readArticleEntry(full, path.relative(base, full));
      if (art) { out.push(art); ctx.files++; continue; }
      ctx.depth++;
      await walk(full, base, out, ctx);
      ctx.depth--;
    } else if (ent.isFile()) {
      // 只收音视频图片（用户反馈：.srt/.txt 等附属文件不进媒体库）；.part 下载残留跳过
      const ext = path.extname(ent.name).toLowerCase();
      if (ext === '.part' || ext === '.tmp') continue;
      if (!VIDEO_EXT.has(ext) && !IMG_EXT.has(ext)) continue;
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      ctx.files++;
      if (ctx.files % 200 === 0) await new Promise(r => setImmediate(r));   // 每 200 个文件让出主线程，IPC 不冻结
      const rel = path.relative(base, full);
      out.push({
        name: ent.name,
        path: full,
        rel,
        size: st.size,
        mtime: st.mtimeMs,
        kind: fileKind(path.extname(ent.name))
      });
    }
  }
}

// 扫描并聚合：rel 第一段=站点、第二段=UP主；不足两段的归入「未分类」（async：IPC 层自动等待）
async function scan() {
  if (!OUTDIR) return { groups: [], totalFiles: 0, totalSize: 0, scannedAt: Date.now() };
  try { await fsp.access(OUTDIR); } catch { return { groups: [], totalFiles: 0, totalSize: 0, scannedAt: Date.now() }; }
  const files = [];
  await walk(OUTDIR, OUTDIR, files, { files: 0, depth: 0, maxFiles: 50000, maxDepth: 12 });

  const map = new Map(); // key: site|uploader
  for (const f of files) {
    const parts = f.rel.split(path.sep);
    // 规则目录：{站点}/{UP主}/文件；早期版本平铺在根目录的文件统一归入「未分类 / （根目录）」
    const site = parts.length >= 2 ? parts[0] : '未分类';
    const uploader = parts.length >= 2 ? parts[1] : '（根目录文件）';
    const key = site + '|' + uploader;
    if (!map.has(key)) map.set(key, { site, uploader, files: [], totalSize: 0, lastMtime: 0 });
    const g = map.get(key);
    g.files.push(f);
    g.totalSize += f.size;
    if (f.mtime > g.lastMtime) g.lastMtime = f.mtime;
  }

  const groups = [...map.values()]
    .map(g => ({
      site: g.site,
      uploader: g.uploader,
      key: g.site + '|' + g.uploader,
      fileCount: g.files.length,
      videoCount: g.files.filter(f => f.kind === 'video').length,
      imageCount: g.files.filter(f => f.kind === 'image').length,
      articleCount: g.files.filter(f => f.kind === 'article').length,   // 文章归档条目数（渲染层 📄 角标）
      totalSize: g.totalSize,
      sizeText: fmtSize(g.totalSize),
      lastMtime: g.lastMtime,
      // 实测两引擎的文件 mtime 都≈帖子发布时间：gallery-dl 会把文件时间设为发帖日期（2022 老帖 mtime 停在当天），
      // yt-dlp 加 --mtime 后用 HTTP Last-Modified（≈视频上传时间）→ 降序 = 最新帖子在前（用户需求）
      files: g.files.sort((a, b) => b.mtime - a.mtime).map(f => ({
        name: f.name, path: f.path, size: f.size, sizeText: fmtSize(f.size),
        mtime: f.mtime, kind: f.kind,
        // 文章条目状态（QA Bug 修复：map 重建对象时曾把 article 字段丢掉，
        // UI 的「源头已删除/内容有编辑」徽标因此永不显示）
        article: f.article || null,
        src: SOURCE_GET ? SOURCE_GET(f.path) : null   // 来源链接/订阅标记（老文件无记录 → null，UI 不显示）
      }))
    }))
    .sort((a, b) => b.lastMtime - a.lastMtime);

  return {
    groups,
    totalFiles: groups.reduce((s, g) => s + g.fileCount, 0),
    totalSize: groups.reduce((s, g) => s + g.totalSize, 0),
    scannedAt: Date.now()
  };
}

module.exports = { configure, scan, fmtSize };
