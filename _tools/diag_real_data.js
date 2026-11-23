// 真实数据诊断：拉起真实 userData（%APPDATA%/Keepsake），查订阅主页视图/手动视图为何只显示 1 个/0 个
// 用完即查即退，不改任何数据
const path = require('path');
(async () => {
  const { _electron: electron } = require('playwright');
  const electronExe = path.join(__dirname, '../app/node_modules/electron/dist/electron.exe');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: electronExe, args: [path.resolve(__dirname, '../app')], env });
  const win = await app.firstWindow();
  win.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3000);   // 等 subsList/libraryScan 完成
  const st = await win.evaluate(() => ({
    subsRaw: (window.subsItems || []).length,
    subsNames: (window.subsItems || []).map(s => s.name).slice(0, 20),
    libGroups: (window.libData || {}).groups ? window.libData.groups.length : 'not loaded',
    manualCnt: (window.libData || {}).groups ? window.libData.groups.reduce((n, g) => n + g.files.filter(f => f.src && f.src.via && f.src.via !== 'sub').length, 0) : null,
    srcTotal: (window.libData || {}).groups ? window.libData.groups.reduce((n, g) => n + g.files.filter(f => f.src).length, 0) : null,
    fileTotal: (window.libData || {}).groups ? window.libData.groups.reduce((n, g) => n + g.files.length, 0) : null,
    uploaderSample: (window.libData || {}).groups ? window.libData.groups.slice(0, 12).map(g => g.uploader + '@' + g.site + ':' + g.files.length) : null
  }));
  console.log('BEFORE-VIEW:', JSON.stringify(st, null, 1));
  // 切到订阅主页视图
  await win.evaluate(() => libViewGo('subs'));
  await win.waitForTimeout(600);
  const subsView = await win.evaluate(() => ({
    cards: document.querySelectorAll('#libList .subgcard').length,
    names: [...document.querySelectorAll('#libList .sg-name .nm')].map(x => x.textContent).slice(0, 20)
  }));
  console.log('SUBS-VIEW:', JSON.stringify(subsView, null, 1));
  await win.screenshot({ path: path.join(__dirname, '../评审材料/vf5-content/diag-subs-real.png') });
  // 切手动视图
  await win.evaluate(() => libViewGo('manual'));
  await win.waitForTimeout(600);
  const manualView = await win.evaluate(() => ({
    cards: document.querySelectorAll('#libList .lcard').length,
    empty: (document.querySelector('#libList .empty') || {}).textContent || null
  }));
  console.log('MANUAL-VIEW:', JSON.stringify(manualView));
  await win.screenshot({ path: path.join(__dirname, '../评审材料/vf5-content/diag-manual-real.png') });
  await app.close();
})().catch(e => { console.error('FATAL', e); process.exit(1); });
