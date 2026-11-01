// P2 批次 B 离线单测（#37 CBZ 漫画册 / #39 崩溃可恢复下载）
// 纯 node 运行（不启 electron、不真跑 bsdtar——打包注入 tarFn mock）：node tools/test-p2-batch-b-unit.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cbz = require('../lib/cbz');
const store = require('../lib/store');
const strategy = require('../lib/strategy');

let pass = 0, fail = 0;
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

// ---- #37 ComicInfo.xml 生成：XML 转义 ----
t("buildComicInfoXml：& < > \" ' 全转义（标题含特殊字符不产生非法 XML）", () => {
  const xml = cbz.buildComicInfoXml({ title: 'A&B <C> "D" \'E\'', series: 'S<R', writer: 'W&G', web: 'https://x.example/a?b=1&c=2' });
  assert.ok(xml.includes('<Title>A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;</Title>'), xml);
  assert.ok(xml.includes('<Series>S&lt;R</Series>'), xml);
  assert.ok(xml.includes('<Writer>W&amp;G</Writer>'), xml);
  assert.ok(xml.includes('<Web>https://x.example/a?b=1&amp;c=2</Web>'), xml);
  // 元素文本里不得出现裸 <（除标签自身；声明/标签由正则剥除，含 <?xml …?> 处理指令）
  const body = xml.replace(/<\/?[A-Za-z?][^>]*>/g, '');
  assert.ok(!/[<>]/.test(body), '转义后元素文本不应含裸尖括号: ' + body);
});
t('buildComicInfoXml：Year/Month 取自 date 字段（任务时间）', () => {
  const xml = cbz.buildComicInfoXml({ title: 'T', date: new Date(2026, 9, 15).getTime() });
  assert.ok(xml.includes('<Year>2026</Year>'), xml);
  assert.ok(xml.includes('<Month>10</Month>'), xml);
});
t('buildComicInfoXml：缺省字段整个元素省略（空 Year/Month 会让阅读器解析报错）', () => {
  const xml = cbz.buildComicInfoXml({ title: '只有标题' });
  assert.ok(!xml.includes('<Writer>'), '无 writer 不写 Writer 元素');
  assert.ok(!xml.includes('<Web>'), '无 web 不写 Web 元素');
  assert.ok(xml.includes('<Series>只有标题</Series>'), 'series 缺省回落 title');
  assert.ok(xml.includes('<LanguageIso>zh-CN</LanguageIso>'), '语言默认 zh-CN');
  assert.ok(xml.includes('<Year>'), '缺省 date 用当前时间补 Year');
});
t('buildComicInfoXml：非法 date 不写 Year/Month，不抛异常', () => {
  const xml = cbz.buildComicInfoXml({ title: 'T', date: NaN });
  assert.ok(!xml.includes('<Year>') && !xml.includes('<Month>'), xml);
});

// ---- #37 图片目录选取（任务产出清单 → 打包目录）----
t('pickImageDir：多目录取图片数最多的那个', () => {
  const files = [
    'D:/dl/pixiv/userA/1.jpg', 'D:/dl/pixiv/userA/2.jpg', 'D:/dl/pixiv/userA/3.jpg', 'D:/dl/pixiv/userA/4.jpg',
    'D:/dl/pixiv/userB/1.png', 'D:/dl/pixiv/userB/2.png',
  ];
  assert.strictEqual(cbz.pickImageDir(files), 'D:/dl/pixiv/userA');
});
t('pickImageDir：低于最小图片阈值返回 null（单图/缩略图目录不卷入）', () => {
  const files = ['D:/dl/x/1.jpg', 'D:/dl/x/2.png', 'D:/dl/x/cover.webp'];   // 3 张 = 刚好达标
  assert.strictEqual(cbz.pickImageDir(files), 'D:/dl/x');
  assert.strictEqual(cbz.pickImageDir(files.slice(0, 2)), null, '2 张 < 3 不成册');
  assert.strictEqual(cbz.pickImageDir(files, 5), null, '自定义阈值 5 也不达标');
});
t('pickImageDir：非图片文件忽略 / 空清单 / 非法入参安全', () => {
  assert.strictEqual(cbz.pickImageDir(['D:/x/1.txt', 'D:/x/2.mp4', 'D:/x/3.srt', 'D:/x/a.cbz']), null);
  assert.strictEqual(cbz.pickImageDir([]), null);
  assert.strictEqual(cbz.pickImageDir(null), null);
  assert.strictEqual(cbz.pickImageDir(undefined), null);
  assert.strictEqual(cbz.pickImageDir([123, {}]), null);
});
t('cbzOutPath：册子与目录平级、取目录名（幂等路径逻辑基础）', () => {
  assert.strictEqual(cbz.cbzOutPath('D:/dl/pixiv/userA'), 'D:\\dl\\pixiv\\userA.cbz');
  assert.strictEqual(cbz.cbzOutPath('C:\\dl\\图组'), 'C:\\dl\\图组.cbz');
});

// ---- #37 打包幂等与 staging（tarFn 注入 mock，不真跑 bsdtar）----
t('makeCbzFromDir：同名 .cbz 已存在 → 幂等返回已有路径，绝不重复打包', async () => {
  let tarCalled = false;
  const r = await cbz.makeCbzFromDir('D:/dl/pixiv/userA', { title: 'userA' }, {
    existsFn: p => p === 'D:\\dl\\pixiv\\userA.cbz',
    tarFn: () => { tarCalled = true; return Promise.resolve(); },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, true, '已存在应标记 skipped');
  assert.strictEqual(r.cbz, 'D:\\dl\\pixiv\\userA.cbz');
  assert.strictEqual(tarCalled, false, '幂等命中不得调用打包');
});
t('makeCbzFromDir：打包参数含 --format zip；ComicInfo.xml 落在 staging、staging 用后清理', async () => {
  let seen = null;
  const r = await cbz.makeCbzFromDir('D:/dl/pixiv/userA', { title: 'userA', writer: '作者甲', date: new Date(2026, 0, 2).getTime() }, {
    existsFn: () => false,
    tarFn: ctx => {
      seen = ctx;
      assert.ok(Array.isArray(ctx.args), 'tarFn 收到参数数组');
      assert.ok(ctx.args.includes('--format') && ctx.args.includes('zip'), '必须显式 --format zip（.cbz 走 -a 会落 ustar）');
      const ci = ctx.args.indexOf('ComicInfo.xml');
      assert.ok(ci > 0, '参数末尾带 staging 的 ComicInfo.xml');
      assert.ok(fs.existsSync(path.join(ctx.staging, 'ComicInfo.xml')), '打包时 staging 里有 ComicInfo.xml');
      const info = fs.readFileSync(path.join(ctx.staging, 'ComicInfo.xml'), 'utf-8');
      assert.ok(info.includes('<Title>userA</Title>') && info.includes('<Writer>作者甲</Writer>') && info.includes('<Year>2026</Year>'), info);
      return Promise.resolve();
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, false);
  assert.ok(seen && seen.staging, 'tarFn 收到 staging 路径');
  assert.ok(!fs.existsSync(seen.staging), '打包完成 staging 必须清理，不留临时残留');
});
t('makeCbzFromDir：打包抛错也清理 staging（finally 清场）', async () => {
  let stagingPath = null;
  await assert.rejects(
    () => cbz.makeCbzFromDir('D:/dl/pixiv/userA', {}, { existsFn: () => false, tarFn: ctx => { stagingPath = ctx.staging; return Promise.reject(new Error('tar exit 1')); } }),
    /tar exit 1/,
  );
  assert.ok(!fs.existsSync(stagingPath), '失败路径 staging 同样清理');
});

// ---- #37 目录图片计数（手动成册阈值反馈用）----
t('countImagesInDir：递归计数、忽略非图片与符号链接、坏路径安全', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-p2b-img-'));
  try {
    fs.writeFileSync(path.join(dir, '1.jpg'), 'x');
    fs.writeFileSync(path.join(dir, '2.png'), 'x');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', '3.webp'), 'x');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'a.cbz'), 'x');
    assert.strictEqual(cbz.countImagesInDir(dir), 3);
    assert.strictEqual(cbz.countImagesInDir(path.join(dir, 'sub')), 1);
    assert.strictEqual(cbz.countImagesInDir(path.join(dir, '不存在的目录')), 0);
    assert.strictEqual(cbz.countImagesInDir(null), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- #39 启动恢复判定（干净退出 / 异常退出 / 全终态 / 首启 四场景）----
const mkTask = (id, status) => ({ id, url: 'https://x.example/' + id, engine: 'yt-dlp', status });
t('startupRecovery：干净退出（标记存在）→ 不判异常、不弹恢复', () => {
  const tasks = [mkTask('a', 'downloading'), mkTask('b', 'queued')];
  const r = store.startupRecovery({ cleanExitFlagExists: true, tasks });
  assert.strictEqual(r.abnormalExit, false);
  assert.strictEqual(r.cleanExit, true);
});
t('startupRecovery：异常退出（标记缺失）+ 未达终态任务 → 判异常并列出 interrupted 清单', () => {
  const tasks = [mkTask('a', 'downloading'), mkTask('b', 'queued'), mkTask('c', 'held'), mkTask('d', 'done'), mkTask('e', 'error')];
  const r = store.startupRecovery({ cleanExitFlagExists: false, tasks });
  assert.strictEqual(r.abnormalExit, true);
  assert.deepStrictEqual(r.interrupted.map(x => x.id), ['a', 'b', 'c'], 'downloading/queued/held 都算未达终态，done/error 不算');
});
t('startupRecovery：异常退出但任务全终态 → 不弹恢复', () => {
  const tasks = [mkTask('a', 'done'), mkTask('b', 'error'), mkTask('c', 'canceled')];
  const r = store.startupRecovery({ cleanExitFlagExists: false, tasks });
  assert.strictEqual(r.abnormalExit, false);
  assert.deepStrictEqual(r.interrupted, []);
});
t('startupRecovery：首次启动（无历史任务）→ 不弹恢复', () => {
  assert.strictEqual(store.startupRecovery({ cleanExitFlagExists: false, tasks: [] }).abnormalExit, false);
  assert.strictEqual(store.startupRecovery({ cleanExitFlagExists: false, tasks: null }).abnormalExit, false);
  assert.strictEqual(store.startupRecovery({}).abnormalExit, false);
});
t('startupRecovery：上次遗留的 interrupted 状态任务本轮仍计入（保持可恢复入口）', () => {
  const tasks = [mkTask('a', 'interrupted')];
  const r = store.startupRecovery({ cleanExitFlagExists: false, tasks });
  assert.strictEqual(r.abnormalExit, true);
  assert.deepStrictEqual(r.interrupted.map(x => x.id), ['a']);
});

// ---- #39 interrupted 任务的重入队路径（复用 retry 机制；stub run 防真启动引擎）----
t('queue.retry：interrupted → queued 可重入队；downloading 等活跃态不可重试', () => {
  const queueMod = require('../lib/queue');
  const { DownloadQueue } = queueMod;
  queueMod.configure({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ks-p2b-q-')) });
  strategy.configure({ stateFile: path.join(os.tmpdir(), 'ks-p2b-state-' + Date.now() + '.json') });   // state._hosts 需初始化，否则 isBreakered 抛错
  const q = new DownloadQueue(() => {});
  q.run = () => {};    // stub：tick 补位绝不真 spawn yt-dlp
  q.tick = () => {};   // tick 也 stub：run 被 stub 后 while 补位循环会无限重选同一 queued 任务（真实现里 run 同步置 downloading 退出循环）
  const it = { id: 'x1', url: 'https://x.example/1', engine: 'yt-dlp', status: 'interrupted', progress: 40, fileCount: 2, error: '上次异常退出' };
  q.items.set(it.id, it); q.order.push(it.id);
  assert.strictEqual(q.retry(it.id), true);
  assert.strictEqual(it.status, 'queued');
  assert.strictEqual(it.progress, 0, '重入队重置进度');
  assert.strictEqual(it.error, null, '重入队清错误标记');
  assert.strictEqual(q.retry(it.id), false, 'queued 活跃态不可再 retry');
  const d = { id: 'x2', url: 'https://x.example/2', engine: 'yt-dlp', status: 'downloading' };
  q.items.set(d.id, d); q.order.push(d.id);
  assert.strictEqual(q.retry(d.id), false, 'downloading 不可 retry');
  q.cancel('x1');   // 清场：stub 后 queued 任务占着 tick 名额，取消归档
  assert.strictEqual(d.status, 'downloading');
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
