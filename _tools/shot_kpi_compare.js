// UI 评审：任务队列 vs 订阅主页 实际渲染尺寸逐项对比（chromium + verify_fused MOCK）
const fs = require('fs'), path = require('path');
(async () => {
  const { chromium } = require('playwright');
  const src = fs.readFileSync('_tools/verify_fused.js', 'utf8');
  const seg = src.match(/const SNAP = [\s\S]*?const MOCK = `[\s\S]*?`;/)[0];
  const mock = eval(seg + '; MOCK');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.addInitScript(mock);
  const url = 'file:///' + path.resolve('app/index.html').split(path.sep).join('/');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.querySelector('.toolbar') && !!document.querySelector('.sidebar'));
  await page.waitForTimeout(1200);

  const outDir = path.resolve('评审材料/ui-review');
  fs.mkdirSync(outDir, { recursive: true });

  const probe = sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { h: +r.height.toFixed(1), w: +r.width.toFixed(1), pad: cs.padding, fs: cs.fontSize, radius: cs.borderRadius, bg: cs.backgroundColor, border: cs.border };
  };

  // —— 订阅主页 ——
  await page.evaluate(() => { switchPage('lib'); libViewGo('subs'); });
  await page.waitForTimeout(600);
  const subs = await page.evaluate((probeStr) => {
    const probe = eval('(' + probeStr + ')');
    return {
      pasteBox: probe('.paste-box'),
      pasteInput: probe('.paste-box input'),
      pasteBtn: probe('.paste-box .btn-dl'),
      card: probe('.subgcard'),
      avatar: probe('.sub-avatar'),
      cardName: probe('.sg-name .nm'),
      cardMeta: probe('.sg-meta'),
      cardAct: probe('.sg-act'),
      count: document.querySelectorAll('.subgcard').length,
    };
  }, probe.toString());
  await page.screenshot({ path: path.join(outDir, 'via-01-subs.png') });

  // —— 任务队列 ——
  await page.evaluate(() => switchPage('tasks'));
  await page.waitForTimeout(600);
  const tasks = await page.evaluate((probeStr) => {
    const probe = eval('(' + probeStr + ')');
    const els = {};
    for (const s of ['.kpi-paste', '.kpi-paste textarea', '.kpi-paste .btn-dl', '.kpi2', '.taskgrid', '.task']) {
      els[s] = probe(s);
    }
    els.taskCount = document.querySelectorAll('.task').length;
    els.kpi2Count = document.querySelectorAll('.kpi2 > *').length;
    els.kpi2Children = [...document.querySelectorAll('.kpi2 > *')].slice(0, 4).map(c => {
      const r = c.getBoundingClientRect(); const cs = getComputedStyle(c);
      return { h: +r.height.toFixed(1), fs: cs.fontSize, txt: (c.textContent || '').trim().slice(0, 12) };
    });
    els.pasteChildren = [...document.querySelectorAll('.kpi-paste, .kpi-paste *')].slice(0, 5).map(c => {
      const r = c.getBoundingClientRect(); const cs = getComputedStyle(c);
      return { tag: c.tagName, h: +r.height.toFixed(1), fs: cs.fontSize, txt: (c.textContent || '').trim().slice(0, 14) };
    });
    return els;
  }, probe.toString());
  await page.screenshot({ path: path.join(outDir, 'via-02-tasks.png') });

  console.log('=== 订阅主页 ===');
  console.log(JSON.stringify(subs, null, 1));
  console.log('=== 任务队列 ===');
  console.log(JSON.stringify(tasks, null, 1));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
