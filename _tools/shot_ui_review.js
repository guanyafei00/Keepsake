// 设计评审截图：mock 数据下截取各主要视图（chromium + verify_fused MOCK，无需 electron）
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
  await page.waitForTimeout(1500);

  const outDir = path.resolve('评审材料/ui-review');
  fs.mkdirSync(outDir, { recursive: true });
  const shot = async (name, fn) => {
    if (fn) await page.evaluate(fn);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, name) });
    console.log('SHOT', name);
  };

  await shot('01-tasks.png', () => switchPage('tasks'));
  await shot('02-rss.png', () => switchPage('rss'));
  await shot('03-lib-all.png', () => switchPage('lib'));
  await shot('04-lib-group.png', () => { if (window.libData && libData.groups[0]) enterLibGroup(libData.groups[0].key); });
  await shot('05-drawer.png', () => { const c = document.querySelector('#libList .lcard-info'); if (c) c.click(); });
  await shot('06-subs-view.png', () => { closeLibDrawer(); backLibGroup(); libViewGo('subs'); });
  await shot('07-settings.png', () => switchPage('settings'));
  await shot('08-strategy.png', () => switchPage('strategy'));

  await browser.close();
  console.log('DONE');
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
