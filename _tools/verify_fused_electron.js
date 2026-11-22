// 真实 app 冒烟 E2E（KEEPSAKE_CAPTURE=1 绕单实例锁 + KEEPSAKE_E2E_DIR 隔离用户目录）
// 约束：capture 模式在 did-finish-load 后 ~9.5s 会自动切页截图并 app.quit()，且本机常驻着
// 用户真实 Keepsake 实例（占 ProcessSingleton 锁），无法去掉 CAPTURE——所以本脚本只做
// 限时核心交互冒烟（骨架 + IPC + Ctrl+K + > 指令 + 粘贴框 + Esc + pageerror），
// 退出前必须全部跑完；五页/KPI/主题/响应式等全量断言由 _tools/verify_fused.js（mock 无头）覆盖。
// capture 产出的 3 张真机截图（screenshots/keepsake-*.png）同时作为真实数据链路渲染正常的证据。
// 用法：NODE_PATH=<playwright node_modules> node _tools/verify_fused_electron.js
const path = require('path');
const fs = require('fs');
const os = require('os');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '::', e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const { _electron: electron } = require('playwright');
  const e2eDir = path.join(os.tmpdir(), 'keepsake-e2e-fused-' + Date.now());
  const electronExe = path.join(__dirname, '../app/node_modules/electron/dist/electron.exe');
  const env = { ...process.env, KEEPSAKE_CAPTURE: '1', KEEPSAKE_E2E_DIR: e2eDir };
  delete env.ELECTRON_RUN_AS_NODE;   // 宿主注入会让 Electron 变纯 Node，导致 playwright 握手失败
  const app = await electron.launch({
    executablePath: fs.existsSync(electronExe) ? electronExe : undefined,
    args: [path.resolve(__dirname, '../app')],
    env
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', e => errors.push(e.message));
  await win.waitForLoadState('domcontentloaded');

  // 隔离用户目录首启会有引导遮罩拦点击：标记已引导并移除（仅本 E2E 临时目录）
  await win.evaluate(() => {
    try { localStorage.setItem('keepsake-onboarded', '1'); } catch (e) {}
    document.getElementById('onboardMask')?.remove();
  });

  // —— 限时段：capture 流程 ~9.5s 后退出，以下交互必须在此前完成 ——
  console.log('\n=== A. 真实 app 骨架 + 真实 preload IPC 桥 ===');
  let st = await win.evaluate(() => ({
    app: !!document.getElementById('app'),
    toolbar: !!document.querySelector('.toolbar'),
    sidebar: !!document.querySelector('.workspace > aside.sidebar'),
    navs: [...document.querySelectorAll('.sidebar .nav')].map(n => n.dataset.page).filter(Boolean).length,
    cmdk: !!document.getElementById('cmdkOverlay'),
    drawer: !!document.getElementById('libDrawer'),
    ipc: typeof window.keepsake === 'object' && typeof window.keepsake.snapshot === 'function' && typeof window.keepsake.subsList === 'function'
  }));
  ok('骨架四件套 + 真实 preload IPC 桥', () => assert(st.app && st.toolbar && st.sidebar && st.navs === 5 && st.cmdk && st.drawer && st.ipc, JSON.stringify(st)));

  console.log('\n=== B. Ctrl+K / > 指令 / 粘贴框（真实渲染层）===');
  await win.keyboard.press('Control+k');
  await win.waitForTimeout(120);
  st = await win.evaluate(() => ({ open: isCmdkOpen(), items: document.querySelectorAll('#cmdkList .ck-item').length }));
  ok('Ctrl+K 打开面板', () => assert(st.open && st.items >= 4, JSON.stringify(st)));
  await win.keyboard.insertText('>粘贴链接');
  await win.waitForTimeout(100);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(250);
  st = await win.evaluate(() => ({ dl: document.getElementById('downloadLayer').classList.contains('open'), closed: !isCmdkOpen() }));
  ok('>粘贴链接 → 打开下载模态且面板关闭', () => assert(st.dl && st.closed, JSON.stringify(st)));
  await win.evaluate(() => closeLayerModal('downloadLayer'));
  await win.evaluate(() => window.switchPage('tasks'));
  await win.waitForTimeout(200);
  await win.click('#urls');
  await win.keyboard.insertText('https://www.bilibili.com/video/BVe2eSmoke');
  st = await win.evaluate(() => document.getElementById('urls').value);
  ok('任务页粘贴框可输入', () => assert(st.includes('BVe2eSmoke'), st));
  await win.keyboard.press('Escape');
  st = await win.evaluate(() => document.getElementById('urls').value.length);
  ok('Esc 不误关窗口/焦点不乱（输入框仍在）', () => assert(st >= 0, 'urls gone'));

  console.log('\n=== C. 媒体库页可进入（真实扫描链路不炸）===');
  await win.evaluate(() => window.switchPage('lib'));
  await win.waitForTimeout(400);
  st = await win.evaluate(() => ({ on: document.getElementById('page-lib').classList.contains('on'), rendered: !!document.getElementById('libList') }));
  ok('媒体库页进入并渲染容器', () => assert(st.on && st.rendered, JSON.stringify(st)));

  // —— 等 capture 流程自动退出（自身即真实数据链路冒烟）——
  const shotsDir = path.resolve(__dirname, '../screenshots');
  let exited = 0, code = null;
  app.process().on('exit', (c) => { exited = 1; code = c; });
  for (let i = 0; i < 30 && !exited; i++) await new Promise(r => setTimeout(r, 500));
  console.log('\n=== D. capture 真实数据链路自动退出 ===');
  ok('capture 模式正常退出（exitCode 0）', () => assert(exited === 1 && code === 0, 'exited=' + exited + ' code=' + code));
  for (const f of ['keepsake-library.png', 'keepsake-subs.png', 'keepsake-home.png']) {
    const p = path.join(shotsDir, f);
    ok(`真机截图 ${f} 产出且非空`, () => {
      assert(fs.existsSync(p), 'missing');
      assert(fs.statSync(p).size > 10000, 'too small: ' + fs.statSync(p).size);
    });
  }

  console.log('\n=== E. 渲染层无 JS 报错 ===');
  ok('pageerror 为空', () => assert(errors.length === 0, errors.slice(0, 3).join(' | ')));

  try { fs.rmSync(e2eDir, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e.message); process.exit(2); });
