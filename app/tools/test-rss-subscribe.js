// QA 离线单测：RSS 订阅追更（feed 拉取/解析/增量/分流，全部纯 node + 本地 http server）
// 运行：node tools/test-rss-subscribe.js
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
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }

// ---- 测试 feed 内容（可动态追加 item 模拟站点更新）----
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel>' +
  '<title>测试博客</title><link>http://example.com/blog</link><description>测试用</description>';
function rssItem(i, title) {
  return '<item><title><![CDATA[' + title + ']]></title>' +
    '<link>http://example.com/blog/post-' + i + '</link>' +
    '<guid isPermaLink="false">post-guid-' + i + '</guid>' +
    '<pubDate>Mon, 0' + ((i % 9) + 1) + ' Mar 2026 08:00:00 GMT</pubDate></item>';
}
let extraRssItem = '';
const FEEDS = {
  '/feed.rss': () => XML_HEAD + rssItem(1, '第一篇 &amp; 实体标题') + rssItem(2, '第二篇') + rssItem(3, '第三篇') + extraRssItem + '</channel></rss>',
  '/feed.atom': () => '<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">' +
    '<title>Atom 测试源</title><id>urn:uuid:feed</id><updated>2026-03-01T00:00:00Z</updated>' +
    '<entry><title type="html"><![CDATA[Atom 第一篇]]></title>' +
    '<link rel="self" href="http://example.com/a/1-self"/><link rel="alternate" href="http://example.com/a/1"/>' +
    '<id>urn:uuid:entry-1</id><updated>2026-03-01T00:00:00Z</updated></entry>' +
    '<entry><title>Atom 第二篇 &lt;b&gt;实体&lt;/b&gt;</title>' +
    '<link href="http://example.com/a/2"/><id>urn:uuid:entry-2</id><updated>2026-03-02T00:00:00Z</updated></entry>' +
    '</feed>',
  '/broken.rss': () => '<rss version="2.0"><channel><title>截断的',   // 损坏 XML
  '/page.html': () => '<!DOCTYPE html><html><head><title>普通网页</title></head><body><p>不是 feed</p></body></html>',
  '/guidonly.rss': () => XML_HEAD +
    '<item><title>guid 即链接</title><guid>http://example.com/blog/post-perma</guid></item>' +
    '</channel></rss>',
};
const server = http.createServer((req, res) => {
  const f = FEEDS[req.url.split('?')[0]];
  if (f) { res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' }); res.end(f()); return; }
  res.writeHead(404); res.end('nope');
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const B = 'http://127.0.0.1:' + server.address().port;

  // ---- ① parseFeed 单元：CDATA / 实体 / guid permalink / Atom 多 link / 重复 guid 去重 ----
  let its = subs.parseFeed(FEEDS['/feed.rss']());
  report('RSS 解析出 3 个条目', its.length === 3, 'n=' + its.length);
  report('CDATA 标题 + 实体解码', its[0].text === '第一篇 & 实体标题', its[0].text);
  report('条目字段完整(type=feed)', its[0].type === 'feed' && its[0].url === 'http://example.com/blog/post-1' && its[0].id === 'post-guid-1');
  report('feed 标题提取', its.feedTitle === '测试博客', its.feedTitle);

  its = subs.parseFeed(FEEDS['/feed.atom']());
  report('Atom 解析出 2 个条目', its.length === 2, 'n=' + its.length);
  report('Atom 取 rel=alternate 链接（跳过 rel=self）', its[0].url === 'http://example.com/a/1', its[0].url);
  report('Atom 实体解码', its[1].text === 'Atom 第二篇 <b>实体</b>', its[1].text);
  report('Atom feed 标题', its.feedTitle === 'Atom 测试源', its.feedTitle);

  its = subs.parseFeed(FEEDS['/guidonly.rss']());
  report('guid permalink 兑底为链接', its.length === 1 && its[0].url === 'http://example.com/blog/post-perma', its[0] && its[0].url);

  const dup = subs.parseFeed('<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>' +
    rssItem(1, 'a') + rssItem(1, 'a-重复') + '</channel></rss>');
  report('同 guid 重复条目去重', dup.length === 1, 'n=' + dup.length);

  let threw = '';
  try { subs.parseFeed(FEEDS['/page.html']()); } catch (e) { threw = e.message; }
  report('HTML 页误当 feed → 人话报错', /不是有效的 RSS\/Atom feed/.test(threw), threw.slice(0, 50));

  // ---- ② checkSub 全流程：首检基线 → 增量入队 → 损坏 XML 计失败 ----
  subs.configure({ binDir: '.', cookiePath: path.join(os.tmpdir(), 'nope.txt'), file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ks-rss-')), 'subs.json') });

  const a = subs.add(B + '/feed.rss');
  report('feed URL 识别为 rss 订阅', a.ok && a.sub.kind === 'rss', JSON.stringify(a.ok ? a.sub.kind : a));
  report('添加即有 URL 兜底名（_auto）', a.sub._auto === true && a.sub.name === '127.0.0.1', a.sub.name);
  const s1 = subs.get(a.sub.id);
  const enq1 = [];
  const r1 = await subs.checkSub(s1, (s, it) => { enq1.push(it); return true; });
  report('首检基线：只记录不入队（3 条全量入库）', r1.ok && s1.known.length === 3 && enq1.length === 0,
    'known=' + s1.known.length + ' enq=' + enq1.length);
  report('首检后 feed 标题认领订阅名', s1.name === '测试博客' && s1._auto === false, s1.name);
  report('RSS 不产生删帖标记', !s1.sourceDeleted, String(s1.sourceDeleted));

  extraRssItem = rssItem(4, '第四篇（新）');
  const enq2 = [];
  const r2 = await subs.checkSub(s1, (s, it) => { enq2.push(it); return true; });
  report('feed 加新条目 → 只新条目入队', r2.ok && r2.fresh === 1 && enq2.length === 1 && enq2[0].id === 'post-guid-4',
    'fresh=' + r2.fresh + ' enq=' + enq2.length);
  report('新条目记录进 known', s1.known.length === 4 && s1.lastNew === 1, 'known=' + s1.known.length);

  extraRssItem = rssItem(5, '第五篇（队列去重场景）');
  let rechecked = 0;
  await subs.checkSub(s1, () => { rechecked++; return false; });   // 模拟队列同 URL 已存在
  const enq3 = [];
  const r3 = await subs.checkSub(s1, (s, it) => { enq3.push(it); return true; });
  report('onNew=false 不记 known，下轮仍重查', rechecked === 1 && enq3.length === 1 && enq3[0].id === 'post-guid-5',
    'rechecked=' + rechecked + ' enq=' + enq3.length);

  const sItem = { id: 'x', type: 'feed', text: 't', url: 'http://example.com/blog/post-1' };
  report('itemUrl 返回条目文章链接', subs.itemUrl(s1, sItem) === 'http://example.com/blog/post-1', subs.itemUrl(s1, sItem));

  const ab = subs.add(B + '/broken.rss');
  const s2 = subs.get(ab.sub.id);
  let errMsg = '';
  try { await subs.checkSub(s2, () => true); } catch (e) { errMsg = e.message; }
  report('损坏 XML → 检查抛错（人话）', !/CDATA|<[a-z]/i.test(errMsg) && errMsg.length > 0, errMsg.slice(0, 60));
  report('损坏 XML 不动 known/checked', (s2.known || []).length === 0 && s2.checked === 0, 'known=' + (s2.known || []).length);

  const ah = subs.add(B + '/page.html');
  report('普通网页不能添加为 RSS 订阅', !ah.ok, ah.ok ? '误收了' : String(ah.reason).slice(0, 40));

  // ---- ③ identify/订阅分流回归：文章页不误伤 + feed 命中 ----
  const ARTICLE_URLS = [
    'https://mp.weixin.qq.com/s/abcDEF123',
    'https://www.bilibili.com/read/cv1234567',
    'https://zhuanlan.zhihu.com/p/123456789',
    'https://www.zhihu.com/question/123456/answer/789012',
    'https://blog.csdn.net/user/article/details/123456',
    'https://www.cnblogs.com/someone/p/12345678.html',
    'https://juejin.cn/post/7123456789012345678',
    'https://sspai.com/post/65666',
    'https://www.jianshu.com/p/abcdef123456',
    'https://blog.csdn.net/user/article/details/123456?utm_source=rss',   // 文章页带 feed 相关参数也不误伤
  ];
  let okArt = true, badArt = '';
  for (const u of ARTICLE_URLS) {
    const e = identify.classify(u).engine;
    if (e !== 'article') { okArt = false; badArt = u + ' → ' + e; break; }
  }
  report('文章页 10 例全部仍识别为 article', okArt, badArt);

  const FEED_URLS = [
    'https://www.ruanyifeng.com/blog/atom.xml',
    'https://example.com/feed/',
    'https://example.com/feed',
    'https://example.com/rss/',
    'https://example.com/atom',
    'https://example.com/feed.xml',
    'https://example.com/rss.xml',
    'https://example.com/atom.xml',
    'https://example.com/index.xml',
    'https://example.com/blog/?feed=rss2',
    'https://example.com/?rss=1',
    'https://feeds.feedburner.com/someone',
    'https://someblog.blogspot.com/feeds/posts/default',
    'https://www.reddit.com/r/programming/.rss',
  ];
  let okFeed = true, badFeed = '';
  for (const u of FEED_URLS) {
    const c = subs.classify(u);
    if (!c || c.kind !== 'rss' || identify.classify(u).engine !== 'feed') { okFeed = false; badFeed = u + ' → ' + JSON.stringify(c) + '/' + identify.classify(u).engine; break; }
  }
  report('feed URL 14 例全部命中（订阅=rss / 识别=feed）', okFeed, badFeed);

  // ---- ④ 真实 feed 回归：阮一峰博客 atom.xml（需联网）----
  try {
    const real = await subs.fetchFeedItems('https://www.ruanyifeng.com/blog/atom.xml');
    // 该 feed 实测只保留最近 3 条（2026-10 拉取确认），断言按此校准；字段完整性 + 标题是硬性要求
    const okReal = real.length >= 3 && real.every(it => /^https?:\/\//.test(it.url) && it.id && it.text)
      && !!real.feedTitle;
    report('真实 feed（阮一峰 atom.xml）解析', okReal,
      'n=' + real.length + ' title=' + real.feedTitle + ' first=' + (real[0] && real[0].url || '').slice(0, 60));
  } catch (e) {
    report('真实 feed（阮一峰 atom.xml）解析', false, String(e.message).slice(0, 80));
  }

  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('[test] fatal:', e); process.exit(2); });
