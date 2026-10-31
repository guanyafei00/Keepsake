// QA 补充验证（#32 独立回归）：_directPayload 生命周期审计 + snapshot IPC/落盘安全性
// 纯 node 运行：node app/tools/test-qa-edward-china-supplement.js
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const queueMod = require('../lib/queue');
const { DownloadQueue } = queueMod;
const store = require('../lib/store');
const strategy = require('../lib/strategy');

queueMod.configure({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ks-qa32-')) });
strategy.configure({ stateFile: path.join(os.tmpdir(), 'ks-qa32-state-' + Date.now() + '.json') });

let pass = 0, fail = 0;
const t = (name, fn) => ({ name, fn });
const tests = [
  t('add() 接收 _directPayload 且任务项保留（免嗅探直落前提）', () => {
    const q = new DownloadQueue(() => {});
    const payload = { site: 'xiaohongshu', kind: 'images', directUrl: null, directUrls: ['https://x/a.jpg'], title: 't', headers: { 'User-Agent': 'ua' } };
    const item = q.add('https://www.xiaohongshu.com/explore/n1', { engine: 'direct', title: 't', _directPayload: payload });
    assert.ok(item, 'add 应返回任务项');
    const it = q.items.get(item.id);
    assert.deepStrictEqual(it._directPayload, payload, '_directPayload 应原样保留在任务项上');
    assert.strictEqual(it.engine, 'direct');
  }),
  t('duplicate 命中路径返回的摘要不含 _directPayload', () => {
    const q = new DownloadQueue(() => {});
    const payload = { directUrl: 'https://x/v.mp4', headers: { 'User-Agent': 'ua' } };
    const u = 'https://www.douyin.com/video/735100';
    q.add(u, { engine: 'direct', _directPayload: payload });
    const dup = q.add(u, { engine: 'direct', _directPayload: payload });
    assert.ok(dup.duplicate, '第二次 add 应命中查重');
    assert.strictEqual(dup._directPayload, undefined, 'duplicate 摘要不得携带 _directPayload');
  }),
  t('snapshot() 剔除 _directPayload（不外泄渲染层）', () => {
    const q = new DownloadQueue(() => {});
    const payload = { directUrl: 'https://x/v.mp4?token=SECRET', headers: { 'User-Agent': 'ua' } };
    const item = q.add('https://www.xiaohongshu.com/explore/n2', { engine: 'direct', title: '快照测试', _directPayload: payload });
    const s = q.snapshot().find(x => x.id === item.id);
    assert.ok(s, '快照应包含该任务');
    assert.strictEqual(s._directPayload, undefined, '_directPayload 必须从 snapshot 剔除');
    assert.strictEqual(s.title, '快照测试');
  }),
  t('落盘契约（真实生产路径）：直连下载活跃期间 tasks.json 仍能落盘（main.js:479 store.save(snapshot)）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-qa32-disk-'));
    store.configure({ userData: tmp });
    const q = new DownloadQueue(() => {});
    const payload = { site: 'xiaohongshu', directUrl: 'https://x/v.mp4?token=DISKSECRET', headers: { 'User-Agent': 'ua' } };
    q.add('https://www.xiaohongshu.com/explore/n3', { engine: 'direct', title: '落盘测试', _directPayload: payload });
    // 模拟 main.js:477-479 的真实链路：broadcast 收到的是 snapshot，store.save 只见 snapshot
    const snap = q.snapshot();
    store.save(snap);
    store.flushNow();
    let raw = null, writeErr = null;
    try { raw = fs.readFileSync(path.join(tmp, 'tasks.json'), 'utf8'); }
    catch (e) { writeErr = e; }
    const leaked = raw && (raw.includes('DISKSECRET') || raw.includes('_directPayload'));
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.ok(!writeErr, 'tasks.json 未能写出（store.save 的 JSON.stringify 因 snapshot 含活跃 _directReq 循环引用而抛错）: ' + (writeErr && writeErr.message.split('\n')[0]));
    assert.ok(!leaked, 'tasks.json 出现 _directPayload 内容（落盘泄漏）');
  }),
  t('snapshot() 在直连任务活跃下载期间必须可 JSON 序列化（IPC send / tasks.json 落盘依赖）', () => {
    const q = new DownloadQueue(() => {});
    const payload = { site: 'douyin', directUrl: 'https://x/v.mp4?token=LIVE', headers: {} };
    const item = q.add('https://www.douyin.com/video/735200', { engine: 'direct', title: '活跃下载', _directPayload: payload });
    const s = q.snapshot().find(x => x.id === item.id);
    assert.strictEqual(s.status, 'downloading', '免嗅探直落应立即开跑（前置：复现活跃窗口）');
    let err = null;
    try { JSON.stringify(q.snapshot()); } catch (e) { err = e; }
    assert.ok(!err, 'snapshot 循环引用不可序列化: ' + (err && err.message.split('\n')[0]) + '（活跃下载期间 IPC send 抛异常 / tasks.json 落盘失败）');
  }),
];

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); pass++; console.log('PASS | ' + name); }
    catch (e) { fail++; console.log('FAIL | ' + name + ' | ' + (e && e.message)); }
  }
  console.log('----');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
