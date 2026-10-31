// #32 离线单测：本土三平台（视频号/小红书/抖音）识别分流 + 探针契约 + 无水印解析 + 路径拼装
// 纯 node 运行（不启 electron）：node tools/test-china-platforms-unit.js
const path = require('path');
const assert = require('assert');
const identify = require('../lib/identify');
const dp = require('../lib/directprobe');

let pass = 0, fail = 0;
const tests = [];
function t(name, fn) { tests.push({ name, fn }); }

// ---- identify 分流 ----
t('小红书 explore 笔记页 → direct', () => {
  assert.strictEqual(identify.classify('https://www.xiaohongshu.com/explore/65f0abc0000000001234?xsec_token=AbC&xsec_path=S').engine, 'direct');
});
t('小红书 discovery/item 笔记页 → direct', () => {
  assert.strictEqual(identify.classify('https://www.xiaohongshu.com/discovery/item/65f0abc0000000001234').engine, 'direct');
});
t('小红书分享短链 xhslink → direct', () => {
  assert.strictEqual(identify.classify('http://xhslink.com/a1B2c3').engine, 'direct');
});
t('小红书主站非笔记页不放行（用户主页/搜索页不误入 direct）', () => {
  assert.notStrictEqual(identify.classify('https://www.xiaohongshu.com/user/profile/5ff0e6410000000001008400').engine, 'direct');
});
t('抖音视频页 → direct', () => {
  assert.strictEqual(identify.classify('https://www.douyin.com/video/7351234567890123456').engine, 'direct');
});
t('抖音分享短链 v.douyin.com → direct', () => {
  assert.strictEqual(identify.classify('https://v.douyin.com/iRNBho6u/').engine, 'direct');
});
t('快手 → direct', () => {
  assert.strictEqual(identify.classify('https://v.kuaishou.com/abcXYZ').engine, 'direct');
});
t('视频号链接 → 引导受控浏览器（不再是「手机端保存」旧话术）', () => {
  const c = identify.classify('https://channels.weixin.qq.com/platform/post/123456');
  assert.strictEqual(c.engine, 'invalid');
  assert.ok(/视频号/.test(c.reason), 'reason 应提到视频号: ' + c.reason);
  assert.ok(/受控浏览器/.test(c.reason), 'reason 应引导受控浏览器: ' + c.reason);
  assert.ok(/归档/.test(c.reason), 'reason 应提到归档: ' + c.reason);
});
t('B 站视频不受新增规则影响 → yt-dlp', () => {
  assert.strictEqual(identify.classify('https://www.bilibili.com/video/BV1xx411c7mD').engine, 'yt-dlp');
});
t('B 站专栏不受影响 → article', () => {
  assert.strictEqual(identify.classify('https://www.bilibili.com/read/cv12345678').engine, 'article');
});
t('Pixiv 不受影响 → gallery-dl', () => {
  assert.strictEqual(identify.classify('https://www.pixiv.net/users/123').engine, 'gallery-dl');
});

// ---- directprobe 契约与纯解析 ----
t('probe 无 electron（纯 node 环境）→ { ok:false, error } 契约', async () => {
  const r = await dp.probe('https://www.douyin.com/video/123', { electron: null });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error, '应携带 error 文案');
});
t('siteOf 站点识别', () => {
  assert.strictEqual(dp.siteOf('https://v.douyin.com/iAbc/'), 'douyin');
  assert.strictEqual(dp.siteOf('https://www.douyin.com/video/1'), 'douyin');
  assert.strictEqual(dp.siteOf('https://www.xiaohongshu.com/explore/1'), 'xiaohongshu');
  assert.strictEqual(dp.siteOf('http://xhslink.com/abc'), 'xiaohongshu');
  assert.strictEqual(dp.siteOf('https://www.kuaishou.com/short-video/x'), 'kuaishou');
  assert.strictEqual(dp.siteOf('https://example.com/'), 'direct');
});
t('vidOf 内容 ID 提取', () => {
  assert.strictEqual(dp.vidOf('https://www.douyin.com/video/7351234567890'), '7351234567890');
  assert.strictEqual(dp.vidOf('https://www.xiaohongshu.com/explore/65f0abc'), '65f0abc');
  assert.strictEqual(dp.vidOf('https://www.kuaishou.com/short-video/xyz-9'), 'xyz-9');
  assert.strictEqual(dp.vidOf('https://example.com/'), null);
});
t('小红书 __INITIAL_STATE__ 解析：视频笔记选最高码率 mp4', () => {
  const state = { note: { currentNoteId: '65f0abc', noteDetailMap: { '65f0abc': { note: {
    noteId: '65f0abc', title: '测试笔记', desc: '描述文本', user: { nickname: '作者甲' },
    video: { media: { videoStream: [
      { masterUrl: 'https://sns-video-hw.xhscdn.com/stream/a.m3u8', videoBitrate: 500 },
      { masterUrl: 'https://sns-video-hw.xhscdn.com/stream/b.mp4', videoBitrate: 1200 },
      { masterUrl: 'https://sns-video-hw.xhscdn.com/stream/c.mp4', videoBitrate: 3000 },
    ] } },
  } } } } };
  const r = dp.parseXhsState(state);
  assert.ok(r, '应解析成功');
  assert.strictEqual(r.kind, 'video');
  assert.strictEqual(r.url, 'https://sns-video-hw.xhscdn.com/stream/c.mp4');
  assert.strictEqual(r.title, '测试笔记');
  assert.strictEqual(r.uploader, '作者甲');
  assert.strictEqual(r.vid, '65f0abc');
});
t('小红书解析：图文笔记 urlDefault 无水印优先 + livePhoto 取静态高清', () => {
  const state = { note: { currentNoteId: 'n2', noteDetailMap: { n2: { note: {
    noteId: 'n2', title: '图文笔记', user: { nickname: '作者乙' },
    imageList: [
      { urlDefault: 'https://sns-img-hw.xhscdn.com/a_hd.jpg' },
      { livePhoto: true, urlDefault: 'https://x/live.jpg', infoList: [
        { imageScene: 'WB_PRV', url: 'https://x/prv.jpg' },
        { imageScene: 'WB_DFT', url: 'https://x/dft.jpg' },
      ] },
      { infoList: [{ imageScene: 'WB_DFT', url: 'https://x/dup.jpg' }] },
      { infoList: [{ imageScene: 'WB_DFT', url: 'https://x/dup.jpg' }] },   // 重复图去重
    ],
  } } } } };
  const r = dp.parseXhsState(state);
  assert.ok(r);
  assert.strictEqual(r.kind, 'images');
  assert.deepStrictEqual(r.urls, ['https://sns-img-hw.xhscdn.com/a_hd.jpg', 'https://x/dft.jpg', 'https://x/dup.jpg']);
  assert.strictEqual(r.uploader, '作者乙');
});
t('小红书解析：坏数据/空数据返回 null 不抛错', () => {
  assert.strictEqual(dp.parseXhsState(null), null);
  assert.strictEqual(dp.parseXhsState({}), null);
  assert.strictEqual(dp.parseXhsState({ note: {} }), null);
  assert.strictEqual(dp.parseXhsState({ note: { noteDetailMap: { x: {} } } }), null);
});
t('pickXhsImage：无任何可用字段返回 null', () => {
  assert.strictEqual(dp.pickXhsImage(null), null);
  assert.strictEqual(dp.pickXhsImage({}), null);
});

// ---- 路径拼装（归档目录规范）----
t('视频路径 {outDir}/{site}/{uploader}/{title} [vid].mp4', () => {
  const p = dp.directOutPath({ outDir: 'D:\\Out', site: 'douyin', uploader: '作者甲', title: '标题*1', vid: '735123' });
  assert.strictEqual(p, path.join('D:\\Out', 'douyin', '作者甲', '标题 1 [735123].mp4'));
});
t('图文路径目录 {outDir}/{site}/{uploader}/{title} [vid]（无扩展名）', () => {
  const p = dp.directOutPath({ outDir: 'D:\\Out', site: 'xiaohongshu', uploader: '作者乙', title: '图文', vid: 'n2', kind: 'images' });
  assert.strictEqual(p, path.join('D:\\Out', 'xiaohongshu', '作者乙', '图文 [n2]'));
});
t('作者为空回落「未分类作者」（媒体库二级归拢不散落）', () => {
  const p = dp.directOutPath({ outDir: 'D:\\Out', site: 'weixin_channels', uploader: '', title: '标题', vid: 'v1' });
  assert.strictEqual(p, path.join('D:\\Out', 'weixin_channels', '未分类作者', '标题 [v1].mp4'));
});
t('标题为空用 vid 兜底；vid 缺失不加后缀', () => {
  const p1 = dp.directOutPath({ outDir: 'D:\\Out', site: 'douyin', uploader: 'u', title: '', vid: '9' });
  assert.strictEqual(p1, path.join('D:\\Out', 'douyin', 'u', '9 [9].mp4'));
  const p2 = dp.directOutPath({ outDir: 'D:\\Out', site: 'douyin', uploader: 'u', title: 't', vid: null });
  assert.strictEqual(p2, path.join('D:\\Out', 'douyin', 'u', 't.mp4'));
});
t('sanitizeName 非法字符清洗与长度截断', () => {
  assert.strictEqual(dp.sanitizeName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
  assert.strictEqual(dp.sanitizeName(''), 'video');
  assert.strictEqual(dp.sanitizeName('x'.repeat(100)).length, 80);
});

// ---- 队列图组文件名编号约定（与 _downloadDirectImages 对齐的纯逻辑）----
t('图组文件名两位编号 + 扩展名跟随直链', () => {
  const urls = ['https://x/a.jpg', 'https://x/b.png?x-oss-process=1', 'https://x/c'];
  const names = urls.map((u, i) => String(i + 1).padStart(2, '0') + '.' + ((String(u).match(/\.(jpe?g|png|webp|gif|bmp|avif)(\?|$)/i) || [])[1] || 'jpg'));
  assert.deepStrictEqual(names, ['01.jpg', '02.png', '03.jpg']);
});

(async () => {
  for (const { name, fn } of tests) {
    try { await fn(); pass++; console.log('PASS | ' + name); }
    catch (e) { fail++; console.log('FAIL | ' + name + ' | ' + (e && e.message)); }
  }
  console.log('----');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
