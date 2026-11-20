// UI 期2 结构重做无头验证：真实顶栏 + KPI 真值 + 表格化 + 5 页切换 + 坑位
// 用法：NODE_PATH=<playwright node_modules> node _tools/verify_skin_p2.js
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

// 带真实数据的 mock：任务 4 条（1下载/1排队/1完成/1失败）、订阅 3 条、媒体库组 2 个
const SNAP = [
  { id:'t1', status:'downloading', progress:45, title:'视频A', engine:'yt-dlp' },
  { id:'t2', status:'queued', title:'视频B', engine:'yt-dlp' },
  { id:'t3', status:'done', title:'图文C', engine:'gallery-dl', filePath:'D:\\a\\c.png' },
  { id:'t4', status:'error', title:'视频D', error:'412', engine:'yt-dlp' }
];
const SUBS = [
  { id:'s1', name:'UP主甲', knownCount:50, paused:false },
  { id:'s2', name:'UP主乙', knownCount:30, paused:false, lastError:'429', lastFailAt:200, lastCheck:100 },
  { id:'s3', name:'UP主丙', knownCount:20, paused:true }
];
const LIB = { groups:[
  { key:'g1', uploader:'UP主甲', site:'bilibili', fileCount:3, videoCount:2, imageCount:1,
    files:[{name:'a.mp4',kind:'video',hasText:true},{name:'b.jpg',kind:'image',hasText:false}] },
  { key:'g2', uploader:'UP主乙', site:'youtube', fileCount:2, videoCount:1, imageCount:1,
    files:[{name:'c.mp4',kind:'video',hasText:false}] }
], totalFiles:5, totalSize:'12.5 MB' };

const MOCK = `
window.__snap = ${JSON.stringify(SNAP)};
window.__subs = ${JSON.stringify(SUBS)};
window.__lib = ${JSON.stringify(LIB)};
const arr = () => Promise.resolve([]);
const obj = () => Promise.resolve({});
window.keepsake = {
  snapshot: () => Promise.resolve(window.__snap), tasks: arr, queue: arr, done: arr,
  subsList: () => Promise.resolve(window.__subs), subs: arr,
  libraryScan: () => Promise.resolve(window.__lib), libraryList: arr,
  wereadState: obj, cookieInfo: () => Promise.resolve({}), pixivState: obj, asr: obj, engines: arr,
  strategySnapshot: () => Promise.resolve({ defaults:[], learned:{} }), strategyVersion: () => Promise.resolve('test'),
  asrModels: () => Promise.resolve({ models: [], current: '' }), asrDeleteModel: obj, asrSetModel: obj,
  asrDownload: obj, asrCancelDownload: obj, asrSetMirror: obj,
  loginState: () => Promise.resolve({}),
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
window.keepsake = new Proxy(window.keepsake, { get(t,k){ return k in t ? t[k] : () => Promise.resolve({}); } });
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
  await page.waitForTimeout(900);

  console.log('\n=== A. 通用结构：顶栏 + KPI 容器 ===');
  const base = await page.evaluate(() => ({
    top: !!document.getElementById('p2Top'),
    kpi: !!document.getElementById('kpiHost'),
    kv2: document.documentElement.classList.contains('kv2-on'),
    topText: (document.getElementById('p2Top') || {}).textContent || '',
    beforeHidden: getComputedStyle(document.querySelector('#page-tasks'), '::before').display
  }));
  ok('真实顶栏 #p2Top 已注入', () => assert(base.top, 'no topbar'));
  ok('KPI 容器 #kpiHost 已注入', () => assert(base.kpi, 'no kpi host'));
  ok('旧伪元素标题已视觉隐藏(kv2-on)', () => assert(base.kv2 && base.beforeHidden === 'none', base.beforeHidden));
  ok('顶栏含标题/副标题/动作按钮', () => assert(base.topText.includes('任务队列') && base.topText.includes('加入队列'), base.topText));

  console.log('\n=== B. 任务页 4 KPI 真值 ===');
  const tk = await page.evaluate(() => [...document.querySelectorAll('#kpiHost .kc')].map(c => ({
    k: c.querySelector('.k').textContent.trim(), v: c.querySelector('.v').textContent.trim()
  })));
  ok('任务页 4 张 KPI', () => assert(tk.length === 4, 'kpi=' + tk.length));
  ok('下载中=1（真值）', () => assert(tk[0] && /^1/.test(tk[0].v), tk[0] && tk[0].v));
  ok('排队等待=1（真值）', () => assert(tk[1] && /^1/.test(tk[1].v), tk[1] && tk[1].v));
  ok('已完成=1（真值）', () => assert(tk[2] && /^1/.test(tk[2].v), tk[2] && tk[2].v));
  ok('失败待重试=1（真值）', () => assert(tk[3] && /^1/.test(tk[3].v), tk[3] && tk[3].v));
  ok('无硬编码 mock 数字(138/360.8)', () => {
    const all = JSON.stringify(tk); assert(!all.includes('138') && !all.includes('360.8'), 'mock leak');
  });

  console.log('\n=== C. 表格化 + toolbar ===');
  const tbl = await page.evaluate(() => ({
    qTbl: document.getElementById('queue').classList.contains('tblify'),
    dTbl: document.getElementById('doneList').classList.contains('tblify'),
    bar: !!document.getElementById('p2TaskBar'),
    heads: document.querySelectorAll('#page-tasks .tbl-head').length,
    chips: document.querySelectorAll('#p2TaskBar .chip').length
  }));
  ok('任务队列容器表格化', () => assert(tbl.qTbl && tbl.dTbl, 'no tblify'));
  ok('toolbar 已注入', () => assert(tbl.bar, 'no toolbar'));
  ok('两个表头行', () => assert(tbl.heads === 2, 'heads=' + tbl.heads));
  ok('3 个筛选 chip', () => assert(tbl.chips === 3, 'chips=' + tbl.chips));

  console.log('\n=== D. 筛选交互（切视图不崩）===');
  for (const v of ['active','done','all']) {
    const r = await page.evaluate(mode => { p2TaskView(mode, document.querySelector('#p2TaskBar .chip[data-v="'+mode+'"]')); return {
      q: document.getElementById('queue').style.display, d: document.getElementById('doneList').style.display
    }; }, v);
    ok(`视图 ${v} 切换`, () => {
      if (v === 'active') assert(r.q === '' && r.d === 'none', JSON.stringify(r));
      else if (v === 'done') assert(r.q === 'none' && r.d === '', JSON.stringify(r));
      else assert(r.q === '' && r.d === '', JSON.stringify(r));
    });
  }

  console.log('\n=== E. 5 页切换 + KPI 各页真值 ===');
  for (const p of ['rss','lib','strategy','settings','tasks']) {
    await page.evaluate(pg => window.switchPage(pg), p);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => ({
      on: (document.querySelector('.page.on') || {}).id,
      top: (document.getElementById('p2Top') || {}).textContent || '',
      kpis: document.querySelectorAll('#kpiHost .kc').length
    }));
    ok(`切到 ${p} 页且顶栏更新`, () => assert(r.on === 'page-' + p && r.top.length > 0, JSON.stringify(r)));
    if (p === 'rss') ok('订阅页 4 KPI', () => assert(r.kpis === 4, 'kpis=' + r.kpis));
    if (p === 'lib') ok('媒体库 4 KPI', () => assert(r.kpis === 4, 'kpis=' + r.kpis));
    if (p === 'strategy' || p === 'settings') ok(`${p} 无 KPI(原型也无)`, () => assert(r.kpis === 0, 'kpis=' + r.kpis));
  }

  console.log('\n=== F. 坑位与功能按钮保留 ===');
  const html = fs.readFileSync(HTML, 'utf-8');
  ok('视频号注释坑位仍在', () => assert(html.includes('openChannelsWin()') && html.includes('视频号入口暂时下架'), 'gone'));
  ok('公众号状态卡坑位仍在', () => assert(html.includes('setCardWeread'), 'gone'));
  ok('仅文件名角标仍在', () => assert(html.includes('仅文件名'), 'gone'));
  ok('CBZ/AI 按钮 onclick 仍在', () => assert(html.includes("makeCbz('") && html.includes("aiPanel('"), 'gone'));

  console.log('\n=== G. 5 页截图 ===');
  for (const p of ['tasks','rss','lib','strategy','settings']) {
    await page.evaluate(pg => window.switchPage(pg), p);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(SHOT_DIR, 'p2-' + p + '.png'), fullPage: false });
  }
  console.log('  截图: p2-{tasks,rss,lib,strategy,settings}.png');

  console.log('\n=== H. 运行时无 JS 报错 ===');
  ok('pageerror 为空', () => assert(errors.length === 0, errors.slice(0,3).join(' | ')));

  await browser.close();
  console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
