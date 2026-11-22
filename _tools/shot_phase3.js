// 第三阶段 IA 效果图截图（mock + CC 真图，一次性工具）
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const HTML = path.resolve(__dirname, '../app/index.html');
const IMG = path.resolve(__dirname, '../../deliverables/media-library-ui-preview/design-demos/assets/img');
if (!fs.existsSync(path.dirname(IMG))) throw new Error('assets 不在预期位置');
const url = 'file://' + HTML.replace(/\\/g, '/');
const im = n => 'file:///' + path.join(IMG, n).replace(/\\/g, '/');
const LIB = {
  groups: [
    { key: 'g1', uploader: '拾光放映室', site: 'xiaohongshu', fileCount: 3, videoCount: 2, imageCount: 1, sizeText: '56.2 MB', lastMtime: Date.now() - 60000,
      files: [
        { name: '河堤樱芽.mp4', kind: 'video', path: 'D:/x/a.mp4', sizeText: '48 MB', mtime: Date.now() - 60000 },
        { name: '樱花铁道慢门.jpg', kind: 'image', path: path.join(IMG, '02_sakura_rail.jpg'), sizeText: '2.1 MB', mtime: Date.now() - 90000, src: { via: 'single', url: 'https://e.com/b' } },
        { name: '樱芽封面.jpg', kind: 'image', path: path.join(IMG, '01_sakura_buds.jpg'), sizeText: '6.1 MB', mtime: Date.now() - 95000 }
      ] },
    { key: 'g2', uploader: '半山书房', site: 'article', fileCount: 2, videoCount: 0, imageCount: 2, sizeText: '12.8 MB', lastMtime: Date.now() - 120000,
      files: [
        { name: '桌面巡礼.jpg', kind: 'image', path: path.join(IMG, '03_desk_bombe.jpg'), sizeText: '5.2 MB', mtime: Date.now() - 120000, src: { via: 'sub', url: 'https://e.com/c' } },
        { name: '书墙.jpg', kind: 'image', path: path.join(IMG, '04_desk_bookcase.jpg'), sizeText: '7.6 MB', mtime: Date.now() - 130000, src: { via: 'sub', url: 'https://e.com/d' } }
      ] },
    { key: 'g3', uploader: '老周修东西', site: 'bilibili', fileCount: 2, videoCount: 2, imageCount: 0, sizeText: '210 MB', lastMtime: Date.now() - 300000,
      files: [
        { name: '手工皮带.mp4', kind: 'video', path: 'D:/x/belt.mp4', sizeText: '180 MB', mtime: Date.now() - 300000, src: { via: 'sub', url: 'https://e.com/e' } },
        { name: '皮靴细节.jpg', kind: 'image', path: path.join(IMG, '12_leather_boots.jpg'), sizeText: '30 MB', mtime: Date.now() - 310000, src: { via: 'single', url: 'https://e.com/f' } }
      ] }
  ], totalFiles: 7, totalSize: 278918144
};
const SNAP = [{ id: 't1', status: 'downloading', progress: 45, title: '视频A', engine: 'yt-dlp' }, { id: 't3', status: 'done', title: '图文C', engine: 'gallery-dl', filePath: 'D:/a/c.png' }];
const SUBS = [
  { id: 's1', name: '拾光放映室', kind: 'xhs-user', knownCount: 128, paused: false, lastCheck: Date.now() - 300000 },
  { id: 's2', name: '半山书房', kind: 'weread', knownCount: 64, paused: false, lastCheck: Date.now() - 900000, lastError: '读书接口频率受限', lastFailAt: Date.now() - 120000 }
];
const MOCK = `
window.__snap = ${JSON.stringify(SNAP)};
window.__subs = ${JSON.stringify(SUBS)};
window.__lib = ${JSON.stringify(LIB)};
const arr = () => Promise.resolve([]); const obj = () => Promise.resolve({});
window.keepsake = { snapshot: () => Promise.resolve(window.__snap), tasks: arr, queue: arr, done: arr,
  subsList: () => Promise.resolve(window.__subs), subs: arr, libraryScan: () => Promise.resolve(window.__lib), libraryList: arr,
  wereadState: obj, cookieInfo: () => Promise.resolve({}), pixivState: obj, asr: obj, engines: arr,
  strategySnapshot: () => Promise.resolve({ defaults: [], learned: {} }), strategyVersion: () => Promise.resolve('test'),
  asrModels: () => Promise.resolve({ models: [], current: '' }), loginState: () => Promise.resolve({}),
  settingsGet: () => Promise.resolve({ ui: { theme: 'light', accent: 'brand', layout: 'grid' } }),
  settingsSetUi: p => Promise.resolve({ ui: { theme: p.theme, accent: p.accent, layout: 'grid' } }),
  on: () => {}, once: () => {}, removeListener: () => {} };
window.keepsake = new Proxy(window.keepsake, { get(t, k) { return k in t ? t[k] : () => Promise.resolve({}); } });
document.addEventListener('DOMContentLoaded', () => { document.getElementById('onboardMask')?.remove(); try { localStorage.setItem('keepsake-onboarded', '1'); } catch (e) {} });
`;
const OUT = path.resolve(__dirname, '../评审材料/vf3-ia');
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  await page.addInitScript(MOCK);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  // 1 启动第一眼：默认媒体库 + 侧栏订阅列表（不点任何东西直接截）
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'vf3-home-default.png') });
  // 2 侧栏点订阅 → 媒体库按该订阅过滤
  await page.evaluate(() => sideSubGo('s1'));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'vf3-sub-filtered.png') });
  // 3 订阅页卡片化（含失败态红点示例）
  await page.evaluate(() => window.switchPage('rss'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'vf3-subs-cards.png') });
  // 4 订阅卡展开「调度与规则」
  await page.evaluate(() => { const d = document.querySelector('#subList .subcard .sc-detail'); if (d) d.open = true; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'vf3-sub-detail.png') });
  // 5 手动添加视图（侧栏入口；先清上一步的搜索词，模拟干净路径）
  await page.evaluate(() => { const b = document.querySelector('#libKw'); if (b) b.value = ''; setLibKw(''); libOriginGo('manual', document.querySelector('.sidebar .nav[data-nav="manual"]')); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'vf3-manual.png') });
  // 6 深色默认页
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.switchPage('lib'); libOriginFilter = 'all'; document.querySelectorAll('#libOriginSeg .libseg-item').forEach(x => { const on = x.dataset.origin === 'all'; x.classList.toggle('active', on); x.setAttribute('aria-selected', on); }); renderLibrary(); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'vf3-dark.png') });
  await browser.close();
  console.log('OK 截图 →', OUT);
})().catch(e => { console.error(e); process.exit(1); });
