// 期1换肤无头验证：5 模块切换 + CSS 变量 + SVG 图标 + 顶栏标题 + 注释坑位 + 截图
// 用法：NODE_PATH=<playwright node_modules> node _tools/verify_skin.js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const HTML = path.resolve(__dirname, '../app/index.html');
const SHOT_DIR = path.resolve(__dirname, 'skin-shots');
const url = 'file://' + HTML.replace(/\\/g, '/');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '::', e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// mock IPC：所有列表接口返数组/对象，避免渲染函数炸
const MOCK = `
window.__ipcLog = [];
const arr = () => Promise.resolve([]);
const obj = () => Promise.resolve({});
const snapshot = () => Promise.resolve([]);
window.keepsake = {
  snapshot, tasks: arr, queue: arr, done: arr,
  libraryList: arr, libraryScan: () => Promise.resolve({ groups: [], totalFiles: 0, totalSize: 0 }), subs: arr, subsList: arr,
  wereadState: obj, cookieInfo: () => Promise.resolve({}), pixivState: obj, asr: obj, engines: arr,
  asrModels: () => Promise.resolve({ models: [], current: '' }), asrDeleteModel: obj, asrSetModel: obj,
  asrDownload: obj, asrCancelDownload: obj, asrSetMirror: obj,
  loginState: () => Promise.resolve({}),
  strategy: obj, learned: arr, rules: obj,
  settingsGet: () => Promise.resolve({ ui: { theme:'light', accent:'brand', layout:'grid' }, autoCbz:false, autoSubtitle:false }),
  settingsSetUi: obj, settingsSetCbz: obj, settingsSetAutoSubtitle: obj,
  checkUpdate: obj, doUpdate: obj, refreshRules: obj,
  on: () => {}, once: () => {}, removeListener: () => {},
  openXhsWin: () => {}, openLogin: () => {}, openChannelsWin: () => {},
  textSearch: arr, reindex: obj, summarize: obj, transcribe: obj,
  onAsrProgress: () => {}, onAsrPhase: () => {}, onAsrDone: () => {}, onAsrError: () => {},
  onAsrDownloadProgress: () => {}, onEngineProgress: () => {}, onToast: () => {},
  onClipboardUrl: () => {}, onSubs: () => {}, onLibJob: () => {}, onLibraryRefresh: () => {},
  onQueue: () => {}, onInterrupted: () => {},
  onTask: () => {}, onDone: () => {}, onRule: () => {}, onLog: () => {}, onEngine: () => {}, onXhs: () => {}
};
// 兜底：任何未显式 mock 的方法都返回通用 Promise，避免初始化链中断（只影响无头验证）
window.keepsake = new Proxy(window.keepsake, {
  get(t, k) { if (k in t) return t[k]; return () => Promise.resolve({}); }
});
// 屏蔽 onboard 引导蒙层
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('onboardMask')?.remove();
  try { localStorage.setItem('keepsake-onboarded','1'); } catch(e){}
});
`;

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(MOCK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(700);

  console.log('\n=== A. CSS 变量（暖纸/琥珀）===');
  const css = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      bg: cs.getPropertyValue('--bg').trim(),
      panel: cs.getPropertyValue('--panel').trim(),
      txt: cs.getPropertyValue('--txt').trim(),
      acc: cs.getPropertyValue('--acc').trim(),
    };
  });
  ok('暖纸底 --bg=#F0ECE5', () => assert(css.bg.toUpperCase() === '#F0ECE5', css.bg));
  ok('暖白面板 --panel=#FBF9F5', () => assert(css.panel.toUpperCase() === '#FBF9F5', css.panel));
  ok('墨色正文 --txt=#29241E', () => assert(css.txt.toUpperCase() === '#29241E', css.txt));
  ok('琥珀强调 --acc=#B77A16', () => assert(css.acc.toUpperCase() === '#B77A16', css.acc));

  console.log('\n=== B. 侧栏 SVG 图标 ===');
  const side = await page.evaluate(() => {
    const navs = [...document.querySelectorAll('.sidebar .nav')];
    return {
      navCount: navs.length,
      svgCount: navs.filter(n => n.querySelector('svg')).length,
      grpCount: document.querySelectorAll('.nav-grp').length,
      footSvg: document.querySelectorAll('.side-foot svg').length,
      brandSub: !!document.querySelector('.logo-sub'),
      width: getComputedStyle(document.querySelector('.sidebar')).width
    };
  });
  ok('侧栏导航项 6 个', () => assert(side.navCount === 6, 'nav=' + side.navCount));
  ok('每个导航项都有 SVG 图标', () => assert(side.svgCount === side.navCount, side.svgCount + '/' + side.navCount));
  ok('分组标签 2 个（工作台/系统）', () => assert(side.grpCount === 2, 'grp=' + side.grpCount));
  ok('底部状态区有 SVG', () => assert(side.footSvg >= 3, 'footSvg=' + side.footSvg));
  ok('品牌副标题存在', () => assert(side.brandSub, 'no logo-sub'));
  ok('侧栏宽 224px', () => assert(side.width === '224px', side.width));

  console.log('\n=== C. 顶栏标题条（CSS 伪元素）===');
  for (const [p, title] of [['tasks','"任务队列"'],['rss','"订阅归档"'],['lib','"媒体库"'],['strategy','"风控策略"'],['settings','"设置"']]) {
    const t = await page.evaluate((pg) => getComputedStyle(document.getElementById('page-'+pg), '::before').content, p);
    ok(`#page-${p} 标题=${title}`, () => assert(t === title, t));
  }

  console.log('\n=== D. 5 模块切换 + 截图 ===');
  for (const p of ['tasks','rss','lib','strategy','settings']) {
    await page.evaluate(pg => window.switchPage(pg), p);
    await page.waitForTimeout(250);
    const on = await page.evaluate(pg => document.getElementById('page-'+pg).classList.contains('on'), p);
    ok(`切换到 ${p} 页`, () => assert(on, 'not on'));
  }
  // 回到任务页截主图
  await page.evaluate(() => window.switchPage('tasks'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOT_DIR, '01-tasks-light.png'), fullPage: false });
  console.log('  截图: 01-tasks-light.png');

  console.log('\n=== E. 主题/强调色切换不崩 ===');
  for (const theme of ['dark','light']) {
    await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(80);
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    ok(`${theme} 主题 --bg 有值`, () => assert(bg.length > 0, bg));
  }
  await page.evaluate(() => { document.documentElement.setAttribute('data-theme','dark'); });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(SHOT_DIR, '02-tasks-dark.png'), fullPage: false });
  console.log('  截图: 02-tasks-dark.png');
  for (const a of ['brand','purple','green']) {
    await page.evaluate(x => document.documentElement.setAttribute('data-accent', x), a);
    await page.waitForTimeout(80);
    const acc = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--acc').trim());
    ok(`强调色 ${a} 有值`, () => assert(acc.length > 0, acc));
  }

  console.log('\n=== F. 注释坑位与在役入口 ===');
  const html = fs.readFileSync(HTML, 'utf-8');
  ok('视频号注释坑位仍在', () => assert(html.includes('openChannelsWin()') && html.includes('视频号入口暂时下架'), 'comment gone'));
  ok('小红书在役入口仍在', () => assert(html.includes('onclick="openXhsWin()"'), 'xhs gone'));

  console.log('\n=== G. 运行时无 JS 报错 ===');
  ok('pageerror 为空', () => assert(errors.length === 0, errors.slice(0,3).join(' | ')));

  await browser.close();
  console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
