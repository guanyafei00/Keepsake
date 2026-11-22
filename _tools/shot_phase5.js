// 第五批效果图截图（内容级卡墙 + 设计稿侧栏；mock + CC 真图，一次性工具）
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const HTML = path.resolve(__dirname, '../app/index.html');
const IMG = path.resolve(__dirname, '../../deliverables/media-library-ui-preview/design-demos/assets/img');
if (!fs.existsSync(IMG)) throw new Error('assets 不在预期位置: ' + IMG);
const url = 'file://' + HTML.replace(/\\/g, '/');
const im = n => path.join(IMG, n).replace(/\\/g, '/');
const now = Date.now(), H = 3600e3, D = 86400e3;
const LIB = {
  groups: [
    { key: 'g1', uploader: '拾光放映室', site: 'xiaohongshu', fileCount: 4, videoCount: 2, imageCount: 2, sizeText: '96.3 MB', lastMtime: now - 1 * H,
      files: [
        { name: '河堤的第一顶樱芽.mp4', kind: 'video', path: 'D:/x/a1.mp4', sizeText: '48 MB', mtime: now - 1 * H, src: { via: 'sub' } },
        { name: '樱花铁道，慢门 1-15.jpg', kind: 'image', path: im('02_sakura_rail.jpg'), sizeText: '2.1 MB', mtime: now - 2 * H, src: { via: 'sub' } },
        { name: '樱芽特写.jpg', kind: 'image', path: im('01_sakura_buds.jpg'), sizeText: '6.1 MB', mtime: now - 3 * H, src: { via: 'sub' } },
        { name: '山谷里的第一顶帐篷.mp4', kind: 'video', path: 'D:/x/a2.mp4', sizeText: '40.1 MB', mtime: now - 4 * H, src: { via: 'sub' } }
      ] },
    { key: 'g2', uploader: '半山书房', site: 'weread', fileCount: 3, videoCount: 1, imageCount: 2, sizeText: '32.6 MB', lastMtime: now - 26 * H,
      files: [
        { name: '我的桌面 2026.jpg', kind: 'image', path: im('03_desk_bombe.jpg'), sizeText: '5.2 MB', mtime: now - 26 * H, src: { via: 'sub' } },
        { name: '书架后的整面书墙.mp4', kind: 'video', path: 'D:/x/b1.mp4', sizeText: '22.2 MB', mtime: now - 27 * H, src: { via: 'sub' } },
        { name: '书墙细节.jpg', kind: 'image', path: im('04_desk_bookcase.jpg'), sizeText: '5.2 MB', mtime: now - 28 * H, src: { via: 'sub' } }
      ] },
    { key: 'g3', uploader: '林间小记', site: 'xiaohongshu', fileCount: 2, videoCount: 1, imageCount: 1, sizeText: '28.4 MB', lastMtime: now - 2 * D,
      files: [
        { name: '山谷营地清晨.jpg', kind: 'image', path: im('05_tent_valley.jpg'), sizeText: '8.4 MB', mtime: now - 2 * D, src: { via: 'single', url: 'https://e.com/t1' } },
        { name: '巷口咖啡店的乖驻猫.mp4', kind: 'video', path: 'D:/x/c1.mp4', sizeText: '20 MB', mtime: now - 3 * D, src: { via: 'single', url: 'https://e.com/t2' } }
      ] },
    { key: 'g4', uploader: '胶片日常', site: 'x', fileCount: 2, videoCount: 0, imageCount: 2, sizeText: '14.2 MB', lastMtime: now - 5 * D,
      files: [
        { name: '夜色街角的价签.jpg', kind: 'image', path: im('07_night_city.jpg'), sizeText: '7.2 MB', mtime: now - 5 * D, src: { via: 'single', url: 'https://e.com/t3' } },
        { name: '窗格光影.jpg', kind: 'image', path: im('10_light_wall.jpg'), sizeText: '7.0 MB', mtime: now - 6 * D, src: { via: 'single', url: 'https://e.com/t4' } }
      ] },
    { key: 'g5', uploader: '老周修东西', site: 'bilibili', fileCount: 3, videoCount: 1, imageCount: 1, sizeText: '210 MB', lastMtime: now - 9 * D,
      files: [
        { name: '手工皮带：裁切到封边.mp4', kind: 'video', path: 'D:/x/belt.mp4', sizeText: '180 MB', mtime: now - 9 * D, src: { via: 'sub' } },
        { name: '皮靴细节.jpg', kind: 'image', path: im('12_leather_boots.jpg'), sizeText: '30 MB', mtime: now - 9 * D - H, src: { via: 'single', url: 'https://e.com/t5' } },
        { name: 'belt_ep02.info.json', kind: 'other', path: 'D:/x/belt.info.json', sizeText: '6 KB', mtime: now - 9 * D - 2 * H }
      ] }
  ], totalFiles: 14, totalSize: 381000000
};
const SNAP = [{ id: 't1', status: 'downloading', progress: 45, title: '视频A', engine: 'yt-dlp' }, { id: 't3', status: 'done', title: '图文C', engine: 'gallery-dl', filePath: 'D:/a/c.png' }];
const SUBS = [
  { id: 's1', name: '拾光放映室', kind: 'xhs-user', knownCount: 128, paused: false, lastCheck: now - 300000 },
  { id: 's2', name: '半山书房', kind: 'weread', knownCount: 64, paused: false, lastCheck: now - 900000, lastError: '读书接口频率受限', lastFailAt: now - 120000 },
  { id: 's3', name: '老周修东西', kind: 'bilibili', knownCount: 41, paused: false, lastCheck: now - 600000 },
  { id: 's4', name: '林间小记', kind: 'xhs-user', knownCount: 87, paused: false, lastCheck: now - 700000 },
  { id: 's5', name: '胶片日常', kind: 'x', knownCount: 210, paused: false, lastCheck: now - 800000 }
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
const OUT = path.resolve(__dirname, '../评审材料/vf5-content');
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
  await page.addInitScript(MOCK);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  // 1 启动第一眼：默认「所有归档」内容级卡墙 + 设计稿侧栏
  await page.evaluate(() => { try { loadSubs(); } catch (e) {} });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'vf5-home.png') });
  // 2 侧栏点订阅 → 卡墙按订阅过滤
  await page.evaluate(() => sideSubGo('s1'));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, 'vf5-sub-filtered.png') });
  // 3 手动添加视图
  await page.evaluate(() => { const b = document.querySelector('#libKw'); if (b) b.value = ''; setLibKw(''); libViewGo('manual'); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'vf5-manual.png') });
  // 4 抽屉（点老周修东西组的一张卡）
  await page.evaluate(() => { libViewGo('all'); window.switchPage('lib'); });
  await page.waitForTimeout(500);
  await page.evaluate(() => openLibDrawer('g5'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'vf5-drawer.png') });
  await page.evaluate(() => document.getElementById('libDrawerScrim').click());
  // 5 深色所有归档
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.switchPage('lib'); renderLibrary(); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, 'vf5-dark.png') });
  await browser.close();
  console.log('OK 截图 →', OUT);
})().catch(e => { console.error(e); process.exit(1); });
