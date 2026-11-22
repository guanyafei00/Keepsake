// 验证「界面风格只保留默认」：设置页无 X/Y 选项 + 老用户 stream/dash 自动回退 + 渲染无报错
// 用法：NODE_PATH=<playwright node_modules> node _tools/verify_single_skin.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const HTML = path.resolve(__dirname, '../app/index.html');
const url = 'file://' + HTML.replace(/\\/g, '/');
let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '::', e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

function mockWithLayout(layout) {
  return `
const arr = () => Promise.resolve([]);
const obj = () => Promise.resolve({});
window.keepsake = {
  snapshot: () => Promise.resolve([]), tasks: arr, queue: arr, done: arr,
  subsList: () => Promise.resolve([]), subs: arr,
  libraryScan: () => Promise.resolve({groups:[],totalFiles:0,totalSize:0,scannedAt:Date.now()}), libraryList: arr,
  wereadState: obj, cookieInfo: () => Promise.resolve({}), pixivState: obj, asr: obj, engines: arr,
  strategySnapshot: () => Promise.resolve({defaults:[],learned:{}}), strategyVersion: () => Promise.resolve('t'),
  asrModels: () => Promise.resolve({models:[],current:''}), asrDeleteModel: obj, asrSetModel: obj,
  asrDownload: obj, asrCancelDownload: obj, asrSetMirror: obj,
  loginState: () => Promise.resolve({}),
  settingsGet: () => Promise.resolve({ ui:{theme:'light',accent:'brand',layout:'${layout}'}, autoCbz:false, autoSubtitle:false }),
  settingsSetUi: obj, settingsSetCbz: obj, settingsSetAutoSubtitle: obj,
  checkUpdate: obj, doUpdate: obj, refreshRules: obj,
  on: () => {}, once: () => {}, removeListener: () => {},
  openXhsWin: () => {}, openLogin: () => {}, openChannelsWin: () => {},
  textSearch: arr, reindex: obj, summarize: obj, transcribe: obj,
  onAsrProgress: () => {}, onAsrPhase: () => {}, onAsrDone: () => {}, onAsrError: () => {},
  onAsrDownloadProgress: () => {}, onEngineProgress: () => {}, onToast: () => {},
  onClipboardUrl: () => {}, onSubs: () => {}, onLibJob: () => {}, onLibraryRefresh: () => {},
  onQueue: () => {}, onInterrupted: () => {}, onTask: () => {}, onDone: () => {},
  onRule: () => {}, onLog: () => {}, onEngine: () => {}, onXhs: () => {}
};
window.keepsake = new Proxy(window.keepsake, { get(t,k){ return k in t ? t[k] : () => Promise.resolve({}); } });
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('onboardMask')?.remove();
  try { localStorage.setItem('keepsake-onboarded','1'); } catch(e){}
});
`;
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // --- 场景1：设置页 DOM 只有默认选项 ---
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(mockWithLayout('grid'));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);

    console.log('\n=== A. 设置页外观只剩主题/强调色 ===');
    const a = await page.evaluate(() => ({
      layoutSel: !!document.getElementById('uiLayoutSel'),
      themeSel: !!document.getElementById('uiThemeSel'),
      accentSel: !!document.getElementById('uiAccentSel'),
      prev: !!document.getElementById('uiPrev'),
      state: (document.getElementById('uiStateLine') || {}).textContent || ''
    }));
    ok('界面风格下拉框已删除', () => assert(a.layoutSel === false, 'uiLayoutSel 仍存在'));
    ok('主题/强调色下拉框保留', () => assert(a.themeSel && a.accentSel, JSON.stringify(a)));
    ok('预览三选一容器已删除', () => assert(a.prev === false, 'uiPrev 仍存在'));
    ok('状态行不再提界面风格', () => assert(/当前：/.test(a.state) && !/界面风格/.test(a.state) && !/方案/.test(a.state), a.state));

    console.log('\n=== B. 渲染无报错 / 坑位 ===');
    ok('pageerror 为空', () => assert(errors.length === 0, errors.slice(0,3).join(' | ')));
    const html = fs.readFileSync(HTML, 'utf-8');
    ok('视频号/公众号坑位保留', () => assert(html.includes('视频号入口暂时下架') && html.includes('setCardWeread')));
    ok('仅文件名角标/CBZ/AI 保留', () => assert(html.includes('仅文件名') && html.includes("makeCbz('") && html.includes("aiPanel('")));
    ok('data-skin 恒为 grid', () => {
      // 已在 applyUiAppearance 锁死，这里再确认源码无动态写 skin 的分支
      assert(/dataset\.skin\s*=\s*'grid'/.test(html), '未锁定 grid');
    });
    await ctx.close();
  }

  // --- 场景2/3：老用户存了 stream/dash，启动应回退到 grid ---
  for (const bad of ['stream', 'dash']) {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    await ctx.addInitScript(mockWithLayout(bad));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => ({
      skin: document.documentElement.dataset.skin,
      layout: (typeof currentUi !== 'undefined' && currentUi.layout) || null,
      sel: !!document.getElementById('uiLayoutSel')
    }));
    ok(`老用户 layout=${bad} 启动回退 grid`, () => assert(r.skin === 'grid' && r.layout === 'grid' && r.sel === false, JSON.stringify(r)));
    ok(`layout=${bad} 回退时无报错`, () => assert(errors.length === 0, errors.slice(0,3).join(' | ')));
    await ctx.close();
  }

  await browser.close();
  console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
