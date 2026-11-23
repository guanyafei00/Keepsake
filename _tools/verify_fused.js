// 融合版骨架无头验证：⌘K 面板 + 详情抽屉 + 毛玻璃审计 + 主题三档/强调色三选 + 响应式 + 坑位
// 用法：NODE_PATH=<playwright node_modules> node _tools/verify_fused.js
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

const SNAP = [
  { id: 't1', status: 'downloading', progress: 45, title: '视频A', engine: 'yt-dlp' },
  { id: 't3', status: 'done', title: '图文C', engine: 'gallery-dl', filePath: 'D:\\a\\c.png' }
];
const SUBS = [
  { id: 's1', name: 'UP主甲', knownCount: 50, paused: false },
  { id: 's2', name: 'UP主乙', knownCount: 30, paused: true }
];
const LIB = {
  groups: [
    { key: 'g1', uploader: 'UP主甲', site: 'bilibili', fileCount: 3, videoCount: 2, imageCount: 1, sizeText: '8.4 MB', lastMtime: Date.now() - 60000,
      files: [{ name: 'a.mp4', kind: 'video', path: 'D:\\a\\a.mp4', sizeText: '5 MB', mtime: Date.now() - 60000 }, { name: 'b.jpg', kind: 'image', path: 'D:\\a\\b.jpg', sizeText: '2 MB', mtime: Date.now() - 90000, src: { via: 'single', url: 'https://e.com/b' } }] },
    { key: 'g2', uploader: 'UP主乙', site: 'youtube', fileCount: 2, videoCount: 1, imageCount: 0, sizeText: '4.1 MB', lastMtime: Date.now() - 120000,
      files: [{ name: 'c.mp4', kind: 'video', path: 'D:\\b\\c.mp4', sizeText: '4.1 MB', mtime: Date.now() - 120000 }, { name: 'c.srt', kind: 'other', path: 'D:\\b\\c.srt', sizeText: '12 KB', mtime: Date.now() - 110000 }] }
  ], totalFiles: 5, totalSize: 13107200
};

const MOCK = `
window.__snap = ${JSON.stringify(SNAP)};
window.__subs = ${JSON.stringify(SUBS)};
window.__lib = ${JSON.stringify(LIB)};
const arr = () => Promise.resolve([]);
const obj = () => Promise.resolve({});
window.keepsake = {
  snapshot: () => Promise.resolve(window.__snap), tasks: arr, queue: arr, done: arr,
  subsList: () => Promise.resolve(window.__subs), subs: arr,
  subsAdd: u => { const s = { id: 's-' + Date.now(), kind: 'rss', name: '新订阅', knownCount: 0 }; window.__subs = [...window.__subs, s]; return Promise.resolve({ ok: true, sub: s }); },
  subsUpdate: (id, patch) => { const s = window.__subs.find(x => x.id === id); if (s) Object.assign(s, patch); return Promise.resolve({ ok: true }); },
  openFileLocal: p => { window.__openFileCalls = [...(window.__openFileCalls || []), p]; return Promise.resolve({ ok: true }); },
  libraryScan: () => Promise.resolve(window.__lib), libraryList: arr,
  wereadState: obj, cookieInfo: () => Promise.resolve({}), pixivState: obj, asr: obj, engines: arr,
  strategySnapshot: () => Promise.resolve({ defaults: [], learned: {} }), strategyVersion: () => Promise.resolve('test'),
  asrModels: () => Promise.resolve({ models: [], current: '' }), asrDeleteModel: obj, asrSetModel: obj,
  asrDownload: obj, asrCancelDownload: obj, asrSetMirror: obj,
  loginState: () => Promise.resolve({}),
  settingsGet: () => Promise.resolve({ ui: { theme: 'light', accent: 'brand', layout: 'grid' }, autoCbz: false, autoSubtitle: false }),
  settingsSetUi: p => Promise.resolve({ ui: { theme: p.theme, accent: p.accent, layout: 'grid' } }),
  settingsSetCbz: obj, settingsSetAutoSubtitle: obj,
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
window.keepsake = new Proxy(window.keepsake, { get(t, k) { return k in t ? t[k] : () => Promise.resolve({}); } });
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('onboardMask')?.remove();
  try { localStorage.setItem('keepsake-onboarded', '1'); } catch (e) {}
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

  console.log('\n=== A. 融合版骨架结构 ===');
  const base = await page.evaluate(() => ({
    toolbar: !!document.querySelector('.toolbar'),
    brand: !!document.querySelector('.sidebar .logo .logo-name') && !document.querySelector('.tb-brand'),
    xhsSide: !!document.querySelector('.sidebar .nav#xhsWinBtn'),
    xhsToolbar: !!document.querySelector('.toolbar #xhsWinBtn'),
    sideOrder: (() => { const ids = [...document.querySelectorAll('.sidebar .nav')].map(n => n.id || n.dataset.nav || n.dataset.page); return ids.join(','); })(),
    search: !!document.querySelector('.toolbar .search input#libKw'),
    themeBtn: !!document.getElementById('themeToggleBtn'),
    sideToggle: !!document.getElementById('sidebarToggle'),
    sidebar: !!document.querySelector('.workspace > aside.sidebar'),
    navs: [...document.querySelectorAll('.sidebar .nav')].map(n => n.dataset.page).filter(Boolean),
    grp: document.querySelectorAll('.sidebar .nav-grp').length,
    foot: !!document.querySelector('.side-foot #loginBadge'),
    cmdk: !!document.getElementById('cmdkOverlay') && !!document.getElementById('cmdkInput'),
    drawer: !!document.getElementById('libDrawer'),
    pages: [...document.querySelectorAll('.main .page')].map(p => p.id),
    app: !!document.getElementById('app')
  }));
  ok('工具栏（真搜索框+主题按钮+侧栏开关；品牌标识只在侧栏，全局仅一个 Keepsake；无小红书按钮）', () => assert(base.toolbar && base.brand && base.search && base.themeBtn && base.sideToggle && !base.xhsToolbar, JSON.stringify(base)));
  ok('侧栏排序（2026-11-23 拍板）：任务队列→订阅主页→小红书→媒体库(所有归档/仅文件名/手动保存)→工具', () => assert(base.xhsSide && base.sideOrder === 'tasks,subs,xhsWinBtn,lib,only,manual,strategy,settings', JSON.stringify(base.sideOrder)));
  ok('毛玻璃侧栏在 workspace 内，四页导航 + 两组标签（媒体库/工具；前三项为无标签高频入口）', () => assert(base.sidebar && base.navs.length === 4 && base.grp === 2 && base.navs[0] === 'tasks' && !base.navs.includes('rss'), JSON.stringify({ navs: base.navs, grp: base.grp })));
  ok('侧栏底部状态区（登录/规则/引擎更新入口）', () => assert(base.foot, 'no side-foot'));
  ok('⌘K 面板容器在位', () => assert(base.cmdk, 'no cmdk'));
  ok('详情抽屉在位', () => assert(base.drawer, 'no drawer'));
  ok('五页 id 齐全', () => assert(['page-tasks', 'page-rss', 'page-lib', 'page-strategy', 'page-settings'].every(x => base.pages.includes(x)), JSON.stringify(base.pages)));
  const onPageLib = await page.evaluate(() => (document.querySelector('.page.on') || {}).id === 'page-lib');
  ok('第三阶段：默认页 = 媒体库（启动第一眼）', () => assert(onPageLib));
  const sideShell = await page.evaluate(() => !!document.querySelector('.sidebar .nav[data-nav="manual"]') && !!document.querySelector('.sidebar .nav[data-nav="subs"]') && !!document.getElementById('sideSubCnt') && !document.getElementById('sideSubList'));
  const smartGroup = await page.evaluate(() => [...document.querySelectorAll('.sidebar .nav')].some(n => n.textContent.includes('仅文件名')) && [...document.querySelectorAll('.sidebar .nav')].some(n => n.textContent.includes('手动保存')) && !!document.getElementById('l-fileAll') && !!document.getElementById('l-fileOnly') && !!document.getElementById('l-fileManual'));
  ok('第五批：「所有归档/仅文件名/手动保存」在媒体库组内', () => assert(smartGroup));
  const manageLink = await page.evaluate(() => !!document.querySelector('.side-manage') && ![...document.querySelectorAll('.sidebar .nav')].some(n => n.textContent.includes('订阅归档')));
  ok('第四批：订阅管理入口在订阅主页组标题，工具组不再重复订阅归档 nav', () => assert(manageLink));

  console.log('\n=== B. backdrop-filter 只在 4 个固定面 ===');
  const bf = await page.evaluate(() => {
    const faces = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const v = cs.backdropFilter || cs.webkitBackdropFilter || 'none';
      if (v && v !== 'none') faces.push(el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0]);
    }
    return faces;
  });
  ok('毛玻璃面 = 工具栏/侧栏/⌘K面板/抽屉（+卡角标，无意外面）', () => {
    const ALLOWED = ['toolbar', 'sidebar', 'cmdk', 'drawer', 'lpill'];
    const norm = faces => faces.map(f => {
      const s = f.replace(/^#/, '');
      if (s === 'libDrawer') return 'drawer';
      return s.split('.').pop();
    });
    const got = [...new Set(norm(bf))];
    assert(got.every(c => ALLOWED.includes(c)), 'unexpected=' + JSON.stringify(bf));
    ['toolbar', 'sidebar', 'cmdk', 'drawer'].forEach(c => assert(got.includes(c), 'missing ' + c));
  });

  console.log('\n=== C. 五页切换 + 渲染 ===');
  for (const p of ['tasks', 'rss', 'lib', 'strategy', 'settings']) {
    await page.evaluate(pg => window.switchPage(pg), p);
    await page.waitForTimeout(200);
    const on = await page.evaluate(pg => document.getElementById('page-' + pg).classList.contains('on'), p);
    ok(`切换到 ${p} 页`, () => assert(on, 'not on'));
  }
  // 任务页粘贴入口二合一（2026-11-23 拍板）：粘贴栏内嵌顶栏，全页仅一个「加入队列」
  await page.evaluate(() => window.switchPage('tasks'));
  await page.waitForTimeout(250);
  let tasksTop = await page.evaluate(() => ({
    topPaste: !!document.querySelector('#p2Top .tb-paste textarea#urls'),
    topBtn: !!document.querySelector('#p2Top .tb-paste #btnAdd'),
    joinCnt: [...document.querySelectorAll('#page-tasks button, #p2Top button')].filter(b => (b.textContent || '').includes('加入队列')).length,
    noTbAct: !document.querySelector('#p2Top .tb-act'),
    kpis: document.querySelectorAll('#kpiHost .kc').length
  }));
  ok('任务页粘贴入口二合一：粘贴栏内嵌顶栏 + 全页仅一个「加入队列」按钮 + 4 张 KPI', () => assert(tasksTop.topPaste && tasksTop.topBtn && tasksTop.joinCnt === 1 && tasksTop.noTbAct && tasksTop.kpis === 4, JSON.stringify(tasksTop)));
  const libRendered = await page.evaluate(() => ({
    cards: document.querySelectorAll('#libList .lcard').length,
    grpCards: document.querySelectorAll('#libList .subgcard').length,
    grpNames: [...document.querySelectorAll('#libList .sg-name .nm')].map(x => x.textContent),
    grpGrid: !!document.querySelector('#libList .subsgrid-wide'),
    backHidden: document.getElementById('libBackBtn').style.display === 'none',
    seg: document.querySelectorAll('#libKindSeg .libseg-item').length
  }));
  const libTitleTxt = await page.evaluate(() => (document.getElementById('libTitle') || {}).textContent);
  ok('所有归档组卡网格（订阅主页同构：2 张主页卡 + 大标题 + 返回钮隐藏 + 类型分段）', () => assert(libRendered.cards === 0 && libRendered.grpCards === 2 && libRendered.grpNames.join(',') === 'UP主甲,UP主乙' && libRendered.grpGrid && libRendered.backHidden && libRendered.seg === 3 && libTitleTxt === '所有归档', JSON.stringify({ ...libRendered, title: libTitleTxt })));
  // 点组卡进入组内视图：页头组名 + 返回钮出现 + 该组全部内容卡
  await page.evaluate(() => document.querySelector('#libList .subgcard').click());
  await page.waitForTimeout(260);
  const grpInner = await page.evaluate(() => ({
    title: (document.getElementById('libTitle') || {}).textContent,
    sub: (document.getElementById('libSub') || {}).textContent,
    backShown: document.getElementById('libBackBtn').style.display !== 'none',
    cards: document.querySelectorAll('#libList .lcard').length,
    infoBtns: document.querySelectorAll('#libList .lcard-info').length
  }));
  ok('组内视图：页头组名+统计副标题+返回钮出现+该组内容卡+每卡带 ℹ 信息挂点', () => assert(grpInner.title === 'UP主甲' && /B站/.test(grpInner.sub) && grpInner.backShown && grpInner.cards === 2 && grpInner.infoBtns === 2, JSON.stringify(grpInner)));
  // 点内容卡直接打开文件（不再弹信息层）；ℹ 仍开抽屉
  await page.evaluate(() => document.querySelector('#libList .lcard').click());
  await page.waitForTimeout(220);
  const opened = await page.evaluate(() => ({
    opened: (window.__openFileCalls || []).pop(),
    drawerOpen: document.getElementById('libDrawer').classList.contains('open')
  }));
  ok('点内容卡直接打开文件（a.mp4 → openFileLocal，不弹信息层）', () => assert(opened.opened && opened.opened.includes('a.mp4') && !opened.drawerOpen, JSON.stringify(opened)));
  await page.evaluate(() => { document.querySelector('#libList .lcard-info').click(); });
  await page.waitForTimeout(220);
  const drawerViaInfo = await page.evaluate(() => document.getElementById('libDrawer').classList.contains('open'));
  ok('ℹ 挂点主动开抽屉（信息层不消失，只是不再霸占点击）', () => assert(drawerViaInfo));
  await page.evaluate(() => closeLibDrawer());
  await page.evaluate(() => backLibGroup());
  await page.waitForTimeout(220);
  const backTop = await page.evaluate(() => ({ cards: document.querySelectorAll('#libList .subgcard').length, backHidden: document.getElementById('libBackBtn').style.display === 'none' }));
  ok('返回钮回组卡顶层', () => assert(backTop.cards === 2 && backTop.backHidden, JSON.stringify(backTop)));
  const rssRendered = await page.evaluate(() => ({
    cards: document.querySelectorAll('#subList .subcard').length,
    detail: document.querySelectorAll('#subList .sc-detail').length,
    actions: document.querySelectorAll('#subList .sc-actions .sx').length
  }));
  ok('订阅页卡片化渲染（2 卡 + 展开区 + 操作挂点）', () => assert(rssRendered.cards === 2 && rssRendered.detail === 2 && rssRendered.actions >= 14, JSON.stringify(rssRendered)));
  const sideSubs = await page.evaluate(() => ({ subsNav: !!document.querySelector('.sidebar .nav[data-nav="subs"]'), isSubItems: document.querySelectorAll('.sidebar .nav.is-sub').length, cnt: document.getElementById('sideSubCnt').textContent }));
  ok('侧栏订阅主页单入口（不展示详细主页名，只显示计数）', () => assert(sideSubs.subsNav && sideSubs.isSubItems === 0 && sideSubs.cnt === '2', JSON.stringify(sideSubs)));
  // 点击单入口 → 右侧出详细名称（订阅主页视图）
  await page.evaluate(() => libViewGo('subs'));
  await page.waitForTimeout(260);
  const subsView = await page.evaluate(() => ({
    title: (document.getElementById('libTitle') || {}).textContent,
    cards: document.querySelectorAll('#libList .subgcard').length,
    names: [...document.querySelectorAll('#libList .sg-name')].map(x => x.textContent),
    segHidden: (document.getElementById('libKindSeg') || {}).style.display === 'none'
  }));
  ok('订阅主页视图：右侧出详细名称（2 张订阅卡 + 页头标题 + 类型分段隐藏）', () => assert(subsView.title === '订阅主页' && subsView.cards === 2 && subsView.names.length === 2 && subsView.segHidden, JSON.stringify(subsView)));
  // 订阅卡操作行：检查/下载/暂停-恢复三件套（2026-11-23 拍板功能补齐）
  const subOps = await page.evaluate(() => ({
    ops: [...document.querySelectorAll('#libList .subgcard .sg-ops')].map(g => [...g.querySelectorAll('.op')].map(b => b.textContent.trim()).join('|')),
    cnt: document.querySelectorAll('#libList .subgcard .sg-ops .op').length
  }));
  ok('订阅卡操作行：每卡 ⟳检查/⤓下载/⏸暂停（UP主乙已暂停则 ▶恢复），操作不触发卡跳转', () => assert(subOps.ops.length === 2 && subOps.cnt === 6 && subOps.ops[1].includes('恢复') && subOps.ops[0].includes('暂停'), JSON.stringify(subOps)));
  // 点暂停按钮 → userPaused 生效（mock subsUpdate）
  await page.evaluate(() => document.querySelector('#libList .subgcard .sg-ops .op.ghost').click());
  await page.waitForTimeout(400);
  const pausedNow = await page.evaluate(() => window.__subs[0].userPaused === true);
  ok('订阅卡暂停操作：userPaused 生效', () => assert(pausedNow));
  await page.evaluate(() => { window.__subs[0].userPaused = false; });
  // 点第一张订阅卡 → 过滤到该订阅的归档（顶栏关键词=订阅名）
  await page.evaluate(() => document.querySelector('#libList .subgcard').click());
  await page.waitForTimeout(260);
  const subFiltered = await page.evaluate(() => ({ kw: document.getElementById('libKw').value, title: (document.getElementById('libTitle') || {}).textContent, cards: document.querySelectorAll('#libList .lcard').length }));
  ok('点订阅卡 → 过滤到 TA 的归档（顶栏关键词=订阅名，UP主甲 2 条内容卡）', () => assert(subFiltered.kw === 'UP主甲' && subFiltered.title === '搜索结果' && subFiltered.cards === 2, JSON.stringify(subFiltered)));
  // 修 bug 断言：带着残留关键词切视图必须自动清词（否则订阅主页只剩 1 个/手动视图空——用户 2026-11-23 反馈根因）
  await page.evaluate(() => libViewGo('subs'));
  await page.waitForTimeout(260);
  const kwCleared = await page.evaluate(() => ({ kw: document.getElementById('libKw').value, cards: document.querySelectorAll('#libList .subgcard').length }));
  ok('残留关键词自动清除：点过订阅卡后切订阅主页视图，订阅卡全量（非残留过滤到 1 个）', () => assert(kwCleared.kw === '' && kwCleared.cards === 2, JSON.stringify(kwCleared)));
  // 订阅主页视图自带粘贴订阅框（2026-11-23 拍板：加订阅不用绕订阅管理页）
  await page.evaluate(() => libViewGo('subs'));
  await page.waitForTimeout(260);
  let boxSt = await page.evaluate(() => ({ input: !!document.getElementById('subUrlBox'), btn: !!document.querySelector('#libList .paste-box .btn-dl') }));
  ok('订阅主页视图自带粘贴订阅框（输入框+添加订阅按钮在卡墙上方）', () => assert(boxSt.input && boxSt.btn, JSON.stringify(boxSt)));
  await page.evaluate(() => { document.getElementById('subUrlBox').value = 'https://example.com/new-creator'; document.querySelector('#libList .paste-box .btn-dl').click(); });
  await page.waitForTimeout(700);
  boxSt = await page.evaluate(() => ({ cnt: document.getElementById('sideSubCnt').textContent, cards: document.querySelectorAll('#libList .subgcard').length, cleared: document.getElementById('subUrlBox').value === '' }));
  ok('粘贴框提交：走完整 addSub 链路（新订阅卡入列 3 张 + 侧栏计数 3 + 输入框清空）', () => assert(boxSt.cnt === '3' && boxSt.cards === 3 && boxSt.cleared, JSON.stringify(boxSt)));
  // 回退 mock 状态，避免污染后续订阅相关测试
  await page.evaluate(() => { window.__subs = window.__subs.slice(0, 2); window.keepsake.subsList && loadSubs(); });
  await page.waitForTimeout(300);
  // 手动添加联动（第五批口径）：点侧栏手动保存 → libView=manual + 页头标题切换
  await page.evaluate(() => document.querySelector('.sidebar .nav[data-nav="manual"]').click());
  await page.waitForTimeout(260);
  const manualView = await page.evaluate(() => ({
    manual: document.querySelector('.sidebar .nav.on[data-nav="manual"]') ? 'manual' : 'page',
    title: (document.getElementById('libTitle') || {}).textContent,
    cards: document.querySelectorAll('#libList .lcard').length
  }));
  ok('侧栏「手动保存」→ 手动视图 + 入口高亮 + 页头标题「手动添加」', () => assert(manualView.manual === 'manual' && manualView.title === '手动添加' && manualView.cards >= 1, JSON.stringify(manualView)));
  // 仅文件名视图
  await page.evaluate(() => libViewGo('only'));
  await page.waitForTimeout(220);
  const onlyView = await page.evaluate(() => ({ title: (document.getElementById('libTitle') || {}).textContent, cards: document.querySelectorAll('#libList .lcard').length, pills: document.querySelectorAll('#libList .lpill.only').length }));
  ok('仅文件名视图：标题切换 + only 角标卡（mock g1 mp4+g2 附件）', () => assert(onlyView.title === '仅文件名' && onlyView.pills >= 1, JSON.stringify(onlyView)));
  await page.evaluate(() => libViewGo('all'));
  await page.waitForTimeout(220);
  const backAll = await page.evaluate(() => ({ title: (document.getElementById('libTitle') || {}).textContent, grpCards: document.querySelectorAll('#libList .subgcard').length }));
  ok('回所有归档：标题恢复 + 组卡网格（顶层形态）', () => assert(backAll.title === '所有归档' && backAll.grpCards === 2, JSON.stringify(backAll)));

  console.log('\n=== D. ⌘K 面板 ===');
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(120);
  let st = await page.evaluate(() => ({ open: isCmdkOpen(), focused: document.activeElement === document.getElementById('cmdkInput'), items: document.querySelectorAll('#cmdkList .ck-item').length }));
  ok('Ctrl+K 打开面板并聚焦输入框（快速操作列表）', () => assert(st.open && st.focused && st.items >= 4, JSON.stringify(st)));
  // > 指令模式
  await page.keyboard.insertText('>粘贴链接');
  await page.waitForTimeout(120);
  st = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#cmdkList .ck-item .ck-title')].map(x => x.textContent);
    return { rows, sel: document.querySelector('#cmdkList .ck-item.sel .ck-title')?.textContent };
  });
  ok('> 出动作列表且「粘贴链接下载」命中', () => assert(st.rows.some(r => r.includes('粘贴链接下载')), JSON.stringify(st.rows)));
  // Enter 触发（源码含 isComposing 防中文输入法误触发）
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  st = await page.evaluate(() => ({ open: isCmdkOpen(), page: (document.querySelector('.page.on') || {}).id, focus: document.activeElement === document.getElementById('urls') }));
  ok('Enter 执行：跳任务队列页并聚焦粘贴框且面板关闭', () => assert(!st.open && st.page === 'page-tasks' && st.focus, JSON.stringify(st)));
  const src = fs.readFileSync(HTML, 'utf-8');
  ok('Enter 带 !e.isComposing 检查（中文输入法防误触）', () => assert(src.includes("e.key === 'Enter' && !e.isComposing"), 'no isComposing guard'));
  // >切深色
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(100);
  await page.keyboard.insertText('>切深色');
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  st = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, cur: currentUi.theme, sel: document.getElementById('uiThemeSel').value }));
  ok('>切深色：data-theme=dark 且持久化走 settingsSetUi', () => assert(st.theme === 'dark' && st.cur === 'dark' && st.sel === 'dark', JSON.stringify(st)));
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(100);
  await page.keyboard.insertText('>切浅色');
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  st = await page.evaluate(() => document.documentElement.dataset.theme);
  ok('>切浅色回 light', () => assert(st === 'light', st));
  // >任务 直接切页
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(100);
  await page.keyboard.insertText('>任务');
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  st = await page.evaluate(() => (document.querySelector('.page.on') || {}).id);
  ok('>任务 直接切到任务页', () => assert(st === 'page-tasks', st));
  // 关键词搜索映射媒体库搜索函数
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(100);
  await page.keyboard.insertText('UP主甲');
  await page.waitForTimeout(120);
  st = await page.evaluate(() => ({ items: document.querySelectorAll('#cmdkList .ck-item').length, first: document.querySelector('#cmdkList .ck-item .ck-title')?.textContent }));
  ok('关键词命中媒体库分组 + 搜索直达项', () => assert(st.items >= 2 && st.first.includes('UP主甲'), JSON.stringify(st)));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  st = await page.evaluate(() => ({ page: (document.querySelector('.page.on') || {}).id, drawer: isLibDrawerOpen() }));
  ok('Enter 打开媒体库分组详情抽屉', () => assert(st.page === 'page-lib' && st.drawer, JSON.stringify(st)));
  // 选「在媒体库搜索…」直达项（映射到现有 setLibKw）
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(100);
  await page.keyboard.insertText('UP主乙');
  await page.waitForTimeout(120);
  await page.evaluate(() => { cmdkMove(cmdkResults.length - 1); });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  st = await page.evaluate(() => ({ kw: document.getElementById('libKw').value, cards: document.querySelectorAll('#libList .lcard').length }));
  ok('搜索直达项把关键词填入媒体库搜索框（setLibKw）', () => assert(st.kw === 'UP主乙', JSON.stringify(st)));
  // Esc 分层关闭（⌘K > 通用模态 > 抽屉；订阅/下载模态层已撤，入口收敛到各自页面）
  // 经典三层
  await page.evaluate(() => { openCmdk(); });
  await page.waitForTimeout(80);
  await page.evaluate(() => { openModal('测试模态', 'x'); openLibDrawer('g1'); });
  await page.waitForTimeout(150);
  st = await page.evaluate(() => ({ cmdk: isCmdkOpen(), modal: document.getElementById('modal').style.display, drawer: isLibDrawerOpen() }));
  ok('三层同时打开（⌘K > 模态 > 抽屉）', () => assert(st.cmdk && st.modal === 'flex' && st.drawer, JSON.stringify(st)));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  st = await page.evaluate(() => ({ cmdk: isCmdkOpen(), modal: document.getElementById('modal').style.display, drawer: isLibDrawerOpen() }));
  ok('Esc 第 1 层：只关 ⌘K', () => assert(!st.cmdk && st.modal === 'flex' && st.drawer, JSON.stringify(st)));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  st = await page.evaluate(() => ({ modal: document.getElementById('modal').style.display, drawer: isLibDrawerOpen() }));
  ok('Esc 第 2 层：关模态，抽屉仍在', () => assert(st.modal === 'none' && st.drawer, JSON.stringify(st)));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  st = await page.evaluate(() => isLibDrawerOpen());
  ok('Esc 第 3 层：关抽屉', () => assert(!st, 'drawer still open'));

  console.log('\n=== E. 媒体库抽屉 / CBZ / AI 挂点 ===');
  await page.evaluate(() => { document.getElementById('libKw').value = ''; setLibKw(''); window.switchPage('lib'); });
  await page.waitForTimeout(300);
  // 顶层是组卡网格（点卡进入组内），抽屉入口 = 组内内容卡右上角 ℹ
  await page.evaluate(() => { enterLibGroup('g1'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.querySelector('#libList .lcard-info').click(); });
  await page.waitForTimeout(200);
  st = await page.evaluate(() => ({
    open: isLibDrawerOpen(),
    title: document.querySelector('#libDrawerBody .d-title')?.textContent,
    rows: document.querySelectorAll('#libDrawerBody .d-row').length,
    files: document.querySelectorAll('#libDrawerBody .d-file').length
  }));
  ok('点 ⓘ 打开详情抽屉（标题/行/文件列表/文件操作挂点）', () => assert(st.open && st.title === 'UP主甲' && st.rows === 4 && st.files === 2, JSON.stringify(st)));
  const dOps = await page.evaluate(() => document.querySelector('#libDrawerBody .d-file .df-ops') ? document.querySelectorAll('#libDrawerBody .d-file .df-ops .x').length : -1);
  ok('抽屉文件行带操作挂点（阅读/转写/来源/删除等，≥10 个）', () => assert(dOps >= 10, 'ops=' + dOps));
  ok('源码保留 makeCbz / aiPanel / 仅文件名 / 删帖挂点', () => {
    assert(src.includes('makeCbz') && src.includes('aiPanel') && src.includes('仅文件名') && src.includes('setCardWeread'), 'hook gone');
  });

  console.log('\n=== F. 主题三档 + 强调色三选 ===');
  st = await page.evaluate(() => ({
    opts: [...document.querySelectorAll('#uiThemeSel option')].map(o => o.value),
    accents: [...document.querySelectorAll('#uiAccentSel option')].map(o => o.value),
    autoListener: typeof _sysThemeDark !== 'undefined' && typeof resolvedTheme === 'function'
  }));
  ok('主题三档（浅/深/跟随系统）+ 强调色三选', () => assert(st.opts.join() === 'light,dark,auto' && st.accents.join() === 'brand,purple,green', JSON.stringify(st)));
  ok('跟随系统 matchMedia 机制在位', () => assert(st.autoListener, 'no matchMedia'));
  for (const a of ['purple', 'green', 'brand']) {
    const acc = await page.evaluate(x => { document.documentElement.dataset.accent = x; return getComputedStyle(document.documentElement).getPropertyValue('--acc').trim(); }, a);
    ok(`强调色 ${a} 变量生效`, () => assert(acc.length > 0, acc));
  }
  // 工具栏主题按钮循环 light→dark→auto→light
  await page.evaluate(() => { currentUi.theme = 'light'; });
  await page.click('#themeToggleBtn');
  await page.waitForTimeout(150);
  const t1 = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.click('#themeToggleBtn');
  await page.waitForTimeout(150);
  const t2 = await page.evaluate(() => currentUi.theme);
  ok('工具栏主题按钮循环切换（light→dark→auto）', () => assert(t1 === 'dark' && t2 === 'auto', t1 + '/' + t2));

  console.log('\n=== F2. 入口去重 + 手动保存视图 ===');
  // 内容级卡墙：点 ℹ 开抽屉（点卡本体直接打开文件，2026-11-23 拍板）+ 封面 file:// + 平台 pill
  await page.evaluate(() => { document.getElementById('libKw').value = ''; setLibKw(''); libView = 'all'; renderLibrary(); window.switchPage('lib'); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { enterLibGroup('g1'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.querySelector('#libList .lcard-info').click(); });
  await page.waitForTimeout(200);
  st = await page.evaluate(() => ({
    drawer: document.getElementById('libDrawer').classList.contains('open'),
    title: document.querySelector('#libDrawerBody .d-title')?.textContent,
    coverImg: !!document.querySelector('#libList .lthumb img[src^="file://"]'),
    platPill: document.querySelectorAll('#libList .lbadge-bl .lpill').length,
    kindPill: document.querySelectorAll('#libList .lbadge-tl .lpill').length
  }));
  ok('ℹ 开详情抽屉 + 封面 file:// + 角标齐（b.jpg 双 pill，a.mp4 单 pill）', () => assert(st.drawer && st.title === 'UP主甲' && st.coverImg && st.platPill === 3 && st.kindPill === 2, JSON.stringify(st)));
  await page.evaluate(() => document.querySelector('#libDrawerScrim').click());
  // 入口去重（2026-11-22 拍板）：工具栏不再有 添加订阅/粘贴下载 按钮，模态层整体撤除
  st = await page.evaluate(() => ({
    dlBtn: !!document.getElementById('openDlModalBtn'),
    subBtn: !!document.getElementById('openSubModalBtn'),
    layers: document.querySelectorAll('.modal-layer').length,
    toolbarBtns: [...document.querySelectorAll('.toolbar button')].map(b => b.id || b.className)
  }));
  ok('工具栏无重复入口（无添加订阅/粘贴下载按钮，无模态层；入口收敛到各自页面）', () => assert(!st.dlBtn && !st.subBtn && st.layers === 0, JSON.stringify(st)));
  // ⌘K「添加订阅」命令 → 跳订阅管理页并聚焦输入框
  await page.evaluate(() => { openCmdk(); });
  await page.waitForTimeout(100);
  await page.keyboard.insertText('>添加订阅');
  await page.waitForTimeout(120);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  st = await page.evaluate(() => ({ page: (document.querySelector('.page.on') || {}).id, focus: document.activeElement === document.getElementById('subUrl') }));
  ok('⌘K「添加订阅」→ 跳订阅管理页并聚焦粘贴框', () => assert(st.page === 'page-rss' && st.focus, JSON.stringify(st)));
  // 手动添加视图（缺口①）：侧栏入口 → manual 只留 b.jpg 一张卡
  await page.evaluate(() => { window.__lib.groups[0].files[1].src = { via: 'single', url: 'https://e.com/b' }; document.getElementById('libKw').value = ''; setLibKw(''); window.switchPage('lib'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => libViewGo('manual'));
  await page.waitForTimeout(250);
  st = await page.evaluate(() => ({ cards: document.querySelectorAll('#libList .lcard').length, pills: document.querySelectorAll('#libList .lpill.origin.manual').length, title: (document.getElementById('libTitle') || {}).textContent }));
  ok('手动添加视图：侧栏入口只留 b.jpg 卡 + 蓝色手动角标 + 页头标题', () => assert(st.cards === 1 && st.pills === 1 && st.title === '手动添加', JSON.stringify(st)));
  // 页内类型分段与视图正交：manual×video = 空态；all×video = 2 卡
  await page.evaluate(() => document.querySelector('#libKindSeg .libseg-item[data-kind="video"]').click());
  await page.waitForTimeout(250);
  st = await page.evaluate(() => ({ cards: document.querySelectorAll('#libList .lcard').length, empty: document.getElementById('libList').textContent }));
  ok('视频分段：manual×video 交集空态文案', () => assert(st.cards === 0 && st.empty.includes('没有视频'), JSON.stringify(st)));
  await page.evaluate(() => { libViewGo('all'); syncKindSeg(); });
  await page.waitForTimeout(250);
  st = await page.evaluate(() => document.querySelectorAll('#libList .lcard').length);
  ok('全部×视频：2 张视频卡（a.mp4/c.mp4）', () => assert(st === 2, 'cards=' + st));
  await page.evaluate(() => document.querySelector('#libKindSeg .libseg-item[data-kind="all"]').click());
  await page.waitForTimeout(200);
  st = await page.evaluate(() => ({ grpCards: document.querySelectorAll('#libList .subgcard').length, lcards: document.querySelectorAll('#libList .lcard').length }));
  ok('回全部分段：组卡网格顶层（2 张主页卡）', () => assert(st.grpCards === 2 && st.lcards === 0, JSON.stringify(st)));

  console.log('\n=== G. 触控目标 ===');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { window.switchPage('tasks'); });
  await page.waitForTimeout(250);
  const touch = await page.evaluate(() => {
    const h = sel => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect().height : 0; };
    return { pasteBtn: h('#p2Top .tb-paste .btn-dl'), kpi: h('#kpiHost .kc') };
  });
  ok('主操作按钮 ≥40px（顶栏粘贴栏加入队列）；KPI 卡瘦身（高 ≤72px）', () => assert(touch.pasteBtn >= 40 && touch.kpi > 0 && touch.kpi <= 72, JSON.stringify(touch)));

  console.log('\n=== H. 响应式无横向溢出（1440/1024/390）===');
  for (const w of [1440, 1024, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(300);
    const over = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth
    }));
    ok(`${w}px 无横向溢出（侧栏窄屏自动折叠）`, () => assert(over.doc <= 1 && over.body <= 1, JSON.stringify(over) + ' sidebarCollapsed=' + w));
  }

  console.log('\n=== I. 坑位静态计数 ===');
  // 91 基线 +1（renderSubs 映射重构）+6（第五批色板/站点标签映射行 weread/weixin 标识符与公众号标签，非新增入口）
  const occ = (src.match(/公众号|视频号|weread|weixin|Channels/g) || []).length;
  ok('公众号/视频号坑位出现次数 = 102（基线 98 + 订阅主页视图 kind 映射行 weread/公众号 标识符重复）', () => assert(occ === 102, 'occ=' + occ));

  console.log('\n=== J. 运行时无 JS 报错 ===');
  ok('pageerror 为空', () => assert(errors.length === 0, errors.slice(0, 3).join(' | ')));

  await browser.close();
  console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
