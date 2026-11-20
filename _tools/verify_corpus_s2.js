// 端到端冒烟：S1 文件名语料 + S2 X note.md（从真实源码抽函数，非复刻）
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const APP = path.join(__dirname, '..', 'app');
let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '—', e.message); fail++; }
}

// ---- 从 main.js 抽 cleanNameCorpus + NAME_CORPUS_SITES ----
const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf-8');
const siteM = mainSrc.match(/const NAME_CORPUS_SITES = new Set\(\[([^\]]+)\]\);/);
assert(siteM, 'NAME_CORPUS_SITES 定义未找到');
const sites = new Set((siteM[1].match(/'([^']+)'/g) || []).map(s => s.replace(/'/g, '')));
const fnM = mainSrc.match(/function cleanNameCorpus\(name\) \{([\s\S]*?)\n\}/);
assert(fnM, 'cleanNameCorpus 定义未找到');
const cleanNameCorpus = new Function('name', fnM[1]);

console.log('\n[1] 文件名清洗 cleanNameCorpus');
ok('白名单三站点正确', () => {
  assert(sites.has('bilibili') && sites.has('youtube') && sites.has('xiaohongshu'));
  assert(!sites.has('twitter') && !sites.has('x'), 'X 不应在文件名白名单');
});
ok('B站标题剥 BV 号', () => {
  const r = cleanNameCorpus('找两个互不认识的UP主，让他们强行聊天会有多尬？【尬聊01】 [BV1uL411H7jA].mp4');
  assert(r.includes('尬聊'), r);
  assert(!/BV1uL/i.test(r), '应剥掉 BV 号: ' + r);
});
ok('末尾分P序号剥离', () => {
  assert.strictEqual(cleanNameCorpus('测试视频标题_1.mp4'), '测试视频标题');
  assert.strictEqual(cleanNameCorpus('测试视频标题-2.mp4'), '测试视频标题');
});
ok('纯数字 ID 返回空（twitter 风格不建索引）', () => {
  assert.strictEqual(cleanNameCorpus('1560595468882948096_1.jpg'), '');
});
ok('过短文件名返回空', () => {
  assert.strictEqual(cleanNameCorpus('a.mp4'), '');
  assert.strictEqual(cleanNameCorpus('1234.mp4'), '');
});

// ---- textindex 真实模块（每个用例独立索引文件，互不污染）----
const textindex = require(path.join(APP, 'lib', 'textindex'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-idx-'));
let idxN = 0;
function freshIndex() { textindex.configure({ file: path.join(TMP, 'idx-' + (++idxN) + '.json') }); }

console.log('\n[2] textindex 文件名兜底 / 正文优先 / 去重');
ok('无正文媒体用文件名建 doc（kind=filename）', () => {
  freshIndex();
  const dir = path.join(TMP, 'bili1'); fs.mkdirSync(dir, { recursive: true });
  const mp4 = path.join(dir, '尬聊视频 [BV1x].mp4'); fs.writeFileSync(mp4, 'fake');
  const r = textindex.reindex([{ path: mp4, key: mp4, nameCorpus: '尬聊视频', title: '尬聊视频', up: 'UP' }]);
  assert.strictEqual(r.indexed, 1);
  assert.strictEqual(textindex.stats().docs, 1);
  const s = textindex.search('尬聊');
  assert(s.length && s[0].kind === 'filename', JSON.stringify(s));
  assert(s[0].snippet.includes('仅文件名'), s[0].snippet);
});
ok('正文优先：同名 .txt 存在时用正文，不退化文件名', () => {
  freshIndex();
  const dir = path.join(TMP, 'bili2'); fs.mkdirSync(dir, { recursive: true });
  const mp4 = path.join(dir, '尬聊视频 [BV1x].mp4'); fs.writeFileSync(mp4, 'fake');
  const txt = path.join(dir, '尬聊视频 [BV1x].txt'); fs.writeFileSync(txt, '转写正文量子计算内容', 'utf-8');
  textindex.reindex([{ path: mp4, key: mp4, nameCorpus: '尬聊视频', title: '尬聊视频' }]);
  const s = textindex.search('量子计算');
  assert(s.length && s[0].kind === 'text', JSON.stringify(s));
  assert.strictEqual(textindex.stats().docs, 1, '正文与文件名同 key，不重复');
  assert.strictEqual(textindex.search('尬聊').length, 0, '文件名被正文覆盖，不该再命中文件名 token');
});
ok('无正文且无候选 → 跳过，不建 doc', () => {
  freshIndex();
  const dir = path.join(TMP, 'tw'); fs.mkdirSync(dir, { recursive: true });
  const jpg = path.join(dir, '1560595468882948096_1.jpg'); fs.writeFileSync(jpg, 'fake');
  textindex.reindex([{ path: jpg, key: jpg, title: '1560595468882948096_1' }]);
  assert.strictEqual(textindex.stats().docs, 0, '不该为纯数字 jpg 新增 doc');
});
ok('有正文的媒体不会被后来文件名 doc 覆盖', () => {
  freshIndex();
  const dir = path.join(TMP, 'bili3'); fs.mkdirSync(dir, { recursive: true });
  const mp4 = path.join(dir, '尬聊视频 [BV1x].mp4'); fs.writeFileSync(mp4, 'fake');
  const txt = path.join(dir, '尬聊视频 [BV1x].txt'); fs.writeFileSync(txt, '量子计算正文内容', 'utf-8');
  textindex.reindex([{ path: mp4, key: mp4, nameCorpus: '尬聊视频' }]);  // 先正文
  const r = textindex.reindex([{ path: mp4, key: mp4, nameCorpus: '尬聊视频' }]);  // 同 key 重跑
  assert.strictEqual(textindex.search('量子计算')[0].kind, 'text', '正文仍在');
});

// ---- _writeXNoteMd：从 queue.js 抽方法体实测 ----
const queueSrc = fs.readFileSync(path.join(APP, 'lib', 'queue.js'), 'utf-8');
const xStart = queueSrc.indexOf('  _writeXNoteMd(it) {');
const xEnd = queueSrc.indexOf('  // 直连下载公共段', xStart);
assert(xStart >= 0 && xEnd > xStart, '_writeXNoteMd 定义未找到');
let xBody = queueSrc.slice(xStart + '  _writeXNoteMd(it) {'.length, xEnd).replace(/\}\s*$/, '');
const _writeXNoteMd = new Function('it', 'fs', 'path', 'console', 'return (function(){' + xBody + '\n}).call(this, it);');

console.log('\n[3] X note.md 汇总');
function runX(files, jsons) {
  const dir = fs.mkdtempSync(path.join(TMP, 'tw-post-'));
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'fake');
  for (const [name, meta] of Object.entries(jsons)) fs.writeFileSync(path.join(dir, name), JSON.stringify(meta), 'utf-8');
  const it = { engine: 'gallery-dl', url: 'https://x.com/user/status/123', _files: files.map(f => path.join(dir, f)) };
  const n = _writeXNoteMd(it, fs, path, { warn: () => {} });
  const notePath = path.join(dir, 'note.md');
  return { n, note: fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf-8') : null, dir };
}
ok('多图同推文去重为一条 note.md', () => {
  const meta = { tweet_id: 999, content: '推文正文内容测试', author: { name: 'tester' }, date: '2026-11-20' };
  const { n, note } = runX(['1.jpg', '2.jpg', '3.jpg'], { '1.jpg.json': meta, '2.jpg.json': meta, '3.jpg.json': meta });
  assert(n === 1, '应写 1 个目录的 note.md: ' + n);
  assert((note.match(/## /g) || []).length === 1, '应只有一条推文: ' + note);
  assert(note.includes('推文正文内容测试'));
  assert(note.includes('@tester'));
  assert(note.includes('source: twitter'));
});
ok('不同 tweet_id 各写一条', () => {
  const m1 = { tweet_id: 1, content: '第一条推文', author: { name: 'a' } };
  const m2 = { tweet_id: 2, content: '第二条推文', author: { name: 'b' } };
  const { note } = runX(['1.jpg', '2.jpg'], { '1.jpg.json': m1, '2.jpg.json': m2 });
  assert((note.match(/## /g) || []).length === 2, note);
  assert(note.includes('第一条推文') && note.includes('第二条推文'));
});
ok('非 X 任务不写', () => {
  const it = { engine: 'gallery-dl', url: 'https://example.com/post', _files: [] };
  const n = _writeXNoteMd(it, fs, path, { warn: () => {} });
  assert.strictEqual(n, null);
});
ok('无正文 json 不写（不阻塞）', () => {
  const { n } = runX(['1.jpg'], { '1.jpg.json': { tweet_id: 1, content: '' } });
  assert.strictEqual(n, null);
});
ok('X 图片挂 ✨（hasText 认 note.md）', () => {
  const libSrc = fs.readFileSync(path.join(APP, 'lib', 'library.js'), 'utf-8');
  assert(libSrc.includes("textNames.has('note.md')"), 'library.js 应对目录内 note.md 置 hasText');
});

// ---- UI 角标文案 ----
console.log('\n[4] UI 角标');
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf-8');
ok('仅文件名角标存在', () => assert(html.includes('仅文件名') && html.includes('📛')));
ok('正文文稿角标保留', () => assert(html.includes('文稿匹配') && html.includes('📄')));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
