// QA 补充边界测试（P2 批次 B 独立验证，不改源码）：
//   A. buildComicInfoXml 特殊字符/注入攻击载荷（& < > " ' 及 <script> 类字段）
//   B. makeCbzFromDir 幂等（并发双调）与 tar 失败路径 staging 清场
//   C. startupRecovery 异常输入（非数组 / 含未知状态值 / null 元素）
//   D. pickImageDir / countImagesInDir 深度与边界
// 运行：node app/tools/test-p2-batch-b-qa-edge.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cbz = require('../lib/cbz');
const store = require('../lib/store');

let pass = 0, fail = 0;
function T(name, fn) {
  try { fn(); pass++; console.log('PASS | ' + name); }
  catch (e) { fail++; console.log('FAIL | ' + name + ' :: ' + e.message); }
}

// ---------- A. XML 注入 ----------
T('A1 全部文本字段经 xmlEsc 转义（title/series/writer/web）', () => {
  const xml = cbz.buildComicInfoXml({
    title: '<script>alert(1)</script>', series: 'a&b"c\'d<e>',
    writer: '&"', web: 'http://x.com/?a=1&b=<2>', language: 'zh-CN', date: 0,
  });
  // 严格断言：原始未转义载荷不得出现在元素文本里
  assert.ok(!xml.includes('<script>'));
  assert.ok(xml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(xml.includes('a&amp;b&quot;c&apos;d&lt;e&gt;'));
  assert.ok(xml.includes('a=1&amp;b=&lt;2&gt;'));
  // 产物必须合法：每个 & 后都必须跟完整实体引用（防裸 & / 截断实体）
  const body = xml.replace(/<\?xml[^?]*\?>/, '');
  assert.ok(!/(^|[^&])&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(body), '存在未转义的裸 & 或不完整实体');
});

T('A2 转义顺序正确：& 先转义，不吃掉后续实体', () => {
  const xml = cbz.buildComicInfoXml({ title: '&amp;', date: 0 });
  assert.ok(xml.includes('&amp;amp;'), '入参 &amp; 应变成 &amp;amp; 而非被二次解释');
});

T('A3 series 缺省回落 title（同样走转义）', () => {
  const xml = cbz.buildComicInfoXml({ title: 'x<y&z', date: 0 });
  assert.ok(xml.includes('<Series>x&lt;y&amp;z</Series>'));
});

// ---------- B. makeCbzFromDir（异步用例，见文件底部 asyncCases 注册并统一执行）----------
const asyncCases = [
  ['B1 幂等：existsFn 命中时不创建 staging、不调 tar', async () => {
    let tarCalled = 0;
    const r = await cbz.makeCbzFromDir('D:/x/imgs', {}, { existsFn: () => true, tarFn: async () => { tarCalled++; } });
    assert.deepStrictEqual(r, { ok: true, skipped: true, cbz: cbz.cbzOutPath('D:/x/imgs') });
    assert.strictEqual(tarCalled, 0, '已存在时不应调 tar');
  }],
  ['B2 tar 抛错 → staging 在 finally 清场（真实临时目录）', async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('keepsake-cbz-')));
    await assert.rejects(
      () => cbz.makeCbzFromDir('D:/x/imgs', {}, { tarFn: async () => { throw new Error('boom'); } }),
      /boom/
    );
    const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('keepsake-cbz-'));
    assert.deepStrictEqual(after.filter(n => !before.has(n)), [], '失败路径不应残留 staging');
  }],
  ['B3 连续双调成功路径：无 staging 残留、均 ok', async () => {
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('keepsake-cbz-')));
    const r1 = await cbz.makeCbzFromDir('D:/x/imgs', {}, { tarFn: async () => {} });
    const r2 = await cbz.makeCbzFromDir('D:/x/imgs', {}, { tarFn: async () => {} });
    assert.ok(r1.ok && r2.ok);
    const after = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('keepsake-cbz-'));
    assert.deepStrictEqual(after.filter(n => !before.has(n)), [], '双调后无 staging 残留');
  }]
];

// ---------- C. startupRecovery 异常输入 ----------
T('C1 tasks 非数组 / null → 不抛异常，abnormalExit=false', () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    const r = store.startupRecovery({ cleanExitFlagExists: false, tasks: bad });
    assert.strictEqual(r.abnormalExit, false, 'bad=' + JSON.stringify(bad));
  }
});

T('C2 tasks 含未知状态值：不计入 interrupted（但数组非空仍需 interrupted>0 才判异常）', () => {
  const r = store.startupRecovery({
    cleanExitFlagExists: false,
    tasks: [{ id: 1, status: 'weird' }, { id: 2, status: 'DONE' }, { id: 3, status: 'done' }],
  });
  assert.strictEqual(r.abnormalExit, false, '未知/终态状态不应触发恢复横幅');
  assert.strictEqual(r.interrupted.length, 0);
});

T('C3 tasks 含 null 元素不抛异常', () => {
  const r = store.startupRecovery({ cleanExitFlagExists: false, tasks: [null, { id: 1, status: 'downloading' }] });
  assert.strictEqual(r.abnormalExit, true);
  assert.strictEqual(r.interrupted.length, 1);
  assert.strictEqual(r.interrupted[0].id, 1);
});

T('C4 四场景回归：干净退出 / 异常+未终态 / 异常+全终态 / 首启空', () => {
  const t = [{ status: 'queued' }, { status: 'downloading' }, { status: 'held' }, { status: 'interrupted' }];
  assert.strictEqual(store.startupRecovery({ cleanExitFlagExists: true, tasks: t }).abnormalExit, false);
  assert.strictEqual(store.startupRecovery({ cleanExitFlagExists: false, tasks: t }).abnormalExit, true);
  assert.strictEqual(store.startupRecovery({ cleanExitFlagExists: false, tasks: [{ status: 'done' }, { status: 'error' }] }).abnormalExit, false);
  assert.strictEqual(store.startupRecovery({ cleanExitFlagExists: false, tasks: [] }).abnormalExit, false);
});

// ---------- D. 边界 ----------
T('D1 countImagesInDir：坏路径/空串/不存在目录安全返回 0', () => {
  assert.strictEqual(cbz.countImagesInDir(''), 0);
  assert.strictEqual(cbz.countImagesInDir(null), 0);
  assert.strictEqual(cbz.countImagesInDir(path.join(os.tmpdir(), 'qa-cbz-not-exist-' + Date.now())), 0);
});

T('D2 countImagesInDir：真实目录递归计数（含子目录一层）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cbz-count-'));
  fs.writeFileSync(path.join(d, '1.jpg'), 'x');
  fs.writeFileSync(path.join(d, '2.png'), 'x');
  fs.writeFileSync(path.join(d, 'note.txt'), 'x');
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'sub', '3.webp'), 'x');
  assert.strictEqual(cbz.countImagesInDir(d), 3);
  fs.rmSync(d, { recursive: true, force: true });
});

T('D3 pickImageDir：并列最多取先出现的目录；minImages 参数可注入', () => {
  assert.strictEqual(cbz.pickImageDir(['a/1.jpg', 'b/1.jpg', 'a/2.jpg', 'b/2.jpg'], 2), 'a', '并列 2:2 取先出现的 a');
  assert.strictEqual(cbz.pickImageDir(['a/1.jpg', 'b/1.jpg', 'a/2.jpg', 'b/2.jpg']), null, '默认阈值 3：各 2 张不成册');
  assert.strictEqual(cbz.pickImageDir(['a/1.jpg', 'a/2.jpg'], 2), 'a');
  assert.strictEqual(cbz.pickImageDir(['a/1.jpg', 'a/2.jpg'], 3), null);
});

// 异步用例串行执行后输出汇总
(async () => {
  for (const [name, fn] of asyncCases) {
    try { await fn(); pass++; console.log('PASS | ' + name); }
    catch (e) { fail++; console.log('FAIL | ' + name + ' :: ' + e.message); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
