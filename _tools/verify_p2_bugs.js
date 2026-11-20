// 期2 自查回归：钉死 4 个真 bug + mock 掩盖问题
// 用法：NODE_PATH=<playwright node_modules> node _tools/verify_p2_bugs.js
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

// 真机形态 mock：totalSize 是字节数（不是字符串），挂钩记录函数有没有真被调用
const MOCK = `
window.__called = [];
const arr = () => Promise.resolve([]);
const obj = () => Promise.resolve({});
window.p2FocusUrls = function(){ window.__called.push('p2FocusUrls'); };
window.p2FocusSub = function(){ window.__called.push('p2FocusSub'); };
window.loadLibrary = function(f){ window.__called.push('loadLibrary:' + f); };
window.refreshRules = function(){ window.__called.push('refreshRules'); };
window.loadStrategySoon = function(){ window.__called.push('loadStrategySoon'); };
window.keepsake = {
  snapshot: () => Promise.resolve([]), tasks: arr, queue: arr, done: arr,
  subsList: () => Promise.resolve([]), subs: arr,
  libraryScan: () => Promise.resolve({ groups:[], totalFiles:12, totalSize:13107200, scannedAt:Date.now() }),
  libraryList: arr, wereadState: obj, cookieInfo: () => Promise.resolve({}), pixivState: obj, asr: obj, engines: arr,
  strategySnapshot: () => Promise.resolve({ defaults:[], learned:{} }), strategyVersion: () => Promise.resolve('t'),
  asrModels: () => Promise.resolve({ models:[], current:'' }), asrDeleteModel: obj, asrSetModel: obj,
  asrDownload: obj, asrCancelDownload: obj, asrSetMirror: obj,
  loginState: () => Promise.resolve({}), settingsGet: () => Promise.resolve({ui:{theme:'light',accent:'brand',layout:'grid'},autoCbz:false,autoSubtitle:false}),
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

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(MOCK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);

  console.log('\n=== A. 顶栏按钮 onclick 可执行（bug1/3）===');
  // 注意：页面内联 <script> 的 function 声明会覆盖 addInitScript 注入的同名 spy，
  // 所以不能靠 spy 计数；改为直接断言 onclick 属性文本 + 点击后焦点/无报错。
  for (const [pg, expect] of [
    ['tasks', 'p2FocusUrls()'], ['rss', 'p2FocusSub()'],
    ['lib', 'loadLibrary(true)'], ['strategy', 'loadStrategySoon()']
  ]) {
    await page.evaluate(p => window.switchPage(p), pg);
    await page.waitForTimeout(120);
    const onclick = await page.evaluate(() => {
      const btn = document.querySelector('#p2Top .tb-act');
      return btn ? btn.getAttribute('onclick') : '(none)';
    });
    ok(`${pg} 顶栏 onclick 含可执行调用`, () => assert(onclick.includes(expect), onclick));
  }
  // 点击真正生效：任务页按钮应把焦点移到 #urls
  await page.evaluate(() => window.switchPage('tasks'));
  await page.waitForTimeout(120);
  const focused = await page.evaluate(() => {
    const btn = document.querySelector('#p2Top .tb-act');
    if (btn) btn.click();
    const a = document.activeElement;
    return a ? a.id : '';
  });
  ok('点击「加入队列」焦点移到 #urls', () => assert(focused === 'urls', 'activeElement=' + focused));
  // 风控页按钮点击后无报错（refreshRules + loadStrategySoon 都真跑）
  const errBefore = errors.length;
  await page.evaluate(() => { window.switchPage('strategy'); });
  await page.waitForTimeout(120);
  await page.evaluate(() => { const b = document.querySelector('#p2Top .tb-act'); if (b) b.click(); });
  await page.waitForTimeout(200);
  ok('点击「刷新规则」无运行时报错', () => assert(errors.length === errBefore, errors.slice(errBefore).join(' | ')));

  console.log('\n=== B. 媒体库 totalSize 字节格式化（bug2）===');
  await page.evaluate(() => window.switchPage('lib'));
  await page.waitForTimeout(200);
  const libFoot = await page.evaluate(() => {
    const c = [...document.querySelectorAll('#kpiHost .kc')].find(x => x.textContent.includes('已收藏媒体'));
    return c ? c.querySelector('.foot').textContent : '';
  });
  ok('totalSize 字节数被格式化为 MB', () => {
    assert(/MB|GB|KB|B$/.test(libFoot) && !/[?]\d{6,}/.test(libFoot), libFoot);
    assert(libFoot.includes('12.5 MB'), '期望 12.5 MB，得到 ' + libFoot);
  });

  console.log('\n=== C. 顶栏 DOM 幂等（bug4）===');
  const idem = await page.evaluate(() => {
    const t = document.getElementById('p2Top');
    const before = t.firstChild;
    if (typeof renderP2 === 'function') { renderP2(); renderP2(); }
    return { same: t.firstChild === before, cached: !!t.dataset.p2html };
  });
  ok('重复 renderP2 不重建顶栏 DOM', () => assert(idem.same && idem.cached, JSON.stringify(idem)));

  console.log('\n=== D. 坑位与运行时 ===');
  const html = fs.readFileSync(HTML, 'utf-8');
  ok('视频号/公众号坑位保留', () => assert(html.includes('视频号入口暂时下架') && html.includes('setCardWeread')));
  ok('无 JS 运行时报错', () => assert(errors.length === 0, errors.slice(0,3).join(' | ')));

  await browser.close();
  console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
