// 侧栏每一项对应界面截图（mock 数据，含真实封面文件）
const { chromium } = require('playwright');
const path = require('path');
const HTML = path.resolve(__dirname, '../app/index.html');
const url = 'file://' + HTML.replace(/\\/g, '/');
const COVER = path.resolve(__dirname, '../screenshots/keepsake-home.png'); // 真实存在的图片文件，供 file:// 封面加载

const SNAP = [
  { id: 't1', status: 'downloading', progress: 45, title: '如何自制一台迷你 NAS', engine: 'yt-dlp' },
  { id: 't2', status: 'downloading', progress: 82, title: '城市漫游 Vol.7 图片包', engine: 'gallery-dl' },
  { id: 't3', status: 'done', title: '设计参考合集', engine: 'gallery-dl', filePath: 'D:\\a\\b.jpg' }
];
const SUBS = [
  { id: 's1', name: '何同学', kind: 'bilibili', knownCount: 128, paused: false, lastCheck: Date.now() - 300000 },
  { id: 's2', name: '影视飓风', kind: 'bilibili', knownCount: 96, paused: false, lastCheck: Date.now() - 900000 },
  { id: 's3', name: '设计师日常', kind: 'xhs-user', knownCount: 42, paused: false, lastCheck: Date.now() - 1200000 },
  { id: 's4', name: '少数派', kind: 'rss', knownCount: 57, paused: false, lastCheck: Date.now() - 600000 },
  { id: 's5', name: '一人公司', kind: 'youtube', knownCount: 23, paused: true, lastCheck: Date.now() - 3600000 }
];
const LIB = {
  groups: [
    { key: 'g1', uploader: '何同学', site: 'bilibili', fileCount: 3, videoCount: 2, imageCount: 1, sizeText: '8.4 MB', lastMtime: Date.now() - 60000,
      files: [
        { name: 'a.mp4', kind: 'video', path: 'D:\\a\\a.mp4', sizeText: '5 MB', mtime: Date.now() - 60000 },
        { name: 'b.jpg', kind: 'image', path: COVER, sizeText: '2 MB', mtime: Date.now() - 90000, src: { via: 'single', url: 'https://e.com/b' } },
        { name: 'c.srt', kind: 'other', path: 'D:\\a\\c.srt', sizeText: '12 KB', mtime: Date.now() - 80000 }
      ] },
    { key: 'g2', uploader: '影视飓风', site: 'youtube', fileCount: 1, videoCount: 1, imageCount: 0, sizeText: '4.1 MB', lastMtime: Date.now() - 120000,
      files: [{ name: 'd.mp4', kind: 'video', path: 'D:\\b\\d.mp4', sizeText: '4.1 MB', mtime: Date.now() - 120000 }] }
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
  asrModels: () => Promise.resolve({ models: [], current: '' }), loginState: () => Promise.resolve({}),
  settingsGet: () => Promise.resolve({ ui: { theme: 'light', accent: 'brand', layout: 'grid' }, autoCbz: false, autoSubtitle: false }),
  checkUpdate: obj, doUpdate: obj, refreshRules: obj,
  on: () => {}, once: () => {}, removeListener: () => {}, textSearch: arr, reindex: obj,
  onAsrProgress: () => {}, onAsrPhase: () => {}, onAsrDone: () => {}, onAsrError: () => {},
  onAsrDownloadProgress: () => {}, onEngineProgress: () => {}, onToast: () => {}, onClipboardUrl: () => {},
  onSubs: () => {}, onLibJob: () => {}, onLibraryRefresh: () => {}, onQueue: () => {},
  onInterrupted: () => {}, onTask: () => {}, onDone: () => {}, onRule: () => {}, onLog: () => {},
  onEngine: () => {}, onXhs: () => {}
};
window.keepsake = new Proxy(window.keepsake, { get(t, k) { return k in t ? t[k] : () => Promise.resolve({}); } });
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('onboardMask')?.remove();
  try { localStorage.setItem('keepsake-onboarded', '1'); } catch (e) {}
});
`;

const OUT = path.resolve(__dirname, '../评审材料/vf5-content');
const ITEMS = [
  ['sbitem-1-all.png', () => window.libViewGo('all'), '侧栏项-所有归档'],
  ['sbitem-2-only.png', () => window.libViewGo('only'), '侧栏项-仅文件名'],
  ['sbitem-3-subs.png', () => window.libViewGo('subs'), '侧栏项-订阅主页'],
  ['sbitem-4-manual.png', () => window.libViewGo('manual'), '侧栏项-手动保存'],
  ['sbitem-5-rss.png', () => window.switchPage('rss'), '侧栏项-订阅管理（管理链接）'],
  ['sbitem-6-tasks.png', () => window.switchPage('tasks'), '侧栏项-任务队列'],
  ['sbitem-7-strategy.png', () => window.switchPage('strategy'), '侧栏项-限流策略'],
  ['sbitem-8-settings.png', () => window.switchPage('settings'), '侧栏项-设置']
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(MOCK);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  for (const [file, fn] of ITEMS) {
    await page.evaluate(fn);
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, file) });
    console.log('SHOT', file);
  }
  await browser.close();
  console.log('DONE');
})();
