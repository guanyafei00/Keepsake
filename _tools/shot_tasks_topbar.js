// 任务页效果图：mock 数据 + 顶栏粘贴栏 + 瘦身 KPI
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const SNAP = { totalFiles: 5, totalSize: 13107200 };
const SUBS = [
  { id: 's1', name: '影视飓风', kind: 'bilibili', knownCount: 128, lastCheck: Date.now() },
  { id: 's2', name: '何同学', kind: 'bilibili', knownCount: 42, lastCheck: Date.now() - 86400000 },
  { id: 's3', name: '设计师日常', kind: 'xhs-user', knownCount: 96, lastCheck: Date.now() - 3600000 },
  { id: 's4', name: '少数派', kind: 'weread', knownCount: 210, lastCheck: Date.now() - 7200000 },
  { id: 's5', name: '一人公司', kind: 'rss', knownCount: 15, userPaused: true, lastCheck: Date.now() - 172800000 }
];
const LIB = { groups: [], totalFiles: 0, totalSize: 0 };
const MOCK = `
window.__snap = ${JSON.stringify(SNAP)};
window.__subs = ${JSON.stringify(SUBS)};
window.__lib = ${JSON.stringify(LIB)};
const arr = () => Promise.resolve([]);
const obj = () => Promise.resolve({});
window.keepsake = {
  snapshot: () => Promise.resolve(window.__snap),
  tasks: () => Promise.resolve([
    { id: 't1', title: '【4K】城市夜景延时摄影.mp4', site: 'bilibili', status: 'downloading', note: '62%' },
    { id: 't2', title: '秋日穿搭合集（图文）', site: 'xhs', status: 'queued' }
  ]),
  queue: arr, done: () => Promise.resolve([{ id: 'd1', title: '旧视频存档.mp4', site: 'bilibili', status: 'done' }]),
  subsList: () => Promise.resolve(window.__subs), subs: arr,
  libraryScan: () => Promise.resolve(window.__lib), libraryList: arr,
  strategySnapshot: () => Promise.resolve({ defaults: [], learned: {} }), strategyVersion: () => Promise.resolve('test'),
  cookieInfo: () => Promise.resolve({}), pixivState: obj, wereadState: obj, asr: obj, engines: arr,
  asrModels: () => Promise.resolve({ models: [], current: '' }),
  loginState: () => Promise.resolve({}),
  settingsGet: () => Promise.resolve({ ui: { theme: 'light', accent: 'brand', layout: 'grid' } }),
  checkUpdate: obj, doUpdate: obj, refreshRules: obj,
  on: () => {}, once: () => {}, removeListener: () => {},
  openXhsWin: () => {}, openLogin: () => {}, openChannelsWin: () => {},
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
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(MOCK);
  await page.goto('file://' + path.resolve(__dirname, '../app/index.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.switchPage('tasks'));
  await page.waitForTimeout(600);
  const out = path.resolve(__dirname, '../评审材料/vf5-content/vf7-tasks-topbar.png');
  await page.screenshot({ path: out });
  console.log('SHOT', out);
  await browser.close();
})();
