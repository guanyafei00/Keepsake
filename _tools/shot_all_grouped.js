const path = require('path');
(async () => {
  const { _electron: electron } = require('playwright');
  const electronExe = path.join(__dirname, '../app/node_modules/electron/dist/electron.exe');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: electronExe, args: [path.resolve(__dirname, '../app')], env });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3500);
  await win.evaluate(() => { try { localStorage.setItem('keepsake-onboarded','1'); } catch(e){} document.getElementById('onboardMask')?.remove(); switchPage('lib'); });
  await win.waitForTimeout(1500);
  const st = await win.evaluate(() => ({
    grps: document.querySelectorAll('#libList .libgrp').length,
    heads: [...document.querySelectorAll('#libList .lg-name')].map(x => x.textContent.trim()).slice(0, 20),
    cards: document.querySelectorAll('#libList .lcard').length
  }));
  console.log('GROUPED:', JSON.stringify(st, null, 1));
  await win.screenshot({ path: path.join(__dirname, '../评审材料/vf5-content/vf8-grouped-real.png') });
  await app.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
