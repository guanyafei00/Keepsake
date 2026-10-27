// QA 自研攻击/边界测试（Edward，RSS 订阅追更复核）：纯 node + 本地 http server
//   A. fetchFeed HTTP 边界：404 / 重定向链>5 / 302 跟随 / >20MB 截断
//   B. parseFeed 边界：Atom 旧式 <link>url</link>（无 href）/ RSS link CDATA / guid 大小写变体
//   C. checkSub 边界：known 500 滚动淘汰真实触发 / guid 变体跨轮判重 / RSS gone 判定确实跳过
//   D. 分流回归：article 8 站 + B站视频/Pixiv 不被 feed 模式截胡 / feed 子串混入文章 URL
// 运行：node tools/test-qa-edward-rss.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const subs = require('../lib/subs');
const identify = require('../lib/identify');

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>' +
  '<title>QA边界测试源</title><link>http://example.com/blog</link><description>t</description>';
function rssItem(guid, url, title) {
  return '<item><title>' + (title || ('条目 ' + guid)) + '</title>' +
    '<link>' + url + '</link><guid>' + guid + '</guid></item>';
}

(async () => {
  // ---- 本地服务器：HTTP 边界场景 ----
  const BIG = Buffer.alloc(21 * 1024 * 1024, 0x61);   // 21MB
  let hop = 0;   // 重定向链计数（每次请求 +1，直到 >5）
  const FEED_OK = XML_HEAD + rssItem('qa-1', 'http://example.com/qa-1') + '</channel></rss>';
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === '/404') { res.writeHead(404); res.end('not found'); return; }
    if (u === '/loop1') { res.writeHead(302, { Location: '/loop2' }); res.end(); return; }
    if (u === '/loop2') { res.writeHead(302, { Location: '/loop1' }); res.end(); return; }
    if (u === '/hop') { hop++; if (hop > 6) { res.writeHead(200, { 'Content-Type': 'application/rss+xml' }); res.end(FEED_OK); return; } res.writeHead(302, { Location: '/hop' }); res.end(); return; }
    if (u === '/big') { res.writeHead(200, { 'Content-Type': 'application/rss+xml' }); res.end(BIG); return; }
    if (u === '/moved') { res.writeHead(301, { Location: '/ok.rss' }); res.end(); return; }
    if (u === '/ok.rss') { res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' }); res.end(FEED_OK); return; }
    if (u === '/cdata.rss') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(XML_HEAD + '<item><title><![CDATA[CDATA链接条目]]></title>' +
        '<link><![CDATA[http://example.com/cdata-post?x=1&amp;y=2]]></link><guid>cdata-1</guid></item></channel></rss>');
      return;
    }
    if (u === '/case.rss') {
      // 同 URL 不同 guid 大小写变体（判重粒度探测）
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(XML_HEAD + rssItem('Post-GUID-A', 'http://example.com/same-post') +
        rssItem('post-guid-a', 'http://example.com/same-post') + '</channel></rss>');
      return;
    }
    if (u === '/atom-old.xml') {
      // Atom 旧式 <link>url</link>（无 href 属性、无 rel）——老博客确实存在这种写法
      res.writeHead(200, { 'Content-Type': 'application/atom+xml' });
      res.end('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>旧式Atom</title>' +
        '<entry><title>旧式条目</title><link>http://example.com/old-style-post</link><id>old-1</id></entry>' +
        '</feed>');
      return;
    }
    if (u === '/slide.rss') {
      // 滑出场景：feed 只保留最新 2 条（旧文 post-1 已滑出，基线时曾见 3 条）
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      res.end(XML_HEAD + rssItem('qa-2', 'http://example.com/qa-2') + rssItem('qa-3', 'http://example.com/qa-3') + '</channel></rss>');
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const B = 'http://127.0.0.1:' + server.address().port;

  // ---- A. fetchFeed HTTP 边界 ----
  try { await subs.fetchFeed(B + '/404'); report('A1 HTTP 404 拒绝', false, '未抛错'); }
  catch (e) { report('A1 HTTP 404 拒绝', /HTTP 404/.test(e.message), e.message); }

  try {
    const xml = await subs.fetchFeed(B + '/hop');
    report('A2 重定向链 6 跳内正常跟随', /qa-1/.test(xml), 'len=' + xml.length);
  } catch (e) { report('A2 重定向链 6 跳内正常跟随', false, e.message); }

  try { await subs.fetchFeed(B + '/loop1'); report('A3 死循环重定向拒绝(>5)', false, '未抛错'); }
  catch (e) { report('A3 死循环重定向拒绝(>5)', /跳转次数过多/.test(e.message), e.message); }

  try { await subs.fetchFeed(B + '/big'); report('A4 >20MB 截断中止', false, '未抛错'); }
  catch (e) { report('A4 >20MB 截断中止', /异常过大|20MB/.test(e.message), e.message); }

  try {
    const xml = await subs.fetchFeed(B + '/moved');
    report('A5 301 换域名跟随', /qa-1/.test(xml), '');
  } catch (e) { report('A5 301 换域名跟随', false, e.message); }

  // ---- B. parseFeed 边界 ----
  let items = subs.parseFeed(FEED_OK);
  report('B1 基础 RSS 解析', items.length === 1 && items[0].id === 'qa-1', JSON.stringify(items.map(i => i.id)));

  try {
    items = subs.parseFeed(
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>旧式Atom</title>' +
      '<entry><title>旧式条目</title><link>http://example.com/old-style-post</link><id>old-1</id></entry></feed>');
    // 实际行为记录：atomLink 只认 href 属性 → 旧式写法条目缺链接 → 诚实跳过
    report('B2 Atom 旧式 <link>url</link>（无 href）行为', items.length === 0,
      items.length ? '解析出 ' + items.length + ' 条' : '条目被诚实跳过（0 条，feed 报「没有可下载条目」）');
  } catch (e) {
    report('B2 Atom 旧式 <link>url</link>（无 href）行为', /没有可下载的文章条目/.test(e.message),
      '抛错: ' + e.message.slice(0, 60));
  }

  items = subs.parseFeed(XML_HEAD +
    '<item><title><![CDATA[CDATA链接条目]]></title><link><![CDATA[http://example.com/cdata-post?x=1&amp;y=2]]></link><guid>cdata-1</guid></item></channel></rss>');
  report('B3 RSS link CDATA + 实体', items.length === 1 && items[0].url === 'http://example.com/cdata-post?x=1&y=2',
    items.length ? items[0].url : '空');

  items = subs.parseFeed(XML_HEAD + rssItem('Post-GUID-A', 'http://example.com/same-post') +
    rssItem('post-guid-a', 'http://example.com/same-post') + '</channel></rss>');
  report('B4 guid 大小写变体按原样保留（判重粒度=精确匹配）', items.length === 2,
    'n=' + items.length + ' ids=' + items.map(i => i.id).join(','));

  // ---- C. checkSub 边界 ----
  subs.configure({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ks-rss-')), 'subs.json') });
  const r = subs.add(B + '/ok.rss', 'QA滚动测试');
  const sub = subs.get(r.sub.id);

  // C1: seenGuids 500 滚动淘汰真实触发——seed 600 个旧 id，本轮 1 条 fresh
  sub.checked = 1; sub.known = Array.from({ length: 600 }, (_, i) => 'old-' + String(i).padStart(4, '0'));
  let enq = [];
  let res = await subs.checkSub(sub, (s, it) => { enq.push(it.id); });
  report('C1 known 500 滚动：600+1 收敛 500', (sub.known || []).length === 500,
    'known=' + (sub.known || []).length);
  report('C1b fresh 入队 1 条', enq.length === 1 && enq[0] === 'qa-1', 'enq=' + enq.join(','));
  report('C1c 最老 id 被淘汰（old-0000..old-0100 出局）', !sub.known.includes('old-0000') && sub.known.includes('old-0101'),
    'old-0000 in known=' + sub.known.includes('old-0000'));

  // C2: 旧文滑出 feed 列表 → RSS 不产生删帖标记（gone 判定确实被跳过）
  sub.url = B + '/slide.rss';   // 切到只剩 2 条的 feed
  enq = [];
  res = await subs.checkSub(sub, (s, it) => { enq.push(it.id); });
  report('C2 滑出轮：gone=0（RSS 不判删帖）', res.ok && res.gone === 0 && sub.sourceDeleted === 0,
    'gone=' + res.gone + ' sourceDeleted=' + sub.sourceDeleted);
  report('C2b 滑出轮新条目正常入队（qa-2/qa-3 均为新）', enq.length === 2 && enq[0] === 'qa-2' && enq[1] === 'qa-3', 'enq=' + enq.join(','));
  report('C2c RSS 不维护 lastSeen', !sub.lastSeen || sub.lastSeen.length === 0,
    'lastSeen=' + (sub.lastSeen ? sub.lastSeen.length : 'undefined'));

  // C3: guid 大小写变体跨轮判重——基线记 Post-GUID-A，下轮 feed 只给 post-guid-a（同 URL）
  const r2 = subs.add(B + '/case.rss', 'QA变体测试');
  const sub2 = subs.get(r2.sub.id);
  await subs.checkSub(sub2, () => {});   // 基线：known = [Post-GUID-A, post-guid-a]
  // 伪造「上一轮基线只见过大写 guid」：手工收缩 known 模拟旧数据
  sub2.known = ['Post-GUID-A'];
  enq = [];
  res = await subs.checkSub(sub2, (s, it) => { enq.push(it.id); });
  report('C3 guid 大小写变体跨轮视为新条目（判重精确匹配）', enq.length === 1 && enq[0] === 'post-guid-a',
    'enq=' + enq.join(','));
  report('C3b 变体入队后 known 更新', sub2.known.includes('post-guid-a'), 'known=' + sub2.known.join(','));

  // ---- D. 分流回归 ----
  const artUrls = [
    ['https://mp.weixin.qq.com/s/abc123', 'article'],
    ['https://zhuanlan.zhihu.com/p/88888888', 'article'],
    ['https://www.zhihu.com/question/123456/answer/789012', 'article'],
    ['https://www.bilibili.com/read/cv1234567', 'article'],
    ['https://blog.csdn.net/user1/article/details/12345678', 'article'],
    ['https://www.cnblogs.com/user1/p/1234567.html', 'article'],
    ['https://juejin.cn/post/7123456789012345678', 'article'],
    ['https://sspai.com/post/88888', 'article'],
    ['https://www.jianshu.com/p/abcdef123456', 'article'],
  ];
  let allOk = true, bad = '';
  for (const [u, expect] of artUrls) {
    const c = identify.classify(u);
    if (c.engine !== expect) { allOk = false; bad += u + '→' + c.engine + ' '; }
  }
  report('D1 文章页 9 例仍识别为 article（不被 feed 模式截胡）', allOk, bad || 'all article');

  // B站视频 / Pixiv 图片 / YouTube 视频：feed 模式不得截胡，仍走原引擎
  const notFeed = [
    ['https://www.bilibili.com/video/BV1xx411c7mD', 'yt-dlp'],
    ['https://www.pixiv.net/artworks/12345678', 'gallery-dl'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'yt-dlp'],
  ];
  allOk = true; bad = '';
  for (const [u, expect] of notFeed) {
    const c = identify.classify(u);
    if (c.engine !== expect) { allOk = false; bad += u + '→' + c.engine + ' '; }
  }
  report('D2 B站视频/Pixiv/YouTube 不被 feed 模式截胡', allOk, bad || 'all original engines');

  // feed 子串混入文章 URL：ARTICLE_PATTERNS 优先于 FEED_PATTERNS
  const mixed = [
    ['https://blog.csdn.net/user1/article/details/12345678?feed=rss', 'article'],
    ['https://juejin.cn/post/7123456789012345678?rss=1', 'article'],
  ];
  allOk = true; bad = '';
  for (const [u, expect] of mixed) {
    const c = identify.classify(u);
    if (c.engine !== expect) { allOk = false; bad += u + '→' + c.engine + ' '; }
  }
  report('D3 带 feed 参数的文章 URL 仍判 article（判定顺序正确）', allOk, bad || 'all article');

  // feed 条目链接分流（engineForFeedItem = classify 直通 yt-dlp/gallery-dl/direct，其余 article）
  const feedItemRoutes = [
    ['https://www.youtube.com/watch?v=abc', 'yt-dlp'],
    ['https://www.bilibili.com/video/BV1abc', 'yt-dlp'],
    ['https://www.pixiv.net/artworks/1', 'gallery-dl'],
    ['https://blog.example.org/post-1', 'article'],
    ['https://mp.weixin.qq.com/s/xyz', 'article'],
  ];
  allOk = true; bad = '';
  for (const [u, expect] of feedItemRoutes) {
    const cls = identify.classify(u);
    const engine = (cls.engine === 'yt-dlp' || cls.engine === 'gallery-dl' || cls.engine === 'direct') ? cls.engine : 'article';
    if (engine !== expect) { allOk = false; bad += u + '→' + engine + ' '; }
  }
  report('D4 feed 条目链接分流映射正确（main.js engineForFeedItem 同规则）', allOk, bad || 'all routed');

  // 平台订阅 classify 优先级：B站/YouTube 用户页不被 isFeedUrl 抢走
  report('D5 B站UP主页 classify 仍为 bilibili', (subs.classify('https://space.bilibili.com/2267573') || {}).kind === 'bilibili', '');
  report('D6 YouTube频道 classify 仍为 youtube', (subs.classify('https://www.youtube.com/@somechannel') || {}).kind === 'youtube', '');
  report('D7 feed URL classify 为 rss', (subs.classify(B + '/ok.rss') || {}).kind === 'rss', '');
  report('D8 reddit .rss classify 为 rss（.rss 模式）', (subs.classify('https://www.reddit.com/r/foo.rss') || {}).kind === 'rss', '');

  // ---- E. 诚实边界文案 ----
  const idxHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
  report('E1 订阅卡「只追新」文案存在', idxHtml.includes('只追新'), '');
  report('E2 文案含不做删帖检测说明', idxHtml.includes('不做删帖检测'), '');

  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('[test] fatal:', e); process.exit(2); });
