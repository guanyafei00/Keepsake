// 订阅主页视图效果图（mock 数据）：侧栏单入口 → 右侧详细名称列表
const { chromium } = require('playwright');
const path = require('path');
const HTML = path.resolve(__dirname, '../app/index.html');
const url = 'file://' + HTML.replace(/\\/g, '/');
const SUBS = [
  { id: 's1', name: '何同学', kind: 'bilibili', knownCount: 128, paused: false, lastCheck: Date.now() - 300000 },
  { id: 's2', name: '影视飓风', kind: 'bilibili', knownCount: 96, paused: false, lastCheck: Date.now() - 900000 },
  { id: 's3', name: '设计师日常', kind: 'xhs-user', knownCount: 42, paused: false, lastCheck: Date.now() - 1200000 },
  { id: 's4', name: '少数派', kind: 'rss', knownCount: 57, paused: false, lastCheck: Date.now() - 600000 },
  { id: 's5', name: '一人公司', kind: 'youtube', knownCount: 23, paused: true, lastCheck: Date.now() - 3600000 }
];
const MOCK = `
window.__subs = ${JSON.stringify(SUBS)};
const arr = () => Promise.resolve([]);
const obj = () => Promise.resolve({});
window.keepsake = {
  subsList: () => Promise.resolve(window.__subs), snapshot: arr, tasks: arr, queue: arr, done: arr,
  libraryScan: () => Promise.resolve({ groups: [], totalFiles: 0, totalSize: 0 }), libraryList: arr,
  wereadState: obj, cookieInfo: () => Promise.resolve({}), pixivState: obj, asr: obj, engines: arr,
  strategySnapshot: () => Promise.resolve({ defaults: [], learned: {} }), strategyVersion: () => Promise.resolve('test'),
  asrModels: () => Promise.resolve({ models: [], current: '' }), loginState: () => Promise.resolve({}),
  settingsGet: () => Promise.resolve({ ui: { theme: 'light', accent: 'brand', layout: 'grid' } }),
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
(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(MOCK);
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.evaluate(() => libViewGo('subs'));
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.resolve(__dirname, '../评审材料/vf5-content/vf6-subs-entry.png') });
  await browser.close();
  console.log('DONE');
})();
