// README 演示数据生成器：造一份体面的假订阅/任务/媒体库（screenshots/demo-userdata + demo-media）
// 用正常向知名账号（影视飓风/老饭骨/NASA/natgeo），绝不使用真实用户数据。跑一次即可，重跑会重置。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'screenshots');
const UD = path.join(ROOT, 'demo-userdata');
const MEDIA = path.join(ROOT, 'demo-media');
fs.mkdirSync(UD, { recursive: true });

const MIN = 60 * 1000;
const now = Date.now();

// settings.json：outDir 指向演示媒体目录
fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({
  outDir: MEDIA
}, null, 2));

// subs.json：4 个订阅（正常向知名账号），known 数组长度 = 已跟踪条数
let seq = 1;
function knownIds(n) { return Array.from({ length: n }, (_, i) => 'demo' + (seq++) + '_' + i); }
const subs = [
  { id: 'sub-ysfx', url: 'https://space.bilibili.com/946974', kind: 'bilibili', name: '影视飓风',
    lastCheck: now - 12 * MIN, known: knownIds(26), lastNew: 1, autoBackfill: true, createdAt: now - 30 * 24 * 3600 * 1000 },
  { id: 'sub-lfg', url: 'https://space.bilibili.com/37664244', kind: 'bilibili', name: '老饭骨',
    lastCheck: now - 35 * MIN, known: knownIds(18), createdAt: now - 20 * 24 * 3600 * 1000 },
  { id: 'sub-nasa', url: 'https://www.youtube.com/@NASA', kind: 'youtube', name: 'NASA',
    lastCheck: now - 48 * MIN, known: knownIds(9), createdAt: now - 15 * 24 * 3600 * 1000 },
  { id: 'sub-natgeo', url: 'https://x.com/natgeo', kind: 'x', name: 'natgeo',
    lastCheck: now - 25 * MIN, known: knownIds(14), createdAt: now - 10 * 24 * 3600 * 1000 }
];
fs.writeFileSync(path.join(UD, 'subs.json'), JSON.stringify(subs, null, 2));

// tasks.json：已完成的下载历史（分组名取自 title 的「[订阅回溯] X ·」或 uploader 字段）
let tid = 0;
function task(group, title, fileCount) {
  return { id: 't' + (++tid), title, status: 'done', progress: 100, fileCount: fileCount || 1,
    uploader: group, url: '', createdAt: now - 3600 * 1000, finishedAt: now - 1800 * 1000 };
}
const tasks = [
  task('影视飓风', '[订阅回溯] 影视飓风 · 【4K】我们造了一台能上网的天线.mp4'),
  task('影视飓风', '[订阅回溯] 影视飓风 · 【4K】把相机绑在无人机上穿过峡谷.mp4'),
  task('影视飓风', '[订阅回溯] 影视飓风 · 2026 年度旗舰手机影像横评.mp4'),
  task('老饭骨', '[订阅回溯] 老饭骨 · 家常红烧肉，肥而不腻的诀窍.mp4'),
  task('老饭骨', '[订阅回溯] 老饭骨 · 一只鸡的十种吃法（上）.mp4'),
  task('NASA', '[订阅回溯] NASA · Artemis II mission overview.mp4'),
  task('NASA', '[订阅回溯] NASA · To the Moon and Mars - 2026 update.mp4'),
  task('natgeo', '[订阅回溯] natgeo · Photo of the Day 精选合集.jpg', 6)
];
fs.writeFileSync(path.join(UD, 'tasks.json'), JSON.stringify(tasks, null, 2));

// 演示媒体文件：dummy 字节（媒体库只 stat 大小/时间，不读内容）
function dummy(dir, name, mb) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.alloc(Math.round(mb * 1024 * 1024), 7);
  fs.writeFileSync(path.join(dir, name), buf);
}
const F = (rel) => path.join(MEDIA, rel);
// bilibili
dummy(F('bilibili/影视飓风'), '【4K】我们造了一台能上网的天线 [BV1demo1].mp4', 62);
dummy(F('bilibili/影视飓风'), '【4K】把相机绑在无人机上穿过峡谷 [BV1demo2].mp4', 48);
dummy(F('bilibili/影视飓风'), '2026 年度旗舰手机影像横评 [BV1demo3].mp4', 55);
dummy(F('bilibili/老饭骨'), '家常红烧肉，肥而不腻的诀窍 [BV1demo4].mp4', 30);
dummy(F('bilibili/老饭骨'), '一只鸡的十种吃法（上） [BV1demo5].mp4', 27);
// youtube
dummy(F('youtube/NASA'), 'Artemis II mission overview [demoid1].mp4', 40);
dummy(F('youtube/NASA'), 'To the Moon and Mars - 2026 update [demoid2].mp4', 35);
// twitter
for (let i = 1; i <= 6; i++) dummy(F('twitter/natgeo'), '195000000012345678' + i + '_1.jpg', 2.5);
for (let i = 1; i <= 4; i++) dummy(F('twitter/nasa'), '196000000098765432' + i + '_1.jpg', 3.2);
// pixiv
for (let i = 1; i <= 8; i++) dummy(F('pixiv/wlop'), '插画精选_' + String(i).padStart(2, '0') + '.png', 4.5);

let total = 0;
for (const [site, ups] of Object.entries({})) {}
console.log('DEMO-DATA-OK');
console.log('userData:', UD);
console.log('media  :', MEDIA);
