// P2 批次 C 离线单测（#46 杂项：容错解码 / 终态淘汰 / 412/429 词边界）
// 纯 node 运行：node tools/test-p2-batch-c-unit.js
const assert = require('assert');
const { TolerantDecoder } = require('../lib/dec');
const queueMod = require('../lib/queue');
const { DownloadQueue, configure, isRateLimitError } = queueMod;

let pass = 0, fail = 0;
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

// ---- #46⑤ TolerantDecoder ----
t('dec：纯 UTF-8 中文直通，不切 GBK', () => {
  const dec = new TolerantDecoder();
  const src = Buffer.from('标题含中文 ERROR', 'utf-8');
  assert.strictEqual(dec.decode(src), '标题含中文 ERROR');
  assert.strictEqual(dec._gbkMode, false, '合法 UTF-8 不得触发 GBK 切换');
});
t('dec：纯 ASCII 不触发切换', () => {
  const dec = new TolerantDecoder();
  assert.strictEqual(dec.decode(Buffer.from('ERROR: HTTP 412 Precondition')), 'ERROR: HTTP 412 Precondition');
  assert.strictEqual(dec._gbkMode, false);
});
t('dec：GBK 字节回退解码（「错误」= B4 ED CE F3）', () => {
  const dec = new TolerantDecoder();
  const out = dec.decode(Buffer.from([0xb4, 0xed, 0xce, 0xf3]));   // GBK 的「错误」，非法 UTF-8
  assert.strictEqual(out, '错误');
  assert.strictEqual(dec._gbkMode, true, 'GBK 回退后应锁定 gbk 模式');
});
t('dec：GBK 后续块沿用 GBK 解码器', () => {
  const dec = new TolerantDecoder();
  assert.strictEqual(dec.decode(Buffer.from([0xb4, 0xed]), { stream: true }), '错');
  assert.strictEqual(dec.decode(Buffer.from([0xce, 0xf3]), { stream: true }), '误');
  assert.strictEqual(dec.decode(Buffer.from(' OK'), { stream: true }), ' OK');   // GBK 与 ASCII 兼容
});
t('dec：流式 UTF-8 多字节跨块不断裂（不误切 GBK）', () => {
  const dec = new TolerantDecoder();
  const full = Buffer.from('中文abc', 'utf-8');
  let out = '';
  // 按字节逐块喂（最恶劣的切块方式）
  for (const b of full) out += dec.decode(Buffer.from([b]), { stream: true });
  out += dec.decode(Buffer.alloc(0), { stream: true });
  assert.strictEqual(out, '中文abc');
  assert.strictEqual(dec._gbkMode, false, '合法 UTF-8 跨块不得误判为 GBK');
});
t('dec：UTF-8 与 GBK 混合流——非法字节起整流切 GBK，已解部分不丢', () => {
  const dec = new TolerantDecoder();
  let out = '';
  out += dec.decode(Buffer.from('ERROR: ', 'utf-8'), { stream: true });
  out += dec.decode(Buffer.from([0xb4, 0xed]), { stream: true });   // GBK「错」
  out += dec.decode(Buffer.from([0xce, 0xf3]), { stream: true });   // GBK「误」
  assert.strictEqual(out, 'ERROR: 错误');
});
t('dec：非法 UTF-8 且非 GBK 的二进制垃圾 → 不抛异常，替换字符兜底', () => {
  const dec = new TolerantDecoder();
  let out = '';
  assert.doesNotThrow(() => { out = dec.decode(Buffer.from([0xff, 0xfe, 0x00]), { stream: true }); });
  assert.ok(typeof out === 'string');
});
t('dec：空入参安全', () => {
  const dec = new TolerantDecoder();
  assert.strictEqual(dec.decode(null), '');
  assert.strictEqual(dec.decode(undefined), '');
  assert.strictEqual(dec.decode(Buffer.alloc(0)), '');
});

// ---- #46② 终态任务 200 条上限 FIFO 淘汰（只动终态，不碰活跃/中断）----
t('pruneFinished：超 200 条终态 FIFO 淘汰最旧；queued/interrupted 永不淘汰', () => {
  configure({ outDir: '/tmp/ks-p2c-nonexist' });
  const q = new DownloadQueue(() => {});
  q.run = () => {}; q.tick = () => {};
  // 205 条 done（最旧在前）+ 3 条 queued + 2 条 interrupted
  for (let i = 0; i < 205; i++) {
    const it = { id: 'd' + i, url: 'https://x.example/d' + i, engine: 'yt-dlp', status: 'done' };
    q.items.set(it.id, it); q.order.push(it.id);
  }
  for (let i = 0; i < 3; i++) { const it = { id: 'q' + i, status: 'queued', url: 'u' + i, engine: 'yt-dlp' }; q.items.set(it.id, it); q.order.push(it.id); }
  for (let i = 0; i < 2; i++) { const it = { id: 'x' + i, status: 'interrupted', url: 'i' + i, engine: 'yt-dlp' }; q.items.set(it.id, it); q.order.push(it.id); }
  q.pruneFinished();
  assert.strictEqual(q.order.filter(id => id.startsWith('d')).length, 200, '终态保留 200 条');
  assert.ok(!q.items.has('d0') && !q.items.has('d4'), '最旧的 done 被淘汰');
  assert.ok(q.items.has('d204'), '最新的 done 保留');
  for (let i = 0; i < 3; i++) assert.ok(q.items.has('q' + i), 'queued 不淘汰');
  for (let i = 0; i < 2; i++) assert.ok(q.items.has('x' + i), 'interrupted 不淘汰');
  assert.strictEqual(q.order.length, 205, 'order 与 items 同步收敛');
});

// ---- #46③ 412/429 词边界（queue.js isRateLimitError）----
t('isRateLimitError：412/429 词边界——状态码命中、数值/大小/ID 不误判', () => {
  assert.ok(isRateLimitError('HTTP Error 412: Precondition Failed'), '真 412 命中');
  assert.ok(isRateLimitError('got 429 Too Many Requests'), '真 429 命中');
  assert.ok(isRateLimitError('请求过于频繁'), '中文信号命中');
  assert.ok(!isRateLimitError('文件大小 412MB 下载完成'), '412MB 不误判');
  assert.ok(!isRateLimitError('opus/1251190976967344129'), 'URL 里的 4129/14120 片段不误判');
  assert.ok(!isRateLimitError('part 1412 of 2000'), '分段号不误判');
  assert.ok(isRateLimitError('-352'), 'B 站 -352 保留命中');
});

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); pass++; console.log('PASS | ' + name); }
    catch (e) { fail++; console.log('FAIL | ' + name + ' | ' + (e && e.message)); }
  }
  console.log('----');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
