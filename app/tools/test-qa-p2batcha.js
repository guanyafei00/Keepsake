// QA 独立验证补充测试（P2 批次 A：#40 剪贴板 / #41 确认卡片 / #42 回溯上限）
// 只测交付代码的行为契约，不改源码。运行：node tools/test-qa-p2batcha.js
const assert = require('assert');
const { ClipWatcher, classifyNotifiable } = require('../lib/clipwatch');
const identify = require('../lib/identify');
const subs = require('../lib/subs');

let pass = 0, fail = 0;
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- ⑤ latestCut 两种顺序的截取正确性（自构造用例）----
t('QA latestCut：普通 media（最新在前）取头部 N 条', () => {
  const items = [{ id: 'v5' }, { id: 'v4' }, { id: 'v3' }, { id: 'v2' }, { id: 'v1' }];
  const cut = subs.latestCut(items, 2, false);
  assert.deepStrictEqual(cut.enqueue.map(i => i.id), ['v5', 'v4']);
  assert.strictEqual(cut.skipped, 3);
});
t('QA latestCut：合集（时间正序最新在尾）取尾部 N 条', () => {
  const items = [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }, { id: 'v4' }, { id: 'v5' }];
  const cut = subs.latestCut(items, 2, true);
  assert.deepStrictEqual(cut.enqueue.map(i => i.id), ['v4', 'v5']);
  assert.strictEqual(cut.skipped, 3);
});
t('QA latestCut：N=长度-1 / N=长度 / N=长度+1 边界', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepStrictEqual(subs.latestCut(items, 2, false).enqueue.map(i => i.id), ['a', 'b']);
  assert.deepStrictEqual(subs.latestCut(items, 3, true).enqueue.map(i => i.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(subs.latestCut(items, 9, true).enqueue.map(i => i.id), ['a', 'b', 'c']);
  assert.strictEqual(subs.latestCut(items, 9, true).skipped, 0);
});
t('QA latestCut：负数/小数/0 → 不限或按 floor 截取', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  assert.strictEqual(subs.latestCut(items, -3, false).enqueue.length, 2);   // 负数=不限
  assert.deepStrictEqual(subs.latestCut(items, 1.9, false).enqueue.map(i => i.id), ['a']);   // floor→1
  assert.strictEqual(subs.latestCut(items, 0, false).enqueue.length, 2);
  assert.deepStrictEqual(subs.latestCut('not-array', 1, false).enqueue, []);
});

// ---- ⑥ maxBackfill 归一化：非法值行为 ----
t('QA normMaxBackfill：负数/字符串/undefined/NaN/小数/布尔', () => {
  assert.strictEqual(subs.normMaxBackfill(-5), 0);
  assert.strictEqual(subs.normMaxBackfill(-1), 0);
  assert.strictEqual(subs.normMaxBackfill('20'), 20);          // 字符串数字接受
  assert.strictEqual(subs.normMaxBackfill('abc'), 0);
  assert.strictEqual(subs.normMaxBackfill(undefined), 0);
  assert.strictEqual(subs.normMaxBackfill(null), 0);
  assert.strictEqual(subs.normMaxBackfill(NaN), 0);
  assert.strictEqual(subs.normMaxBackfill(Infinity), 0);
  assert.strictEqual(subs.normMaxBackfill(20.9), 20);          // floor
  assert.strictEqual(subs.normMaxBackfill(0.5), 0);
  assert.strictEqual(subs.normMaxBackfill(true), 0);           // Number(true)=1，不在档位 → 0
  assert.strictEqual(subs.normMaxBackfill(100), 100);
  assert.strictEqual(subs.normMaxBackfill(0), 0);
  assert.deepStrictEqual(subs.MAX_BACKFILL_CHOICES, [0, 10, 20, 50, 100]);
});
t('QA subs.update：maxBackfill 白名单外字段不落库；非法值归 0 不抛错', () => {
  const r = subs.update('no-such-id', { maxBackfill: 10 });
  assert.strictEqual(r.ok, false);
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ks-qa-mb-'));
  subs.configure({ binDir: dir, cookiePath: dir, file: require('path').join(dir, 'subs.json') });
  const a = subs.add('https://www.pixiv.net/users/1', 'QA订阅', 10);
  assert.ok(a.ok);
  const id = subs.list()[0].id;
  // 白名单外字段（如 evil 键）不得写入
  const r2 = subs.update(id, { evil: 'x', maxBackfill: '50' });
  assert.ok(r2.ok);
  assert.strictEqual(subs.get(id).evil, undefined);
  assert.strictEqual(subs.get(id).maxBackfill, 50);
  assert.strictEqual(subs.update(id, { maxBackfill: -99 }).ok, true);
  assert.strictEqual(subs.get(id).maxBackfill, 0);
});

// ---- ③ confirmCard 七种 mode 与 identify.classify 一致性 ----
t('QA confirmCard×classify：direct 站即使无 ok 字段也必须是 direct，绝不错位成 fail', () => {
  for (const u of ['https://www.douyin.com/video/7301', 'https://v.kuaishou.com/abc',
    'https://www.xiaohongshu.com/explore/64f0', 'https://xhslink.com/a1B2c3']) {
    const c = identify.classify(u);
    assert.strictEqual(c.engine, 'direct', u);
    const card = identify.confirmCard(u, c);   // classify 原样喂给 confirmCard（无 ok/title）
    assert.strictEqual(card.mode, 'direct', u);
    assert.ok(card.domain, u);
  }
});
t('QA confirmCard×classify：gallery-dl/article/feed/invalid 映射一致', () => {
  const cases = [
    ['https://www.pixiv.net/users/6373294', 'gallery-dl', 'gdl'],
    ['https://weibo.com/u/123456', 'gallery-dl', 'gdl'],
    ['https://blog.csdn.net/x/article/1', 'article', 'article'],
    ['https://mp.weixin.qq.com/s/abc', 'article', 'article'],
    ['https://example.com/feed/', 'feed', 'feed'],
    ['ftp://x.example/a', 'invalid', 'invalid'],
  ];
  for (const [u, eng, mode] of cases) {
    assert.strictEqual(identify.classify(u).engine, eng, u);
    assert.strictEqual(identify.confirmCard(u, identify.classify(u)).mode, mode, u);
  }
});
t('QA confirmCard：unknown 引擎探测失败 → fail（白名单不提示的兜底路径不误报 direct）', () => {
  const card = identify.confirmCard('https://random.example/page/1', { engine: 'yt-dlp', ok: false, reason: '无法解析此链接' });
  assert.strictEqual(card.mode, 'fail');
  assert.strictEqual(card.reason, '无法解析此链接');
});
t('QA confirmCard：meta 标题超 120 截断；XSS 向量仅作为纯文本返回（渲染层 esc 负责转义）', () => {
  const long = 'x'.repeat(300);
  const card = identify.confirmCard('https://a.example/1', { engine: 'yt-dlp', ok: true, title: long });
  assert.strictEqual(card.title.length, 120);
  const xss = identify.confirmCard('https://a.example/2', { engine: 'yt-dlp', ok: true, title: '<img src=x onerror=alert(1)>' });
  assert.strictEqual(xss.title, '<img src=x onerror=alert(1)>');   // 纯函数不转义是契约：转义在渲染层 esc()
});
t('QA confirmCard×白名单：可提示引擎与卡片模式集合一致（#40/#41 联动契约）', () => {
  // 白名单 direct/yt-dlp/gallery-dl/article ↔ 卡片 mode direct/meta/gdl/article（+fail 兜底）
  const notifyModes = new Set(['direct', 'meta', 'gdl', 'article', 'fail']);
  for (const eng of ['direct', 'yt-dlp', 'gallery-dl', 'article']) {
    assert.ok(classifyNotifiable(eng));
    const m = identify.confirmCard('https://a.example/1',
      eng === 'yt-dlp' ? { engine: eng, ok: true, title: 't' } : { engine: eng, ok: true }).mode;
    assert.ok(notifyModes.has(m), eng + ' → ' + m);
  }
  for (const eng of ['feed', 'invalid', 'unknown']) assert.ok(!classifyNotifiable(eng));
});

// ---- ② isActive 门控死角组合（watcher 行为层验证）----
t('QA ClipWatcher：非活跃期多次变化只追基线，恢复活跃后不补弹旧内容', async () => {
  let active = false;
  let text = 'base';
  const fired = [];
  const w = new ClipWatcher(() => text, u => fired.push(u), () => active);
  w.start(8);
  await sleep(30);
  text = 'off1 https://a.example/1';
  await sleep(20);
  text = 'off2 https://b.example/2';    // 非活跃期连变两次
  await sleep(20);
  active = true;                        // 恢复活跃：不切文本
  await sleep(40);
  assert.deepStrictEqual(fired, [], '恢复活跃时旧基线不得补弹');
  text = 'on https://c.example/3';      // 活跃期新内容才弹
  await sleep(40);
  assert.deepStrictEqual(fired, ['https://c.example/3']);
  w.stop();
});
t('QA ClipWatcher：getText 抛错静默跳过本轮；isActive=false 时绝不回调 onUrl', async () => {
  let boom = false, active = false;
  let text = 's https://s.example/1';
  const fired = [];
  const w = new ClipWatcher(
    () => { if (boom) throw new Error('clipboard busy'); return text; },
    u => fired.push(u),
    () => active);
  w.start(8);
  await sleep(25);
  boom = true; text = 'x https://x.example/1';
  await sleep(25);
  assert.deepStrictEqual(fired, []);
  boom = false;                          // 异常恢复后（仍非活跃）也不触发
  await sleep(25);
  assert.deepStrictEqual(fired, []);
  w.stop();
});
t('QA ClipWatcher：窗口销毁场景 isActive 恒 false → 基线只追不弹', async () => {
  // 模拟 main.js 的 win 销毁守卫：!win || win.isDestroyed() → false
  let winAlive = true, text = 'a', fired = 0;
  const w = new ClipWatcher(() => text, () => fired++, () => winAlive ? true : false);
  w.start(8);
  await sleep(25);
  winAlive = false; text = 'b https://d.example/1';   // 相当于窗口销毁：不弹
  await sleep(25);
  assert.strictEqual(fired, 0);
  w.stop();
});

// ---- ① 剪贴板链路纯函数层：提取 URL 的括号/空白边界（去重 key 的稳定性前提）----
t('QA extractUrl：URL 截断在括号/空白；同 URL 文本变体去重 key 一致', () => {
  assert.strictEqual(ClipWatcher.extractUrl('见 https://a.example/v(1) 结束'), 'https://a.example/v');
  assert.strictEqual(ClipWatcher.extractUrl('前 https://b.example/x\n后'), 'https://b.example/x');
  // 同一 URL 无论前后文如何变化，提取结果一致 → _clipSeen 的 key 稳定
  const u = 'https://c.example/watch?v=1';
  assert.strictEqual(ClipWatcher.extractUrl('复制了 ' + u + ' 快看'), u);
  assert.strictEqual(ClipWatcher.extractUrl('"' + u + '"'), u);
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
