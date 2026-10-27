// 文稿全文检索（#70 增长③）：转写出的 .txt 内容可搜
// 实现：2-gram 倒排索引（中文按相邻 2 字切分，英文/数字按词），存 userData/text-index.json。
// 刻意不引 SQLite（索引文件按需增量重建，千篇量级毫秒级可搜。
// 只索引与媒体文件同名的 .txt 转写文稿（base.txt，如「视频 [BV1xx].txt」）。
const fs = require('fs');
const path = require('path');
const { atomicWrite, readJson } = require('./jsonfile');

let FILE = null;
// docs/index 必须是 null 原型对象——普通对象的原型链上有 constructor/toString/hasOwnProperty，
// 文稿内容含这些词时 reindex 写入会命中原型键、search 的 `data.index[tk]` 判断被原型污染
let data = { version: 1, docs: Object.create(null), index: Object.create(null) };   // docs: path → { mtime, title, up, size } ; index: token → [path,...]

// JSON.parse（readJson 读回）产出普通对象，必须重建为 null 原型；非对象输入给空表
function toNullProto(obj) {
  return obj && typeof obj === 'object' && !Array.isArray(obj)
    ? Object.assign(Object.create(null), obj)
    : Object.create(null);
}

function configure({ file }) {
  FILE = file;
  data = readJson(FILE, { version: 1, docs: {}, index: {} }, v => v && v.docs && v.index);
  data.docs = toNullProto(data.docs);
  data.index = toNullProto(data.index);
}

// 分词：中英文混排通用。中文 → 相邻 2 字组（覆盖绝大多数短语查询）；英文/数字 → 小写词（≥2 字符）。
// cap：每篇最多取 20000 字符处理（超长文稿尾部不索引——转写文稿尾部通常是闲聊）
function tokenize(text) {
  const t = String(text || '').slice(0, 20000).toLowerCase();
  const out = new Set();
  const cjk = t.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) || [];
  for (const seg of cjk) for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2));
  for (const w of (t.match(/[a-z0-9]{2,}/g) || [])) out.add(w);
  return [...out];
}

// 增量索引：entries = [{ path, title, up, src?, key? }]；默认文稿 = path 去扩展名 + .txt，mtime 没变跳过。
// 文章引擎接入（M-A3）：传 src = article.md 路径 + key = 文章目录路径——
// key 用目录是为了渲染层按媒体条目 path 直接命中搜索徽标；docs 里记 src 供 snippet 读原文
// 返回 { indexed, skipped, removed }
function reindex(entries) {
  let indexed = 0, skipped = 0, removed = 0;
  const want = new Set();
  for (const e of (entries || [])) {
    const src = e.src || (e.path.replace(/\.[^.\\/]+$/, '') + '.txt');
    const key = e.key || src;
    want.add(key);
    let st = null;
    try { st = fs.statSync(src); } catch { continue; }   // 无文稿的媒体跳过
    const doc = data.docs[key];
    if (doc && doc.mtime === st.mtimeMs) { skipped++; continue; }
    let text = '';
    try { text = fs.readFileSync(src, 'utf-8'); } catch { continue; }
    removeDoc(key);   // 先摘除旧 token
    const tokens = tokenize(text);
    for (const tk of tokens) {
      const arr = data.index[tk] || (data.index[tk] = []);
      if (!arr.includes(key)) arr.push(key);
    }
    data.docs[key] = { mtime: st.mtimeMs, title: e.title || path.basename(key), up: e.up || '', size: st.size, tokens: tokens.length, src: key === src ? undefined : src };
    indexed++;
  }
  // 媒体已删除/移动的文稿：从索引摘除
  for (const p of Object.keys(data.docs)) {
    if (!want.has(p) || !fs.existsSync(p)) { removeDoc(p); removed++; }
  }
  if (indexed || removed) flush();
  return { indexed, skipped, removed };
}

function removeDoc(p) {
  if (!data.docs[p]) return;
  for (const tk of Object.keys(data.index)) {
    const arr = data.index[tk].filter(x => x !== p);
    if (arr.length) data.index[tk] = arr; else delete data.index[tk];
  }
  delete data.docs[p];
}

function flush() { try { atomicWrite(FILE, JSON.stringify(data)); } catch (e) {} }

// 查询：所有查询词的 2-gram/词都命中的文档（AND）；按命中 token 数排序。
// 返回 [{ path, title, up, snippet, hits }]
function search(q, limit = 30) {
  const query = String(q || '').trim();
  if (!query) return [];
  const tokens = tokenize(query);
  if (!tokens.length) {
    // 单个汉字/单字符查询：退化为包含匹配（扫 docs 关键词不值得，直接不过滤返回空提示）
    return [];
  }
  let candidates = null;
  for (const tk of tokens) {
    const arr = data.index[tk];
    if (!arr || !arr.length) return [];   // 任一 token 无文档 → AND 必空
    // 交集改 Set 成员判断——原 `arr.includes(p)` 是 O(C×L) 线性扫，
    // 数万文档 × 常用 2-gram 会在主进程同步执行时卡死 IPC；改后每轮 O(C+L)。
    // 始终迭代较短一侧、对较长一侧建 Set：
    if (candidates === null) candidates = new Set(arr);
    else if (candidates.size <= arr.length) {
      const big = new Set(arr);
      const next = new Set();
      for (const p of candidates) if (big.has(p)) next.add(p);
      candidates = next;
    } else {
      const next = new Set();
      for (const p of arr) if (candidates.has(p)) next.add(p);
      candidates = next;
    }
    if (!candidates.size) return [];
  }
  const qlower = query.toLowerCase();
  const results = [...candidates].map(p => {
    const d = data.docs[p] || {};
    return { path: p, title: d.title || path.basename(p), up: d.up || '', hits: tokens.length, snippet: '' };
  });
  // snippet：读文件找首个命中位置（cap 30 篇，防大结果集读盘）
  for (const r of results.slice(0, limit)) {
    try {
      const d = data.docs[r.path] || {};
      const srcFile = d.src || r.path;   // 文章条目：key 是目录路径，正文实际在 article.md（docs.src 指路）
      // openSync/readSync 只读前 256KB——转写文稿可达数百 KB，整篇同步读会拖慢 IPC；
      // 尾部截断最多损失一个多字节字符（解码替换），snippet 足够
      const fd = fs.openSync(srcFile, 'r');
      let text = '';
      try {
        const buf = Buffer.alloc(256 * 1024);
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        text = buf.toString('utf-8', 0, n);
      } finally { fs.closeSync(fd); }
      const lower = text.toLowerCase();
      // 优先整词位置，退化到首个查询 token 位置
      let pos = lower.indexOf(qlower);
      if (pos < 0) for (const tk of tokens) { pos = lower.indexOf(tk); if (pos >= 0) break; }
      if (pos >= 0) r.snippet = '…' + text.slice(Math.max(0, pos - 30), pos + 80).replace(/\s+/g, ' ').trim() + '…';
    } catch (e) {}
  }
  results.sort((a, b) => (b.hits - a.hits) || (a.title < b.title ? -1 : 1));
  return results.slice(0, limit);
}

function stats() { return { docs: Object.keys(data.docs).length, tokens: Object.keys(data.index).length }; }

module.exports = { configure, reindex, search, stats };
