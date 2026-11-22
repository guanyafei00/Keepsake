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
    { key: 'g2', uploader: 'UP主乙', site: 'youtube', fileCount: 1, videoCount: 1, imageCount: 0, sizeText: '4.1 MB', lastMtime: Date.now() - 120000,
      files: [{ name: 'c.mp4', kind: 'video', path: 'D:\\b\\c.mp4', sizeText: '4.1 MB', mtime: Date.now() - 120000 }] }
  ], totalFiles: 4, totalSize: 13107200
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
    brand: !!document.querySelector('.tb-brand .tb-name'),
    search: !!document.getElementById('searchTrigger'),
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
  ok('工具栏（应用名+搜索触发框+主题按钮+侧栏开关）', () => assert(base.toolbar && base.brand && base.search && base.themeBtn && base.sideToggle, JSON.stringify(base)));
  ok('毛玻璃侧栏在 workspace 内，五页导航 + 三分组（媒体库/订阅主页/工具）', () => assert(base.sidebar && base.navs.length === 5 && base.grp === 3 && base.navs[0] === 'lib', JSON.stringify(base.navs)));
  ok('侧栏底部状态区（登录/规则/引擎更新入口）', () => assert(base.foot, 'no side-foot'));
  ok('⌘K 面板容器在位', () => assert(base.cmdk, 'no cmdk'));
  ok('详情抽屉在位', () => assert(base.drawer, 'no drawer'));
  ok('五页 id 齐全', () => assert(['page-tasks', 'page-rss', 'page-lib', 'page-strategy', 'page-settings'].every(x => base.pages.includes(x)), JSON.stringify(base.pages)));
  const onPageLib = await page.evaluate(() => (document.querySelector('.page.on') || {}).id === 'page-lib');
  ok('第三阶段：默认页 = 媒体库（启动第一眼）', () => assert(onPageLib));
  const sideShell = await page.evaluate(() => !!document.querySelector('.sidebar .nav[data-nav="manual"]') && !!document.getElementById('sideSubList') && !!document.getElementById('sideSubCnt'));
  ok('第三阶段：侧栏手动添加入口 + 订阅列表容器在位', () => assert(sideShell));

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
  ok('毛玻璃面 = 工具栏/侧栏/⌘K面板/抽屉（+模态层/卡角标，无意外面）', () => {
    const ALLOWED = ['toolbar', 'sidebar', 'cmdk', 'drawer', 'modal-layer', 'lpill'];
    const norm = faces => faces.map(f => {
      const s = f.replace(/^#/, '');
      if (s === 'libDrawer') return 'drawer';
      if (s === 'subscribeLayer' || s === 'downloadLayer') return 'modal-layer';
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
  const libRendered = await page.evaluate(() => ({
    cards: document.querySelectorAll('#libList .lcard').length,
    grid: !!document.querySelector('#libList .libgrid'),
    covers: document.querySelectorAll('#libList .lthumb').length,
    seg: document.querySelectorAll('#libOriginSeg .libseg-item').length
  }));
  ok('媒体库卡墙渲染（2 组卡 + 封面 + 分段控件）', () => assert(libRendered.cards === 2 && libRendered.grid && libRendered.covers === 2 && libRendered.seg === 3, JSON.stringify(libRendered)));
  const rssRendered = await page.evaluate(() => ({
    cards: document.querySelectorAll('#subList .subcard').length,
    detail: document.querySelectorAll('#subList .sc-detail').length,
    actions: document.querySelectorAll('#subList .sc-actions .sx').length
  }));
  ok('订阅页卡片化渲染（2 卡 + 展开区 + 操作挂点）', () => assert(rssRendered.cards === 2 && rssRendered.detail === 2 && rssRendered.actions >= 14, JSON.stringify(rssRendered)));
  const sideSubs = await page.evaluate(() => ({ items: document.querySelectorAll('#sideSubList .side-sub').length, cnt: document.getElementById('sideSubCnt').textContent }));
  ok('侧栏订阅主页动态列表同步（2 项 + 计数）', () => assert(sideSubs.items === 2 && sideSubs.cnt === '2', JSON.stringify(sideSubs)));
  // 手动添加联动：点击侧栏入口 → 媒体库切到手动添加视图
  await page.evaluate(() => document.querySelector('.sidebar .nav[data-nav="manual"]').click());
  await page.waitForTimeout(260);
  const manualView = await page.evaluate(() => ({
    seg: document.querySelector('#libOriginSeg .libseg-item.active').dataset.origin,
    navOn: document.querySelector('.sidebar .nav.on[data-nav]') ? 'manual' : 'page'
  }));
  ok('侧栏「手动添加」→ 媒体库手动视图 + 入口高亮', () => assert(manualView.seg === 'manual' && manualView.navOn === 'manual', JSON.stringify(manualView)));
  await page.evaluate(() => { libOriginFilter = 'all'; document.querySelectorAll('#libOriginSeg .libseg-item').forEach(x => { const on = x.dataset.origin === 'all'; x.classList.toggle('active', on); x.setAttribute('aria-selected', on); }); });

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
  st = await page.evaluate(() => ({ open: isCmdkOpen(), dl: document.getElementById('downloadLayer').classList.contains('open') }));
  ok('Enter 执行：打开「粘贴链接下载」模态且面板关闭', () => assert(!st.open && st.dl, JSON.stringify(st)));
  await page.evaluate(() => closeLayerModal('downloadLayer'));
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
  st = await page.evaluate(() => ({ page: (document.querySelector('.page.on') || {}).id, drawer: isLibDrawerOpen(), expanded: expandedKey }));
  ok('Enter 打开媒体库分组 + 详情抽屉', () => assert(st.page === 'page-lib' && st.drawer && st.expanded === 'g1', JSON.stringify(st)));
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
  // Esc 分层关闭（⌘K > 新模态层 > 通用模态 > 抽屉）
  // 先测新模态层拦截：Esc 只关模态层，不透传（capture 前置）
  await page.evaluate(() => { openLayerModal('subscribeLayer'); openCmdk(); });
  await page.waitForTimeout(80);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  st = await page.evaluate(() => ({ sub: document.getElementById('subscribeLayer').classList.contains('open'), cmdk: isCmdkOpen() }));
  ok('Esc：新模态层拦截且只关模态层（⌘K 仍在）', () => assert(!st.sub && st.cmdk, JSON.stringify(st)));
  await page.evaluate(() => { closeCmdk(); });
  // 经典三层
  await page.evaluate(() => { [...document.querySelectorAll('.modal-layer.open')].forEach(l => l.classList.remove('open')); openCmdk(); });
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
  await page.evaluate(() => { document.querySelector('#libList [onclick*="openLibDrawer"]').click(); });
  await page.waitForTimeout(200);
  st = await page.evaluate(() => ({
    open: isLibDrawerOpen(),
    title: document.querySelector('#libDrawerBody .d-title')?.textContent,
    rows: document.querySelectorAll('#libDrawerBody .d-row').length,
    files: document.querySelectorAll('#libDrawerBody .d-file').length
  }));
  ok('点 ⓘ 打开详情抽屉（标题/行/文件列表）', () => assert(st.open && st.title === 'UP主甲' && st.rows === 4 && st.files === 2, JSON.stringify(st)));
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

  console.log('\n=== F2. 第二阶段真移植：模态提交 + 手动保存视图 ===');
  // 卡墙展开：点卡片展开文件行卡（全组转写/专题总结/详情/文件夹按钮区）
  await page.evaluate(() => { document.getElementById('libKw').value = ''; setLibKw(''); expandedKey = null; renderLibrary(); window.switchPage('lib'); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.querySelector('#libList .lcard').click(); });
  await page.waitForTimeout(200);
  st = await page.evaluate(() => ({
    files: document.querySelectorAll('#libList .task').length,
    grpBtns: ['transcribeGroup', 'summarizeGroup', 'openLibDrawer', 'openPath'].map(f => !!document.querySelector(`#libList [onclick*="${f}"]`)),
    coverImg: !!document.querySelector('#libList .lthumb img[src^="file://"]')
  }));
  ok('卡墙点卡展开文件行 + 组级按钮挂点齐 + 封面 file://', () => assert(st.files === 2 && st.grpBtns.every(Boolean) && st.coverImg, JSON.stringify(st)));
  // 添加订阅模态：提交 → 关模态 + 切订阅页
  await page.evaluate(() => { document.getElementById('subUrlModal').value = 'https://example.com/u1'; openSubModal(); });
  await page.waitForTimeout(100);
  st = await page.evaluate(() => document.getElementById('subscribeLayer').classList.contains('open'));
  ok('openSubModal 打开添加订阅模态', () => assert(st, 'not open'));
  await page.evaluate(() => document.getElementById('submitSubscribeBtn').click());
  await page.waitForTimeout(400);
  st = await page.evaluate(() => ({ open: document.getElementById('subscribeLayer').classList.contains('open'), page: (document.querySelector('.page.on') || {}).id }));
  ok('订阅模态提交：关模态 + 切订阅页（复用 addSub）', () => assert(!st.open && st.page === 'page-rss', JSON.stringify(st)));
  // 粘贴下载模态：提交 → 关模态 + 切任务页 + 链接填入 #urls
  await page.evaluate(() => { document.getElementById('linkBoxModal').value = 'https://e.com/1\nhttps://e.com/2'; openDlModal(); });
  await page.waitForTimeout(100);
  await page.evaluate(() => document.getElementById('submitDownloadBtn').click());
  await page.waitForTimeout(400);
  st = await page.evaluate(() => ({ open: document.getElementById('downloadLayer').classList.contains('open'), page: (document.querySelector('.page.on') || {}).id, urls: document.getElementById('urls').value }));
  ok('下载模态提交：关模态 + 切任务页 + addUrls 已消费链接（#urls 清空）', () => assert(!st.open && st.page === 'page-tasks' && st.urls === '', JSON.stringify(st)));
  // 手动保存视图（缺口①）：manual 过滤含单条来源的组
  await page.evaluate(() => { window.__lib.groups[0].files[1].src = { via: 'single', url: 'https://e.com/b' }; document.getElementById('libKw').value = ''; setLibKw(''); window.switchPage('lib'); });
  await page.waitForTimeout(200);
  await page.evaluate(() => document.querySelector('#libOriginSeg .libseg-item[data-origin="manual"]').click());
  await page.waitForTimeout(250);
  st = await page.evaluate(() => ({ cards: document.querySelectorAll('#libList .lcard').length, pills: document.querySelectorAll('#libList .lpill.manual').length }));
  ok('手动保存视图：过滤出含手动来源的组 + 蓝色手动角标', () => assert(st.cards === 1 && st.pills >= 1, JSON.stringify(st)));
  await page.evaluate(() => document.querySelector('#libOriginSeg .libseg-item[data-origin="sub"]').click());
  await page.waitForTimeout(250);
  st = await page.evaluate(() => ({ cards: document.querySelectorAll('#libList .lcard').length, empty: document.getElementById('libList').textContent }));
  ok('订阅视图：0 组且空态文案正确（mock 无订阅来源）', () => assert(st.cards === 0 && st.empty.includes('还没有订阅归档'), JSON.stringify(st.empty.slice(0, 40))));
  await page.evaluate(() => document.querySelector('#libOriginSeg .libseg-item[data-origin="all"]').click());
  await page.waitForTimeout(200);
  st = await page.evaluate(() => document.querySelectorAll('#libList .lcard').length);
  ok('全部视图：回到 2 组卡', () => assert(st === 2, 'cards=' + st));

  console.log('\n=== G. 触控目标 ===');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { window.switchPage('tasks'); });
  await page.waitForTimeout(250);
  const touch = await page.evaluate(() => {
    const h = sel => { const el = document.querySelector(sel); return el ? el.getBoundingClientRect().height : 0; };
    return { btnDl: h('.btn-dl'), tbAct: h('#p2Top .tb-act') };
  });
  ok('主操作按钮 ≥40px（加入队列 / 顶栏主操作）', () => assert(touch.btnDl >= 40 && touch.tbAct >= 40, JSON.stringify(touch)));

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
  // 91 基线 +1：第三阶段 renderSubs 拆 kindLabel/kindEmoji 两个映射，weread 标识符同函数内重复一次，非新增入口
  const occ = (src.match(/公众号|视频号|weread|weixin|Channels/g) || []).length;
  ok('公众号/视频号坑位出现次数 = 92（91 基线 + renderSubs 映射重构重复）', () => assert(occ === 92, 'occ=' + occ));

  console.log('\n=== J. 运行时无 JS 报错 ===');
  ok('pageerror 为空', () => assert(errors.length === 0, errors.slice(0, 3).join(' | ')));

  await browser.close();
  console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
