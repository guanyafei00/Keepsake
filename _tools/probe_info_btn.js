// 探针 v3：隔离 userData（KEEPSAKE_E2E）+ 真实配置/订阅，复现「ℹ 点不开」
// 只读验证：拷配置到临时目录（剥离 DPAPI 加密的 AI Key），不动真实 %APPDATA%/Keepsake
const path = require('path');
const fs = require('fs');
const os = require('os');
(async () => {
  const { _electron: electron } = require('playwright');
  const electronExe = path.join(__dirname, '../app/node_modules/electron/dist/electron.exe');
  const real = path.join(process.env.APPDATA, 'Keepsake');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-probe-'));
  ['settings.json', 'subs.json', 'source-index.json', 'tasks.json'].forEach(f => {
    const s = path.join(real, f);
    if (!fs.existsSync(s)) return;
    let j = JSON.parse(fs.readFileSync(s, 'utf8'));
    if (f === 'settings.json') { delete j.aiKey; delete j.aiUrl; delete j.aiModel; }
    fs.writeFileSync(path.join(tmp, f), JSON.stringify(j));
  });
  const env = { ...process.env, KEEPSAKE_E2E: '1', KEEPSAKE_E2E_DIR: tmp };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: electronExe,
    args: [path.resolve(__dirname, '../app')],
    env
  });
  const win = await app.firstWindow();
  const errs = [];
  win.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  win.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text().slice(0, 200)); });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(1500);
  await win.evaluate(() => { const m = document.getElementById('onboardMask'); if (m) m.remove(); try { localStorage.setItem('keepsake-onboarded', '1'); } catch (e) {} });   // 跳过首启引导罩
  // 轮询等真实库扫描完成（libData 是顶层 let，不在 window 上，用裸标识符取）
  for (let i = 0; i < 60; i++) {
    const ready = await win.evaluate(() => !!(typeof libData !== 'undefined' && Array.isArray(libData.groups) && libData.groups.length));
    if (ready) break;
    await win.waitForTimeout(1500);
  }
  const st0 = await win.evaluate(() => ({
    groups: (typeof libData !== 'undefined' && libData.groups) ? libData.groups.length : -1,
    sampleKeys: (typeof libData !== 'undefined' && libData.groups) ? libData.groups.slice(0, 8).map(g => g.key) : [],
    cards: document.querySelectorAll('#libList .subgcard, #libList .lcard').length
  }));
  console.log('INIT:', JSON.stringify(st0, null, 1));
  if (st0.groups > 0) {
    await win.evaluate(() => { switchPage('lib'); enterLibGroup(libData.groups[0].key); });
    await win.waitForTimeout(800);
    const st1 = await win.evaluate(() => {
      const btn = document.querySelector('#libList .lcard-info');
      return { infoBtns: document.querySelectorAll('#libList .lcard-info').length,
        onclickAttr: btn ? btn.getAttribute('onclick') : null };
    });
    console.log('GROUP-IN:', JSON.stringify(st1, null, 1));
    if (st1.infoBtns) {
      const btn = win.locator('#libList .lcard-info').first();
      await btn.hover(); await win.waitForTimeout(250); await btn.click();
      await win.waitForTimeout(900);
      const st2 = await win.evaluate(() => ({
        drawerOpen: document.getElementById('libDrawer').classList.contains('open'),
        drawerBodyLen: (document.getElementById('libDrawerBody').innerHTML || '').length
      }));
      console.log('AFTER-CLICK:', JSON.stringify(st2));
      await win.screenshot({ path: path.join(__dirname, '../评审材料/vf-probe-info.png') });
    }
  }
  console.log('ERRORS:', errs.length ? errs.join('\n') : '(none)');
  await app.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
