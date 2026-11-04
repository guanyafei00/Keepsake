// QA 离线单测：公众号订阅追更（M-A5，微信读书接口路线）
// 全部纯 node：纯函数矩阵/转换/节流闸 + subs.js 注入式 stub（setWereadFetcher）+ 本地 http server。
// 运行：node tools/test-weread-subscribe.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const weread = require('../lib/weread');
const subs = require('../lib/subs');
const identify = require('../lib/identify');
const settings = require('../lib/settings');

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail !== undefined ? ' | ' + detail : ''));
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }

// ---- 本地 feed server（非 weread 对照组用：update 白名单需要一条普通 rss 订阅）----
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>对照博客</title>' +
  '<item><title>A</title><link>http://example.com/a1</link><guid>g1</guid></item>' +
  '</channel></rss>';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
  res.end(XML);
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const B = 'http://127.0.0.1:' + server.address().port;

  // ===== ① 失效判定矩阵 isExpiredSignal（2026-11 收窄：HTML 只认登录页特征，404/风控页不误报过期）=====
  report('失效·302 重定向', weread.isExpiredSignal(302, '') === true);
  report('失效·301 重定向', weread.isExpiredSignal(301, '{"errCode":0}') === true);
  report('失效·登录页文案 HTML', weread.isExpiredSignal(200, '<html><body>扫码登录，同步你的微信读书</body></html>') === true);
  report('失效·登录路由特征 HTML', weread.isExpiredSignal(200, '<script>location.replace("https://weread.qq.com/#login")</script>') === true);
  report('失效·errCode -2012', weread.isExpiredSignal(200, '{"errCode":-2012,"data":{}}') === true);
  report('失效·errCode -2013', weread.isExpiredSignal(200, '{"errCode":-2013}') === true);
  report('失效·errCode -2010（缺登录态/用户不存在）', weread.isExpiredSignal(200, '{"errCode":-2010}') === true);
  report('非失效·errCode -2041（风控/旧 Cookie）', weread.isExpiredSignal(200, '{"errCode":-2041}') === false);
  report('非失效·404 HTML 页（端点不存在/改版）不误判', weread.isExpiredSignal(404, '<html><head><title>404 Not Found</title></head><body>page not found</body></html>') === false);
  report('非失效·风控页 HTML 不误判', weread.isExpiredSignal(200, '<html>当前操作存在风险，请稍后再试</html>') === false);
  report('非失效·普通业务页 HTML 不误判', weread.isExpiredSignal(200, '<html><title>微信读书</title><div>书架</div></html>') === false);
  report('非失效·errCode 0', weread.isExpiredSignal(200, '{"errCode":0,"data":{"ok":1}}') === false);
  report('非失效·其他业务码', weread.isExpiredSignal(200, '{"errCode":-1}') === false);
  report('非失效·空 body', weread.isExpiredSignal(200, '') === false);
  report('非失效·空白 body', weread.isExpiredSignal(200, '  \n ') === false);
  report('非失效·半截 JSON', weread.isExpiredSignal(200, '{"errCode":-2012') === false);
  report('非失效·200+合法JSON+429码位不介入', weread.isExpiredSignal(429, '{"errCode":0}') === false);
  report('错误码集合·-2010 入失效 / -2041 入风控', weread.EXPIRED_CODES.has(-2010) === true && weread.RISK_CODES.has(-2041) === true);
  report('端点·articles 拼 bookId+offset', weread.ENDPOINTS.articles('MP_WXS_3930750813', 20) === 'https://weread.qq.com/web/mp/articles?bookId=MP_WXS_3930750813&offset=20');
  report('端点·四个 404 死链已删', !weread.ENDPOINTS.mpSearch && !weread.ENDPOINTS.mpSubscribe && !weread.ENDPOINTS.articleList && !weread.ENDPOINTS.renewal);

  // ===== ② bizToBookId / articleToken / extractBiz =====
  // 社区情报公式：bookId = 'MP_WXS_' + base64_decode(__biz)，解码结果必须是纯数字串
  report('bizToBookId·标准 padding', weread.bizToBookId('MzkzMDc1MDgxMw==') === 'MP_WXS_3930750813');
  report('bizToBookId·缺 padding 自动补 =', weread.bizToBookId('MzkzMDc1MDgxMw') === 'MP_WXS_3930750813');
  report('bizToBookId·urldecode 后解码', weread.bizToBookId('MzkzMDc1MDgxMw%3D%3D') === 'MP_WXS_3930750813');
  report('bizToBookId·含空白去空白', weread.bizToBookId(' MzkzMDc1MDgxMw== ') === 'MP_WXS_3930750813');
  report('bizToBookId·非数字解码原样回落', weread.bizToBookId('MzA4abc==') === 'MzA4abc==');
  report('bizToBookId·空值→null', weread.bizToBookId('') === null && weread.bizToBookId(null) === null);
  report('articleToken·originalId 整链剥前缀', weread.articleToken('https://mp.weixin.qq.com/s/AbCd1234?x=1', 'R') === 'AbCd1234');
  report('articleToken·reviewId 末段回落', weread.articleToken(null, 'MP_WXS_3930750813_TokenB2') === 'TokenB2');
  report('articleToken·两者皆坏→null', weread.articleToken('!!!', 'MP_WXS_1_!bad') === null);
  report('extractBiz·base64 含等号', weread.extractBiz('https://mp.weixin.qq.com/s?__biz=MzA4abc123==&mid=22&idx=1&sn=x') === 'MzA4abc123==');
  report('extractBiz·无 __biz → null', weread.extractBiz('https://mp.weixin.qq.com/s/xyz') === null);
  // 2026-11 真实短链页实测：URL 上无 __biz，页内 var biz 可抓；链接容错见下一节
  report('extractBiz·&amp; 还原', weread.extractBiz('https://mp.weixin.qq.com/s?mid=1&amp;__biz=MzIyMzA5NjEyMA==&amp;idx=1') === 'MzIyMzA5NjEyMA==');
  report('extractBiz·值 urldecode %3D%3D', weread.extractBiz('https://mp.weixin.qq.com/s?__biz=MzIyMzA5NjEyMA%3D%3D') === 'MzIyMzA5NjEyMA==');
  report('extractBiz·fragment 内参数', weread.extractBiz('https://mp.weixin.qq.com/s/T9_acg247gxzUNL4j5zrCw#?__biz=MzIyMzA5NjEyMA==') === 'MzIyMzA5NjEyMA==');
  report('extractBiz·biz 别名', weread.extractBiz('https://mp.weixin.qq.com/s?biz=MzIyMzA5NjEyMA==') === 'MzIyMzA5NjEyMA==');
  report('extractBiz·短链无参数→null（不编造 biz）', weread.extractBiz('https://mp.weixin.qq.com/s/T9_acg247gxzUNL4j5zrCw') === null);

  // ===== ③ /web/mp/articles reviews 结构 → feed 条目（type:'feed' 复用 onNew 分流）=====
  // reviews[].subReviews[].review.{ reviewId, mpInfo.{ title, originalId } }；originalId 缺失回落 reviewId 末段
  const REV = {
    reviews: [
      { subReviews: [
        { review: { reviewId: 'MP_WXS_3930750813_TokenA1', mpInfo: { title: '第一篇', originalId: 'ShortLinkA1' } } },
        { review: { reviewId: 'MP_WXS_3930750813_TokenB2', mpInfo: { title: '第二篇' } } },
      ] },
      { review: { reviewId: 'MP_WXS_3930750813_!bad', mpInfo: { title: '坏 token' } } },   // 无 originalId 且尾段非法
      { review: { mpInfo: { title: '无 reviewId 应过滤' } } },
    ],
  };
  report('解析·reviews/subReviews/review 三级结构', weread.flattenReviews(REV).length === 3);
  const feed = weread.articleListToFeedItems(REV);
  report('解析·产出 3 条（无 reviewId 被过滤）', feed.length === 3, 'n=' + feed.length);
  report('解析·id=reviewId / type=feed', feed[0].id === 'MP_WXS_3930750813_TokenA1' && feed[0].type === 'feed');
  report('解析·originalId → 短链', feed[0].url === 'https://mp.weixin.qq.com/s/ShortLinkA1', feed[0].url);
  report('解析·originalId 缺失回落 reviewId 尾段', feed[1].url === 'https://mp.weixin.qq.com/s/TokenB2', feed[1].url);
  report('解析·token 皆取不到 url=null（不拼坏链）', feed[2].url === null, String(feed[2].url));
  report('解析·标题取 mpInfo.title', feed[0].text === '第一篇');
  report('解析·超长标题截断 80', weread.articleListToFeedItems({ reviews: [{ subReviews: [{ review: { reviewId: 'R_LongTitle1', mpInfo: { title: 'x'.repeat(200), originalId: 'Long1' } } }] }] })[0].text.length === 80);
  report('解析·容器回落 data.reviews', weread.articleListToFeedItems({ data: { reviews: REV.reviews } }).length === 3);
  report('解析·容器回落顶层数组', weread.articleListToFeedItems(REV.reviews).length === 3);
  report('解析·无 reviews → 空', weread.articleListToFeedItems({ foo: 1 }).length === 0);
  report('解析·sub_reviews 别名回落', weread.articleListToFeedItems({ reviews: [{ sub_reviews: [{ reviewId: 'R_Alias1', mpInfo: { originalId: 'Alias1' } }] }] })[0].url === 'https://mp.weixin.qq.com/s/Alias1');

  // ===== ③b cover 主路径 + fetchForSub 注入式依赖（假响应，不真发网络请求）=====
  // 真实 Cookie 实测：cover 200 返回最新一篇；articles 当前 -2041 风控 → 必须静默回退，不能拖垮首检
  const COVER = {
    name: '绿联NAS私有云', title: '绿联NAS不止能存文件，还能写长篇小说？',
    reviewId: 'MP_WXS_3930750813_kNBdCP0jjYXc0Bq9IKfb~w', pic: 'https://x/p.jpg', avatar: '', template: 0,
  };
  const ci = weread.coverToFeedItem(COVER);
  report('cover·产出 1 条 feed', ci.type === 'feed' && ci.id === COVER.reviewId);
  report('cover·短链拼对（reviewId 的 ~ 还原为 _）', ci.url === 'https://mp.weixin.qq.com/s/kNBdCP0jjYXc0Bq9IKfb_w', ci.url);
  report('cover·title 原样', ci.text === COVER.title);
  report('cover·超长 title 截断 80', weread.coverToFeedItem({ reviewId: 'R_TokenX1', title: 'x'.repeat(200) }).text.length === 80);
  report('cover·无 token → url=null（不拼坏链）', weread.coverToFeedItem({ reviewId: 'R_!bad', title: 'x' }).url === null);
  report('cover·缺 reviewId → id 为空（调用方判不可用）', weread.coverToFeedItem({ title: 'x' }).id === '');
  report('articleToken·reviewId 末段 ~ 还原 _', weread.articleToken(null, COVER.reviewId) === 'kNBdCP0jjYXc0Bq9IKfb_w');
  report('articleToken·真实短链号 ~ 还原 _', weread.articleToken(null, 'MP_WXS_3223096120_T9~acg247gxzUNL4j5zrCw') === 'T9_acg247gxzUNL4j5zrCw');
  report('articleToken·originalId 带 ~ 原样保留', weread.articleToken('Tok~en1', 'R_X') === 'Tok~en1');
  report('articleToken·危险字符仍全拒', weread.articleToken(null, 'R_!bad') === null && weread.articleToken('javascript:alert(1)', 'R_X') === null);
  report('cover·真实短链号 url 可打开', weread.coverToFeedItem({ name: '数字生命卡兹克', title: '开源…', reviewId: 'MP_WXS_3223096120_T9~acg247gxzUNL4j5zrCw' }).url === 'https://mp.weixin.qq.com/s/T9_acg247gxzUNL4j5zrCw');

  const SUB = { mpId: 'MP_WXS_3930750813' };
  // articles -2041 → 静默回退，只留 cover 1 条；且确实按「先 cover 后 articles」试过一次
  {
    const calls = [];
    const fake = async url => {
      calls.push(url);
      if (url.includes('/api/mp/cover')) return { ok: true, data: COVER };
      return { ok: false, expired: false, reason: '读书接口暂时拒绝请求，稍后再试（HTTP 200 | JSON | weread.qq.com/web/mp/articles）' };
    };
    const items = await weread.fetchForSub(SUB, 1, fake);
    report('fetchForSub·articles -2041 静默回退 cover', items.length === 1 && items[0].url === ci.url, 'n=' + items.length);
    report('fetchForSub·先 cover 后 articles', calls.length === 2 && calls[0].includes('/api/mp/cover') && calls[1].includes('/web/mp/articles'), calls.join(' → '));
  }
  // articles 成功 → 叠加，按 id 去重且 cover 优先；第二页空即停，不盲翻 5 页
  {
    const HISTORY = { reviews: [
      { subReviews: [{ review: { reviewId: COVER.reviewId, mpInfo: { title: '重复的最新一篇', originalId: 'DupToken1' } } }] },
      { subReviews: [{ review: { reviewId: 'MP_WXS_3930750813_OldArt22', mpInfo: { title: '旧文', originalId: 'OldArt22' } } }] },
    ] };
    let calls = 0;
    const fake = async url => {
      calls++;
      if (url.includes('/api/mp/cover')) return { ok: true, data: COVER };
      return calls <= 2 ? { ok: true, data: HISTORY, errCode: 0 } : { ok: true, data: { reviews: [] }, errCode: 0 };
    };
    const items = await weread.fetchForSub(SUB, 5, fake);
    report('fetchForSub·articles 成功叠加且 cover 优先去重', items.length === 2 && items[0].id === COVER.reviewId && items[1].url === 'https://mp.weixin.qq.com/s/OldArt22', 'n=' + items.length);
    report('fetchForSub·空页即停不盲翻', calls === 3, 'calls=' + calls);
  }
  // articles 非 200 / 请求抛异常 → 一律静默，cover 结果照常返回
  {
    const fake = async url => url.includes('/api/mp/cover') ? { ok: true, data: COVER } : { ok: false, expired: false, reason: '读书接口请求失败（HTTP 404 | HTML 页 | weread.qq.com/web/mp/articles）' };
    const items = await weread.fetchForSub(SUB, 3, fake);
    report('fetchForSub·articles 404 静默回退', items.length === 1, 'n=' + items.length);
  }
  {
    const fake = async url => { if (url.includes('/api/mp/cover')) return { ok: true, data: COVER }; throw new Error('网络断'); };
    const items = await weread.fetchForSub(SUB, 3, fake);
    report('fetchForSub·articles 抛异常也静默', items.length === 1, 'n=' + items.length);
  }
  // 严格区分 !r.ok：只有 expired 才抛带 wereadExpired 的错；cover 普通失败才按普通失败抛
  {
    let err = null;
    const fake = async url => url.includes('/api/mp/cover') ? { ok: true, data: COVER } : { ok: false, expired: true, reason: '微信读书登录已过期，请重新扫码（HTTP 200 | JSON | weread.qq.com/web/mp/articles）' };
    try { await weread.fetchForSub(SUB, 1, fake); } catch (e) { err = e; }
    report('fetchForSub·articles 真失效透传 wereadExpired', !!err && err.wereadExpired === true, err && err.message);
  }
  {
    let err = null;
    try { await weread.fetchForSub(SUB, 1, async () => ({ ok: false, expired: true, reason: '微信读书登录已过期，请重新扫码（HTTP 200 | JSON | weread.qq.com/api/mp/cover）' })); } catch (e) { err = e; }
    report('fetchForSub·cover 失效抛 wereadExpired', !!err && err.wereadExpired === true, err && err.message);
  }
  {
    let err = null;
    try { await weread.fetchForSub(SUB, 1, async () => ({ ok: false, expired: false, reason: '读书接口请求失败（HTTP 404 | HTML 页 | weread.qq.com/api/mp/cover）' })); } catch (e) { err = e; }
    report('fetchForSub·cover 普通失败抛错带诊断尾巴', !!err && !err.wereadExpired && /（HTTP \d+ \|/.test(err.message), err && err.message);
  }
  {
    let err = null;
    try { await weread.fetchForSub(SUB, 1, async () => ({ ok: false, expired: false, reason: '自定义无诊断' })); } catch (e) { err = e; }
    report('fetchForSub·注入 reason 无尾巴时自动补', !!err && /（HTTP 0 \| 空 body \|/.test(err.message), err && err.message);
  }
  {
    let err = null;
    try { await weread.fetchForSub(SUB, 1, async () => ({ ok: true, data: { title: '无 id' } })); } catch (e) { err = e; }
    report('fetchForSub·cover 缺 reviewId 不产出空 id 条目', !!err, err && err.message);
  }

  // ===== ③c 短链页元数据 / host 白名单 / weread:add 降级切片（注入假响应，不真发网络）=====
  // 主人真实短链 https://mp.weixin.qq.com/s/T9_acg247gxzUNL4j5zrCw 的页内形态（带凭证实测）
  const SHORT_URL = 'https://mp.weixin.qq.com/s/T9_acg247gxzUNL4j5zrCw';
  const PAGE = [
    '<html><head><script>',
    'var biz = "MzIyMzA5NjEyMA==";',
    'var user_name = "gh_94dba26f8ca0";',
    "var msg_title = '开源我这折腾了1年的「Agent自动化系统」'.html(false);",
    'nickname = htmlDecode("数字生命卡兹克");',
    '</script></head><body></body></html>',
  ].join('\n');
  {
    let called = 0;
    const meta = await weread.fetchArticleMeta(SHORT_URL, async () => { called++; return PAGE; });
    report('fetchArticleMeta·页内 var biz', !!meta && meta.biz === 'MzIyMzA5NjEyMA==', meta && meta.biz);
    report('fetchArticleMeta·nickname = htmlDecode(...)', !!meta && meta.nickname === '数字生命卡兹克', meta && meta.nickname);
    report('fetchArticleMeta·一次请求同时拿两值', called === 1, 'calls=' + called);
    // 白名单：非 https / 非 mp.weixin.qq.com 域一律不发请求直接 null（防主进程内网探测）
    const bad = [
      ['http 内网', 'http://127.0.0.1/?__biz=MzIyMzA5NjEyMA=='],
      ['外部域 https', 'https://evil.com/s?__biz=MzIyMzA5NjEyMA=='],
      ['ftp 协议', 'ftp://mp.weixin.qq.com/s/T9_acg247gxzUNL4j5zrCw'],
      ['同前缀伪造域', 'https://mp.weixin.qq.com.evil.com/s/x?__biz=MzIyMzA5NjEyMA=='],
      ['userinfo 混淆', 'https://mp.weixin.qq.com@127.0.0.1/s/x'],
      ['非 URL', 'not a url'],
    ];
    for (const [label, u] of bad) {
      let n = 0;
      const r = await weread.fetchArticleMeta(u, async () => { n++; return PAGE; });
      report('白名单·' + label + ' 不发请求返回 null', r === null && n === 0, 'calls=' + n);
    }
    let n = 0;
    const subOK = await weread.fetchArticleMeta('https://img.mp.weixin.qq.com/s/x', async () => { n++; return PAGE; });
    report('白名单·mp.weixin.qq.com 子域放行', !!subOK && subOK.biz === 'MzIyMzA5NjEyMA==' && n === 1);
    // 纯解析函数：三种 biz 形态 + 严格格式 + 昵称老形态
    report('extractBizFromHtml·var biz', weread.extractBizFromHtml('var biz = "MzIyMzA5NjEyMA==";') === 'MzIyMzA5NjEyMA==');
    report('extractBizFromHtml·window.biz', weread.extractBizFromHtml('window.biz = "MzIyMzA5NjEyMA=="') === 'MzIyMzA5NjEyMA==');
    report('extractBizFromHtml·"__biz":"..."', weread.extractBizFromHtml('{"__biz":"MzIyMzA5NjEyMA=="}') === 'MzIyMzA5NjEyMA==');
    report('extractBizFromHtml·非 Mz 开头不认（不编造）', weread.extractBizFromHtml('var biz = "hello world"') === null);
    report('extractNicknameFromHtml·老形态仍兼容', weread.extractNicknameFromHtml('var nickname = "旧号";') === '旧号' && weread.extractNicknameFromHtml('"nick_name":"旧号2"') === '旧号2');
    report('extractNicknameFromHtml·无闭合引号兜底', weread.extractNicknameFromHtml('nickname = htmlDecode("数字生命卡兹克"') === '数字生命卡兹克');
    // weread:add 短链降级切片：URL 无 __biz → 页内 biz → bookId（不真起 Electron）
    report('weread:add·短链降级切片（extractBiz→meta.biz→bizToBookId）',
      weread.extractBiz(SHORT_URL) === null && !!meta && weread.bizToBookId(meta.biz) === 'MP_WXS_3223096120', meta && meta.biz);
    report('weread:add·拿不到 biz 的人话提示', /请在微信里打开/.test(weread.NO_BIZ_REASON) && /复制链接/.test(weread.NO_BIZ_REASON));
    // cover 真名挂在返回数组上，不破坏数组契约
    const items = await weread.fetchForSub({ mpId: 'MP_WXS_3223096120' }, 1, async url => url.includes('/api/mp/cover')
      ? { ok: true, data: { name: '数字生命卡兹克', title: '开源…', reviewId: 'MP_WXS_3223096120_T9~acg247gxzUNL4j5zrCw' } }
      : { ok: false, reason: '读书接口暂时拒绝请求，稍后再试（HTTP 200 | JSON | weread.qq.com/web/mp/articles）' });
    report('fetchForSub·cover 真名挂 mpName 且仍是数组', Array.isArray(items) && items.length === 1 && items.mpName === '数字生命卡兹克');
  }

  // ===== ④ 节流闸 createThrottleGate =====
  // 串行保序：三个任务按提交顺序完成
  {
    const gate = weread.createThrottleGate(10);
    const order = [];
    await Promise.all([
      gate.run(async () => { order.push(1); }),
      gate.run(async () => { order.push(2); }),
      gate.run(async () => { order.push(3); }),
    ]);
    report('节流·串行保序', order.join(',') === '1,2,3', order.join(','));
  }
  // 最小间隔：第二次执行起始距第一次起始 ≥ minGapMs
  {
    const GAP = 60;
    const gate = weread.createThrottleGate(GAP);
    const t0 = Date.now();
    await gate.run(() => {});
    await gate.run(() => {});
    const elapsed = Date.now() - t0;
    report('节流·两次执行间隔 ≥ minGap', elapsed >= GAP - 5, elapsed + 'ms (gap=' + GAP + ')');
  }
  // 注入时钟：now 可替换（离线可测性契约）
  {
    let fake = 1000;
    const gate = weread.createThrottleGate(60000, () => fake);
    await gate.run(() => 'x');
    fake = 2000;   // 只推进 1s < 60s：wait>0 分支被走到（不真睡——用极小真实等待不可行，此处只验契约不抛错且最终完成）
    const v = await gate.run(() => 'y');
    report('节流·注入时钟生效（完成且不抛错）', v === 'y');
  }

  // ===== ⑤ subs.addWeread 组装 / 查重 / intervalMin 强制 =====
  subs.configure({ binDir: '.', cookiePath: path.join(os.tmpdir(), 'nope.txt'), file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ks-weread-')), 'subs.json') });
  subs.setWereadFetcher(null);   // 先拆注入：未就绪路径可测
  const aw = subs.addWeread({ mpId: 'mpTest1', biz: 'BIZ1', url: 'https://mp.weixin.qq.com/s?__biz=BIZ1', name: '测试公众号' });
  report('addWeread·组装成功', aw.ok && aw.sub.kind === 'weread' && aw.sub.mpId === 'mpTest1');
  report('addWeread·intervalMin 强制 30', aw.ok && aw.sub.intervalMin === 30, String(aw.sub && aw.sub.intervalMin));
  report('addWeread·biz/url 落档', aw.ok && aw.sub.biz === 'BIZ1' && aw.sub.url !== null);
  const dup = subs.addWeread({ mpId: 'mpTest1', name: '重复' });
  report('addWeread·mpId 查重拒绝', dup.ok === false && /已在订阅中/.test(dup.reason), dup.reason);
  const nomp = subs.addWeread({});
  report('addWeread·缺 mpId 拒绝', nomp.ok === false && /mpId/.test(nomp.reason), nomp.reason);
  const anon = subs.addWeread({ mpId: 'mpTest2' });
  report('addWeread·无名兜底名', anon.ok && /^(公众号|订阅)/.test(anon.sub.name), anon.sub.name);

  // ===== ⑥ subs.update intervalMin 白名单（weread 收紧到 [30,60]）=====
  const wereadId = aw.sub.id;
  subs.update(wereadId, { intervalMin: 10 });
  report('update·weread 拒绝 10 分钟档', subs.get(wereadId).intervalMin === 30, String(subs.get(wereadId).intervalMin));
  subs.update(wereadId, { intervalMin: 15 });
  report('update·weread 拒绝非白名单值', subs.get(wereadId).intervalMin === 30);
  subs.update(wereadId, { intervalMin: 60 });
  report('update·weread 允许 60 分钟档', subs.get(wereadId).intervalMin === 60);
  subs.update(wereadId, { intervalMin: 30 });
  report('update·weread 允许 30 分钟档', subs.get(wereadId).intervalMin === 30);
  // 非 weread 对照组：rss 订阅仍可用 10 分钟档
  const rssAdd = subs.add(B + '/feed.rss');
  assert(rssAdd.ok, 'rss 对照订阅添加失败: ' + (rssAdd.reason || ''));
  subs.update(rssAdd.sub.id, { intervalMin: 10 });
  report('update·rss 不受收紧影响（10 分钟档仍可用）', subs.get(rssAdd.sub.id).intervalMin === 10);

  // ===== ⑦ checkSub 注入 stub fetcher：基线 / 增量 / 失效抛错 / 未就绪 =====
  const wsub = subs.get(wereadId);
  try {
    await subs.checkSub(wsub, () => true);
    report('checkSub·未注入 fetcher 报未就绪', false, '未抛错');
  } catch (e) {
    report('checkSub·未注入 fetcher 报未就绪', /未就绪/.test(e.message) && !e.wereadExpired, e.message);
  }
  const mk = (id, title) => ({ id, type: 'feed', text: title, url: 'https://mp.weixin.qq.com/s?__biz=BIZ&mid=1&idx=1&sn=' + id });   // 与真实 fetchForSub 输出契约一致（articleListToFeedItems 转换后形态）
  // 统一 stub wrapper：所有注入都经此计数/记页，避免单个 stub 漏记
  let stubCalls = 0;
  let stubPages = [];
  function useStub(fn) { subs.setWereadFetcher((sub, pages) => { stubCalls++; stubPages.push(pages); return fn(sub, pages); }); }
  const old1 = mk('old1', '旧文一'), old2 = mk('old2', '旧文二'), old3 = mk('old3', '旧文三'), nw1 = mk('new1', '新文章');
  useStub(() => Promise.resolve([old1, old2, old3]));
  const enq0 = [];
  const r1 = await subs.checkSub(wsub, (s, it) => { enq0.push(it); return true; });
  report('checkSub·首检建基线 ok', r1.ok && r1.total === 3 && r1.fresh === 3, 'fresh=' + r1.fresh);
  report('checkSub·基线只记录不下载', enq0.length === 0, 'enq=' + enq0.length);
  report('checkSub·基线 known=3', (subs.get(wereadId).known || []).length === 3);
  report('checkSub·weread 不维护 lastSeen（无 gone 判定）', subs.get(wereadId).lastSeen === undefined);
  report('checkSub·weread 无删帖误报', r1.gone === 0);
  // 增量：新 1 条 + 旧 2 条
  useStub(() => Promise.resolve([nw1, old1, old2]));
  const enq1 = [];
  const r2 = await subs.checkSub(wsub, (s, it) => { enq1.push(it); return true; });
  report('checkSub·增量识别 1 条新文章', r2.ok && r2.fresh === 1 && enq1.length === 1, 'fresh=' + r2.fresh);
  report('checkSub·增量条目自带 mp.weixin 链接', enq1.length === 1 && /mp\.weixin\.qq\.com/.test(enq1[0].url || ''), enq1[0] && enq1[0].url);
  report('checkSub·条目 type=feed（复用 article 分流）', enq1.length === 1 && enq1[0].type === 'feed');
  report('checkSub·lastNew=1', subs.get(wereadId).lastNew === 1);
  report('checkSub·stub 收到 pages=1（增量只看首页窗口）', stubCalls >= 2 && stubPages[stubPages.length - 1] === 1, 'pages=' + stubPages.join(','));
  // 失效抛错：e.wereadExpired 标记透传（main 据此跳过 failStreak）
  useStub(() => {
    const err = new Error('微信读书登录已过期，请重新扫码');
    err.wereadExpired = true;
    return Promise.reject(err);
  });
  try {
    await subs.checkSub(wsub, () => true);
    report('checkSub·失效错误透传', false, '未抛错');
  } catch (e) {
    report('checkSub·失效错误透传', e.wereadExpired === true && /过期/.test(e.message), e.message);
  }
  // 普通错误：不带失效标记（走常规 failStreak 路径）
  useStub(() => Promise.reject(new Error('读书接口请求失败')));
  try {
    await subs.checkSub(wsub, () => true);
    report('checkSub·普通错误无失效标记', false, '未抛错');
  } catch (e) {
    report('checkSub·普通错误无失效标记', !e.wereadExpired, e.message);
  }
  report('itemUrl·weread 分支', subs.itemUrl(wsub, { url: 'https://mp.weixin.qq.com/s/k' }) === 'https://mp.weixin.qq.com/s/k' && subs.itemUrl(wsub, {}) === null);

  // ===== ⑧ backfill weread 分支：限 5 页 =====
  useStub((sub, pages) => Promise.resolve([mk('b1', '回1'), mk('b2', '回2'), mk('b3', '回3'), mk('b4', '回4')]));
  const bItems = [];
  const rb = await subs.backfill(wereadId, (s, it) => { bItems.push(it); });
  report('backfill·weread 5 页上限入参', stubPages[stubPages.length - 1] === 5, 'pages=' + stubPages[stubPages.length - 1]);
  report('backfill·全部条目入队', rb.ok === undefined && bItems.length === 4 && rb.total === 4 && rb.media === 4, 'total=' + rb.total);
  report('backfill·条目链接可解析', bItems.every(i => /mp\.weixin\.qq\.com/.test(subs.itemUrl(wsub, i) || '')));

  // ===== ⑨ settings.wereadEnabled 开关 =====
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-weread-set-'));
  settings.configure({ file: path.join(tdir, 'settings.json'), defaultOutDir: path.join(tdir, 'out') });
  report('settings·wereadEnabled 默认开', settings.get().wereadEnabled === true);
  settings.set({ wereadEnabled: false });
  report('settings·wereadEnabled 可关', settings.get().wereadEnabled === false);
  settings.set({ wereadEnabled: 'x' });
  report('settings·wereadEnabled 布尔归一化', settings.get().wereadEnabled === true);

  // ===== ⑩ classify 不自动识别 weread（只做不说：无 weread 分类暴露）=====
  const mpUrl = 'https://mp.weixin.qq.com/s?__biz=MzA4abc==&mid=22&idx=1&sn=9f3ab';
  const cls = identify.classify(mpUrl);
  report('classify·公众号文章走 article 引擎', cls && cls.engine === 'article', cls && cls.engine);
  report('classify·不产生 weread 类型', !cls || cls.kind !== 'weread', cls && cls.kind);
  const sc = subs.classify(mpUrl);
  report('subs.classify·公众号链接不作为常规订阅源', !sc || sc.kind !== 'weread', sc && sc.kind);

  // ===== ⑪ checkSub 认领 cover 真名（items.mpName + _auto 兜底名）=====
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-weread-name-'));
    subs.configure({ binDir: dir, cookiePath: path.join(dir, 'c.txt'), file: path.join(dir, 'subs.json') });
    const added = subs.addWeread({ mpId: 'MP_WXS_3223096120', url: 'https://mp.weixin.qq.com/s/T9_acg247gxzUNL4j5zrCw' });
    report('显示名·无昵称时 _auto URL 兜底名', added.ok && added.sub._auto === true && /^公众号 · /.test(added.sub.name), added.sub && added.sub.name);
    subs.setWereadFetcher(async () => {
      const out = [{ id: 'MP_WXS_3223096120_T9~acg247gxzUNL4j5zrCw', type: 'feed', text: '开源…', url: 'https://mp.weixin.qq.com/s/T9_acg247gxzUNL4j5zrCw' }];
      out.mpName = '数字生命卡兹克';   // 挂属性，不改数组返回契约
      return out;
    });
    await subs.checkSub(subs.get(added.sub.id), () => true);
    const after = subs.get(added.sub.id);
    report('显示名·cover 真名认领自动兜底名', after.name === '数字生命卡兹克' && after._auto === false, after.name);
    // 用户手起的名不被覆盖
    const manual = subs.addWeread({ mpId: 'MP_WXS_3930750813', url: 'https://mp.weixin.qq.com/s/kNBdCP0jjYXc0Bq9IKfb_w', name: '我自己起的名字' });
    await subs.checkSub(subs.get(manual.sub.id), () => true);
    report('显示名·用户手起的名不被 cover 覆盖', subs.get(manual.sub.id).name === '我自己起的名字', subs.get(manual.sub.id).name);
  }

  server.close();
  console.log('----');
  console.log('TOTAL: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('[test] fatal:', e); try { server.close(); } catch (e2) {} process.exit(2); });
