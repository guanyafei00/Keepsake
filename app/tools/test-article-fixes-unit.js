// QA 离线单测：文章引擎目录规划修复（P0-1 路径穿越 + P2-1 并发互踩）
// 纯 node 运行（不启 electron）：node tools/test-article-fixes-unit.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const article = require('../lib/article');
const { sanitizeSeg, slugify, resolveDir } = article._pathHelpers;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS | ' + name); pass++; }
  catch (e) { console.log('FAIL | ' + name + ' | ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }

// ---- P0-1：纯点段拒绝 ----
t('sanitizeSeg("..") 返回 fallback', () => {
  assert(sanitizeSeg('..', 'fb') === 'fb', 'got: ' + sanitizeSeg('..', 'fb'));
});
t('sanitizeSeg(".") 返回 fallback', () => {
  assert(sanitizeSeg('.', 'fb') === 'fb', 'got: ' + sanitizeSeg('.', 'fb'));
});
t('sanitizeSeg("...") 返回 fallback', () => {
  assert(sanitizeSeg('...', 'fb') === 'fb');
});
t('sanitizeSeg("../..") 剥斜杠后纯点 → fallback', () => {
  assert(sanitizeSeg('../..', 'fb') === 'fb', 'got: ' + sanitizeSeg('../..', 'fb'));
});
t('sanitizeSeg("a..b") 保留（非纯点段，非穿越）', () => {
  assert(sanitizeSeg('a..b', 'fb') === 'a..b');
});
t('sanitizeSeg("正常作者") 原样保留', () => {
  assert(sanitizeSeg('正常作者', 'fb') === '正常作者');
});
t('slugify("..") 返回 article', () => {
  assert(slugify('..') === 'article', 'got: ' + slugify('..'));
});
t('slugify("...") 返回 article', () => {
  assert(slugify('...') === 'article');
});
t('slugify("hello world") 正常', () => {
  assert(slugify('hello world') === 'hello_world');
});

// ---- P0-1：resolveDir 越界断言（双保险层） ----
t('resolveDir 纯点段直接抛 ArticleError(select)', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-p0-'));
  try {
    resolveDir(outDir, '..', '..', 'http://x/a');
    throw new Error('未抛错——穿越路径被放行了！');
  } catch (e) {
    assert(e && e.kind === 'select', '错误类型不对: ' + (e && e.kind));
  }
});
// 穿越构造端到端：确认修复前会落在 outDir 外的位置现在绝无文件产生
t('resolveDir 穿越构造不在 outDir 外产生目录', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-p0b-'));
  try { resolveDir(outDir, '..', '..', 'http://x/a'); } catch (e) { /* 预期 */ }
  const escaped = path.resolve(outDir, '..', '..', 'article');
  assert(!fs.existsSync(escaped), '穿越目录竟存在: ' + escaped);
});

// ---- P2-1：占坑式创建 ----
t('同 URL 重跑 → 原地复用（meta.url 一致）', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-p2-'));
  const url = 'http://x/same';
  const d1 = resolveDir(outDir, '作者', '标题', url);
  fs.mkdirSync(path.join(d1, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(d1, 'meta.json'), JSON.stringify({ url }));
  const d2 = resolveDir(outDir, '作者', '标题', url);
  assert(path.resolve(d1) === path.resolve(d2), d1 + ' != ' + d2);
});
t('同目录不同 URL（meta.url 不同）→ 换 -2 候选', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-p2b-'));
  const d1 = resolveDir(outDir, '作者', '标题', 'http://x/a');
  fs.mkdirSync(path.join(d1, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(d1, 'meta.json'), JSON.stringify({ url: 'http://x/a' }));
  const d2 = resolveDir(outDir, '作者', '标题', 'http://x/b');
  assert(/-2$/.test(path.basename(d2)), '期望 -2 后缀，got: ' + d2);
});
t('已占坑但无 meta（并发抓取中）→ 换下一候选不覆盖', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-p2c-'));
  const d1 = resolveDir(outDir, '作者', '标题', 'http://x/a');   // 模拟并发者 A 刚占坑（meta 还没写）
  const d2 = resolveDir(outDir, '作者', '标题', 'http://x/b');   // B 后到 → 必须避开
  assert(path.resolve(d1) !== path.resolve(d2), '互踩了: ' + d1);
  assert(fs.existsSync(d1) && fs.existsSync(d2));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
