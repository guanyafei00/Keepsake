// P2 批次 A 离线单测（#40 剪贴板 / #41 确认卡片 / #42 回溯上限）
// 纯 node 运行（不启 electron）：node tools/test-p2-batch-a-unit.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { ClipWatcher, classifyNotifiable, withinDedupe, DEDUPE_WINDOW_MS } = require('../lib/clipwatch');
const identify = require('../lib/identify');
const subs = require('../lib/subs');
const settings = require('../lib/settings');

let pass = 0, fail = 0;
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- #40 剪贴板：URL 提取 ----
t('extractUrl 从普通文本提取 http(s) URL', () => {
  assert.strictEqual(ClipWatcher.extractUrl('看看这个 https://www.bilibili.com/video/BV1xx 好东西'), 'https://www.bilibili.com/video/BV1xx');
  assert.strictEqual(ClipWatcher.extractUrl('markdown [x](http://a.example/b) 尾巴'), 'http://a.example/b');
  assert.strictEqual(ClipWatcher.extractUrl('没有链接'), null);
  assert.strictEqual(ClipWatcher.extractUrl(''), null);
  assert.strictEqual(ClipWatcher.extractUrl(null), null);
});
t('extractUrl 剥引号/尖括号（网页复制场景）', () => {
  assert.strictEqual(ClipWatcher.extractUrl('<a href="https://x.example/a">x</a>'), 'https://x.example/a');
});

// ---- #40 剪贴板：引擎白名单过滤 ----
t('classifyNotifiable：direct/yt-dlp/gallery-dl/article 可提示', () => {
  for (const e of ['direct', 'yt-dlp', 'gallery-dl', 'article']) assert.ok(classifyNotifiable(e), e);
});
t('classifyNotifiable：feed/invalid/unknown 不提示', () => {
  for (const e of ['feed', 'invalid', 'unknown', undefined, null]) assert.ok(!classifyNotifiable(e), String(e));
});

// ---- #40 剪贴板：24h 去重窗口 ----
t('withinDedupe：从未提示（undefined/null）不命中', () => {
  assert.strictEqual(withinDedupe(undefined, Date.now()), false);
  assert.strictEqual(withinDedupe(null, Date.now()), false);
});
t('withinDedupe：24h 内命中 / 超窗不命中', () => {
  const now = Date.now();
  assert.strictEqual(withinDedupe(now - 1000, now), true);
  assert.strictEqual(withinDedupe(now - DEDUPE_WINDOW_MS - 1000, now), false);
  assert.strictEqual(withinDedupe(now - DEDUPE_WINDOW_MS, now), false);   // 恰好 24h 视为过期
});
t('withinDedupe：非法时间戳不命中', () => {
  assert.strictEqual(withinDedupe('bad', Date.now()), false);
  assert.strictEqual(withinDedupe(NaN, Date.now()), false);
});

// ---- #40 剪贴板：Watcher 活跃门控与去重 ----
t('ClipWatcher：非活跃期只更新基线不触发；活跃后才检测；同 URL 不重复触发', async () => {
  let active = false;
  let text = 'baseline text';
  const fired = [];
  const w = new ClipWatcher(() => text, url => fired.push(url), () => active);
  w.start(10);
  await sleep(40);                                       // 基线轮
  text = 'inactive new https://a.example/1';             // 非活跃期间变化：只更新基线，绝不触发
  await sleep(40);
  active = true;
  text = 'active new https://b.example/2';               // 活跃后新链接：触发
  await sleep(60);
  text = 'active new https://b.example/2';               // 同一文本：无变化零开销，不重复触发
  await sleep(30);
  text = 'again https://c.example/3';                    // 又一条新链接：触发
  await sleep(60);
  w.stop();
  assert.deepStrictEqual(fired, ['https://b.example/2', 'https://c.example/3'],
    '非活跃期不得触发，活跃后每条新文本弹一次（同 URL 24h 去重在 main 层 withinDedupe 覆盖）: ' + JSON.stringify(fired));
});
t('ClipWatcher.stop 后不再轮询', async () => {
  let n = 0;
  const w = new ClipWatcher(() => 'text ' + (++n), () => {}, null);
  w.start(10);
  w.stop();
  const before = n;
  await sleep(40);
  assert.ok(n - before <= 1, 'stop 后轮询应已停止');
});

// ---- #41 确认卡片数据组装（identify.confirmCard 纯函数）----
t('confirmCard：yt-dlp 元数据齐全（标题/作者/时长/封面/合集）', () => {
  const c = identify.confirmCard('https://www.bilibili.com/video/BV1xx', {
    engine: 'yt-dlp', ok: true, title: '测试视频标题', uploader: 'UP主甲',
    duration: 3725, thumbnail: 'https://i.example/cover.jpg', isPlaylist: true, entryCount: 12,
  });
  assert.strictEqual(c.mode, 'meta');
  assert.strictEqual(c.title, '测试视频标题');
  assert.strictEqual(c.uploader, 'UP主甲');
  assert.strictEqual(c.durationText, '1:02:05');
  assert.strictEqual(c.cover, 'https://i.example/cover.jpg');
  assert.strictEqual(c.isPlaylist, true);
  assert.strictEqual(c.entryCount, 12);
  assert.strictEqual(c.domain, 'bilibili.com');
});
t('confirmCard：探测失败 → fail + 原因（「仍要添加」兜底前提）', () => {
  const c = identify.confirmCard('https://x.example/v/1', { engine: 'yt-dlp', ok: false, reason: '无法解析此链接' });
  assert.strictEqual(c.mode, 'fail');
  assert.strictEqual(c.reason, '无法解析此链接');
});
t('confirmCard：gallery-dl 图站 → gdl 模式 + 域名标识', () => {
  const c = identify.confirmCard('https://www.pixiv.net/users/123', { engine: 'gallery-dl', ok: true });
  assert.strictEqual(c.mode, 'gdl');
  assert.strictEqual(c.domain, 'pixiv.net');
});
t('confirmCard：direct 直连 / article 文章模式', () => {
  assert.strictEqual(identify.confirmCard('https://www.douyin.com/video/1', { engine: 'direct', ok: true }).mode, 'direct');
  assert.strictEqual(identify.confirmCard('https://mp.weixin.qq.com/s/abc', { engine: 'article', ok: true }).mode, 'article');
});
t('confirmCard：invalid / feed 原样透传原因', () => {
  const inv = identify.confirmCard('ftp://x', { engine: 'invalid', reason: '不是 http(s) 链接' });
  assert.strictEqual(inv.mode, 'invalid');
  assert.strictEqual(inv.reason, '不是 http(s) 链接');
  assert.strictEqual(identify.confirmCard('https://x/feed', { engine: 'feed', ok: true }).mode, 'feed');
});
t('confirmCard：ok 但无标题 → 域名兜底标题', () => {
  const c = identify.confirmCard('https://example.com/watch/1', { engine: 'yt-dlp', ok: true, title: null });
  assert.strictEqual(c.mode, 'meta');
  assert.strictEqual(c.title, 'example.com');
});
t('fmtDuration 时长格式（含小时/分钟）', () => {
  assert.strictEqual(identify.confirmCard('https://a.example/1', { engine: 'yt-dlp', ok: true, duration: 65 }).durationText, '1:05');
  assert.strictEqual(identify.confirmCard('https://a.example/1', { engine: 'yt-dlp', ok: true, duration: 0 }).durationText, null);
});

// ---- #42 回溯上限：latestCut 截取语义（subs.js 复用于 backfill）----
t('latestCut：最新在前清单只取前 N 条，超出跳过', () => {
  const items = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }, { id: 'n4' }, { id: 'n5' }];
  const cut = subs.latestCut(items, 2, false);
  assert.deepStrictEqual(cut.enqueue.map(i => i.id), ['n1', 'n2']);   // 从最新往回数
  assert.strictEqual(cut.skipped, 3);
});
t('latestCut：合集（最新在尾）取尾部 N 条', () => {
  const items = [{ id: 'o1' }, { id: 'o2' }, { id: 'n3' }, { id: 'n4' }];
  const cut = subs.latestCut(items, 2, true);
  assert.deepStrictEqual(cut.enqueue.map(i => i.id), ['n3', 'n4']);
  assert.strictEqual(cut.skipped, 2);
});
t('latestCut：0=不限 / N≥长度=全量 / 非数组安全', () => {
  const items = [{ id: 'a' }, { id: 'b' }];
  assert.deepStrictEqual(subs.latestCut(items, 0, false).enqueue.length, 2);
  assert.strictEqual(subs.latestCut(items, 0, false).skipped, 0);
  assert.deepStrictEqual(subs.latestCut(items, 5, false).enqueue.length, 2);
  assert.deepStrictEqual(subs.latestCut(null, 3, false).enqueue, []);
});

// ---- #42 回溯上限：订阅持久化与归一化（stub 队列不涉及网络）----
t('subs.add 持久化 maxBackfill；非法值归 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-p2a-'));
  subs.configure({ binDir: dir, cookiePath: path.join(dir, 'c.txt'), file: path.join(dir, 'subs.json') });
  const r1 = subs.add('https://www.pixiv.net/users/123', '测试图站订阅', 20);
  assert.ok(r1.ok);
  assert.strictEqual(r1.sub.maxBackfill, 20);
  const r2 = subs.add('https://www.pixiv.net/users/456', '测试图站订阅B', 7);   // 非档位 → 0
  assert.ok(r2.ok);
  assert.strictEqual(r2.sub.maxBackfill, 0);
  const r3 = subs.add('https://www.pixiv.net/users/789', '测试图站订阅C');      // 缺省 → 0（不限）
  assert.ok(r3.ok);
  assert.strictEqual(r3.sub.maxBackfill, 0);
});
t('subs.update 归一化 maxBackfill（白名单字段）', () => {
  const list = subs.list();
  const id = list[list.length - 3].id;
  assert.strictEqual(subs.update(id, { maxBackfill: 50 }).ok, true);
  assert.strictEqual(subs.get(id).maxBackfill, 50);
  assert.strictEqual(subs.update(id, { maxBackfill: 33 }).ok, true);   // 非档位 → 0
  assert.strictEqual(subs.get(id).maxBackfill, 0);
  assert.strictEqual(subs.update(id, { maxBackfill: 100 }).ok, true);
  assert.strictEqual(subs.get(id).maxBackfill, 100);
});
t('subs.list() 对外暴露 maxBackfill（渲染层卡片展示前提）', () => {
  const list = subs.list();
  assert.ok(list.length >= 1);
  assert.ok('maxBackfill' in list[list.length - 1]);
});

// ---- #40 剪贴板：默认开关（设置默认开）----
t('settings：clipboardWatch 缺省默认开启（#40）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-p2a-set-'));
  settings.configure({ file: path.join(dir, 'settings.json'), defaultOutDir: dir });
  assert.strictEqual(settings.get().clipboardWatch, true);
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
