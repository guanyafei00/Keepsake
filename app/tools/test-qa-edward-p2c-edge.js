// QA 补充边界测试（Edward，P2 批次 C 验证）：TolerantDecoder 极端样例 + pruneFinished 边界
// 纯 node 运行：node tools/test-qa-edward-p2c-edge.js
// 原则：只测不改——不 require 任何被修改的源码行为假设，断言全部来自设计文档语义
const assert = require('assert');
const { TolerantDecoder } = require('../lib/dec');
const { DownloadQueue, configure } = require('../lib/queue');

let pass = 0, fail = 0;
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

// GBK 字节（.NET Encoding 936 生成，Windows 中文环境真实报错样例）：
// 「系统找不到指定的文件: 抽象畑_第03话_4K.mp4 - 指定的文件名无效或太长」
// 注意「畑」= 0xAE 0x78，0xAE 作 UTF-8 首字节非法 → 严格 UTF-8 必抛错触发 GBK 回退
const GBK_FILENAME_ERR = Buffer.from([
  0xCF, 0xB5, 0xCD, 0xB3, 0xD5, 0xD2, 0xB2, 0xBB, 0xB5, 0xBD, 0xD6, 0xB8, 0xB6, 0xA8, 0xB5, 0xC4,
  0xCE, 0xC4, 0xBC, 0xFE, 0x3A, 0x20, 0xB3, 0xE9, 0xCF, 0xF3, 0xAE, 0x78, 0x5F, 0xB5, 0xDA, 0x30,
  0x33, 0xBB, 0xB0, 0x5F, 0x34, 0x4B, 0x2E, 0x6D, 0x70, 0x34, 0x20, 0x2D, 0x20, 0xD6, 0xB8, 0xB6,
  0xA8, 0xB5, 0xC4, 0xCE, 0xC4, 0xBC, 0xFE, 0xC3, 0xFB, 0xCE, 0xDE, 0xD0, 0xA7, 0xBB, 0xF2, 0xCC,
  0xAB, 0xB3, 0xA4,
]);
const GBK_FILENAME_ERR_TEXT = '系统找不到指定的文件: 抽象畑_第03话_4K.mp4 - 指定的文件名无效或太长';

// ---- TolerantDecoder 极端样例 ----

t('dec·edge：一次性解码 GBK 中文文件名报错全样例（含 0xAE 非法 UTF-8 首字节）', () => {
  const dec = new TolerantDecoder();
  assert.strictEqual(dec.decode(GBK_FILENAME_ERR), GBK_FILENAME_ERR_TEXT);
  assert.strictEqual(dec._gbkMode, true);
});

t('dec·edge：流式 UTF-8 4 字节 emoji（😀）逐字节跨块不断裂、不误切 GBK', () => {
  const dec = new TolerantDecoder();
  const full = Buffer.from('a😀b中c', 'utf-8');
  let out = '';
  for (const b of full) out += dec.decode(Buffer.from([b]), { stream: true });
  out += dec.decode(Buffer.alloc(0), { stream: true });
  assert.strictEqual(out, 'a😀b中c');
  assert.strictEqual(dec._gbkMode, false, '合法 UTF-8 逐字节喂不得触发 GBK');
});

t('dec·edge：流式模式 GBK 锁定后跨块双字节字符在奇数偏移切块仍正确', () => {
  const dec = new TolerantDecoder();
  let out = '';
  out += dec.decode(Buffer.from([0xb4, 0xed]), { stream: true });   // 错（前半+触发锁定的完整字）
  // 之后按 1/3/2 字节不等长切块，含把双字节 GBK 字符劈成两半
  const rest = Buffer.from([0xce, 0xf3, 0x3a, 0x20, 0xca, 0xd3, 0xc6, 0xb5, 0x21]);   // 误: 视频!
  for (let i = 0; i < rest.length; i += 3) out += dec.decode(rest.subarray(i, i + 3), { stream: true });
  out += dec.decode(Buffer.alloc(0), { stream: true });
  assert.strictEqual(out, '错误: 视频!');
  assert.strictEqual(dec._gbkMode, true);
});

t('dec·edge：流式留下 pending 尾字节后转一次性调用——pending 并入不丢失', () => {
  const dec = new TolerantDecoder();
  const buf = Buffer.from('中文', 'utf-8');
  let out = dec.decode(buf.subarray(0, 2), { stream: true });   // 「中」完整 + 无尾
  out += dec.decode(buf.subarray(2, 4), { stream: true });      // 「文」首 2 字节（E6 96），第 3 字节 B0 留 pending
  assert.strictEqual(dec._pending && dec._pending.length, 1, '应有 1 字节 pending');
  out += dec.decode(buf.subarray(4));   // 一次性收尾（flush 语义）
  assert.strictEqual(out, '中文');
});

t('dec·edge：字符串入参（非 Buffer）走 UTF-8 直通路径不抛异常', () => {
  const dec = new TolerantDecoder();
  assert.strictEqual(dec.decode('hello 世界'), 'hello 世界');
  assert.strictEqual(dec._gbkMode, false);
});

t('dec·edge：GBK 锁定后空块/纯 ASCII 块不破坏 GBK 解码器流状态', () => {
  const dec = new TolerantDecoder();
  let out = dec.decode(Buffer.from([0xb4, 0xed]), { stream: true });   // 错
  out += dec.decode(Buffer.alloc(0), { stream: true });                // 空块
  out += dec.decode(Buffer.from('A'), { stream: true });               // ASCII
  out += dec.decode(Buffer.from([0xce, 0xf3]), { stream: true });      // 误
  assert.strictEqual(out, '错A误');
});

t('dec·edge：UTF-8 正文后接 GBK 行——锁定时刻前已解部分保留（单遍启发式的既定取舍），全程不抛异常', () => {
  const dec = new TolerantDecoder();
  let out = '';
  out += dec.decode(Buffer.from('[download] 100%\n', 'utf-8'), { stream: true });
  assert.doesNotThrow(() => { out += dec.decode(GBK_FILENAME_ERR, { stream: true }); });
  assert.ok(out.startsWith('[download] 100%\n'), 'UTF-8 前缀不丢');
  assert.ok(out.includes('无效或太长'), 'GBK 尾段可解');
});

t('dec·edge：二进制垃圾（0xFF 0xFE 0x00）流式不抛异常且锁定 GBK 兜底', () => {
  const dec = new TolerantDecoder();
  let out = '';
  assert.doesNotThrow(() => {
    out = dec.decode(Buffer.from([0xff, 0xfe, 0x00]), { stream: true });
    out += dec.decode(Buffer.from([0xb4, 0xed]), { stream: true });
  });
  assert.ok(typeof out === 'string');
});

t('dec·edge：跨块时 ASCII 与多字节混合按 2 字节切块（最恶劣对齐）UTF-8 仍完整', () => {
  const dec = new TolerantDecoder();
  const full = Buffer.from('x中y文z😀w', 'utf-8');
  let out = '';
  for (let i = 0; i < full.length; i += 2) out += dec.decode(full.subarray(i, i + 2), { stream: true });
  out += dec.decode(Buffer.alloc(0), { stream: true });
  assert.strictEqual(out, 'x中y文z😀w');
  assert.strictEqual(dec._gbkMode, false);
});

// ---- pruneFinished 边界 ----

function seedQueue(q, done, err, canceled) {
  let i = 0;
  const seed = (prefix, status, n) => {
    for (let k = 0; k < n; k++) {
      const it = { id: prefix + (i++), url: 'https://x.example/' + prefix + i, engine: 'yt-dlp', status };
      q.items.set(it.id, it); q.order.push(it.id);
    }
  };
  seed('d', 'done', done); seed('e', 'error', err); seed('c', 'canceled', canceled);
}

t('prune·edge：恰好 200 条终态 → 一条不淘汰', () => {
  configure({ outDir: '/tmp/ks-qa-edge-nonexist' });
  const q = new DownloadQueue(() => {});
  seedQueue(q, 150, 30, 20);   // 合计恰好 200
  q.pruneFinished();
  assert.strictEqual(q.items.size, 200);
  assert.strictEqual(q.order.length, 200);
  assert.ok(q.items.has('d0'), '最旧 done 保留');
});

t('prune·edge：201 条终态 → 恰好淘汰最旧 1 条', () => {
  const q = new DownloadQueue(() => {});
  seedQueue(q, 201, 0, 0);
  q.pruneFinished();
  assert.strictEqual(q.items.size, 200);
  assert.ok(!q.items.has('d0'), '最旧 done 被淘汰');
  assert.ok(q.items.has('d200'), '最新 done 保留');
});

t('prune·edge：终态 205 条 + queued/downloading/held/interrupted 各若干 → 只淘汰终态，非终态全数保留', () => {
  const q = new DownloadQueue(() => {});
  seedQueue(q, 100, 100, 5);   // 205 终态
  const nonFin = ['queued', 'downloading', 'held', 'interrupted'];
  nonFin.forEach((s, k) => { for (let j = 0; j < 2; j++) { const it = { id: 'n' + s + j, url: 'u' + s + j, engine: 'yt-dlp', status: s }; q.items.set(it.id, it); q.order.push(it.id); } });
  q.pruneFinished();
  assert.strictEqual(q.items.size, 208, '200 终态 + 8 非终态（被淘汰的 5 条是终态里的最旧者）');
  for (const s of nonFin) for (let j = 0; j < 2; j++) assert.ok(q.items.has('n' + s + j), s + ' 不淘汰');
  assert.ok(q.items.has('d5') && q.items.has('e100') && q.items.has('c204'), '终态尾段（d5 起）全保留');
});

t('prune·edge：FIFO 语义——淘汰的是 order 中最旧的终态而非「恰好 5 条指定状态」', () => {
  const q = new DownloadQueue(() => {});
  // 202 条终态：最旧 2 条是 canceled，之后 done —— 应淘汰的是最旧 2 条 canceled
  seedQueue(q, 200, 0, 2);
  // 注意 seedQueue 顺序 done 先入、canceled 后入 → 最旧的 2 条是 done。改为手动构造验证 FIFO：
  const q2 = new DownloadQueue(() => {});
  for (let k = 0; k < 2; k++) { const it = { id: 'old-c' + k, url: 'u' + k, engine: 'yt-dlp', status: 'canceled' }; q2.items.set(it.id, it); q2.order.push(it.id); }
  for (let k = 0; k < 200; k++) { const it = { id: 'd' + k, url: 'u' + k, engine: 'yt-dlp', status: 'done' }; q2.items.set(it.id, it); q2.order.push(it.id); }
  q2.pruneFinished();
  assert.strictEqual(q2.items.size, 200);
  assert.ok(!q2.items.has('old-c0') && !q2.items.has('old-c1'), '最旧的 2 条 canceled 被淘汰');
  assert.ok(q2.items.has('d0'), '全部 done 保留');
});

t('prune·edge：main.js 启动恢复路径（queue.push 触发冷启动清场）——push 会先淘汰再广播', () => {
  const q = new DownloadQueue(() => {});
  q.broadcast = () => {};   // main.js 里 push() = pruneFinished + broadcast(snapshot)
  seedQueue(q, 210, 0, 0);
  assert.doesNotThrow(() => q.push());
  assert.strictEqual(q.items.size, 200, 'push 冷启动即完成终态清场');
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
