// mock 无头出 v9 效果图：组卡网格 / 组内视图 / 订阅卡操作行
const fs = require('fs'), path = require('path');
(async () => {
  const { chromium } = require('playwright');
  const src = fs.readFileSync('_tools/verify_fused.js', 'utf8');
  const seg = src.match(/const SNAP = [\s\S]*?const MOCK = `[\s\S]*?`;/)[0];
  const mock = eval(seg + '; MOCK');   // 求值模板字符串（否则 ${...} 字面量进浏览器直接语法错误）
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.addInitScript(mock);
  const url = 'file:///' + path.resolve('app/index.html').split(path.sep).join('/');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!document.querySelector('.toolbar') && !!document.querySelector('.sidebar'));
  await page.waitForTimeout(1500);
  console.log('PAGE-ERRORS-SO-FAR:', JSON.stringify(errs));
  const out = p => path.join('评审材料/vf5-content', p);
  await page.evaluate(() => { switchPage('lib'); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('vf9-groupcards.png') });
  await page.evaluate(() => { const c = document.querySelector('#libList .subgcard'); if (c) c.click(); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('vf9-group-inner.png') });
  await page.evaluate(() => libViewGo('subs'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('vf9-subops.png') });
  console.log('SHOTS OK', JSON.stringify(errs));
  await browser.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
