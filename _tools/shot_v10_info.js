// mock 无头出 v10 效果图：任务页（4 状态卡一行 + 下方粘贴框）/ 订阅主页卡（ℹ+操作行）/ 组卡 ℹ / 内容卡 ℹ 常显
const fs = require('fs'), path = require('path');
(async () => {
  const { chromium } = require('playwright');
  const src = fs.readFileSync('_tools/verify_fused.js', 'utf8');
  const seg = src.match(/const SNAP = [\s\S]*?const MOCK = `[\s\S]*?`;/)[0];
  const mock = eval(seg + '; MOCK');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });   // 1180 以下是旧版会折 2×2 的宽度，专验恒 4 列
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.addInitScript(mock);
  const url = 'file:///' + path.resolve('app/index.html').split(path.sep).join('/');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.querySelector('.toolbar') && !!document.querySelector('.sidebar'));
  await page.waitForTimeout(1500);
  const out = p => path.join('评审材料/vf5-content', p);
  // 1. 任务页：4 状态卡一行 + 粘贴框在下方
  await page.evaluate(() => switchPage('tasks'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('vf10-tasks-kpi-paste.png') });
  // 2. 订阅主页视图：订阅卡（操作行 + 右上 ℹ + 页头 ⚙管理）
  await page.evaluate(() => { switchPage('lib'); libViewGo('subs'); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('vf10-subs-info.png') });
  // 3. 所有归档组卡网格（每卡右上 ℹ）
  await page.evaluate(() => libViewGo('all'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('vf10-groupcards-info.png') });
  // 4. 组内内容卡（ℹ 常显）+ ℹ 开抽屉
  await page.evaluate(() => enterLibGroup(libData.groups[0].key));
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('vf10-content-info.png') });
  await page.locator('#libList .lcard-info').first().click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: out('vf10-drawer-open.png') });
  console.log('SHOTS OK', JSON.stringify(errs));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
