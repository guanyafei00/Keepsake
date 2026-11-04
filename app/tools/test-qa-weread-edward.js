// QA 独立补充单测（Edward）：M-A5 公众号追更——针对工程师自测未覆盖的边界
// 重点：① 节流闸并发 10 次真串行 + 最小间隔（注入时钟，零真实等待）
//       ② 失效矩阵误判面（空 body/半截 JSON/网络错误/字符串 errCode）
//       ③ /web/mp/articles reviews 结构解析 + bizToBookId 公式 + 不拼坏链
//       ④ subs.js 注入式依赖下 RSS 零回归 + weread 异常不污染其他订阅
// 运行：node tools/test-qa-weread-edward.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const weread = require('../lib/weread');
const subs = require('../lib/subs');
const settings = require('../lib/settings');

// 本地 RSS 对照服务器（避免真实网络依赖：example.com 会真发请求且返回 404）
const RSS_XML = '<?xml version="1.0"?><rss version="2.0"><channel><title>对照</title>' +
  '<item><title>A</title><link>http://127.0.0.1:1/a</link><guid>qa-g1</guid></item></channel></rss>';
const rssServer = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/rss+xml' }); res.end(RSS_XML); });

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail !== undefined ? ' | ' + detail : ''));
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }

(async () => {
  await new Promise(r => rssServer.listen(0, '127.0.0.1', r));
  const RSS_URL = 'http://127.0.0.1:' + rssServer.address().port + '/feed.xml';
  // ===== ① 节流闸：并发 10 次仍串行保序 + 最小间隔生效（注入时钟）=====
  {
    let clock = 0;
    const gate = weread.createThrottleGate(1000, () => clock);
    const order = [];
    const starts = [];
    const fns = [];
    for (let i = 0; i < 10; i++) {
      fns.push(gate.run(async () => {
        order.push(i);
        starts.push(clock);
        clock += 1000;   // 每次执行后时钟前进 1s → 下一次 wait 恰好为 0，零真实延时
        return i;
      }));
    }
    const results = await Promise.all(fns);
    assert(order.join(',') === '0,1,2,3,4,5,6,7,8,9', '顺序错: ' + order.join(','));
    assert(results.join(',') === '0,1,2,3,4,5,6,7,8,9', '返回值错');
    let gapsOk = true;
    for (let i = 1; i < starts.length; i++) {
      if (starts[i] - starts[i - 1] < 1000) gapsOk = false;   // 任意两次起始间隔 ≥ minGap
    }
    report('节流闸·并发10次串行保序', order.join(',') === '0,1,2,3,4,5,6,7,8,9');
    report('节流闸·任意两次起始间隔≥minGap', gapsOk, starts.join(','));
    report('节流闸·默认闸间隔=60s', weread.MIN_GAP_MS === 60 * 1000);
  }
  // 节流闸：前一个 fn 抛错不堵塞后续（链自愈）
  {
    let clock = 0;
    const gate = weread.createThrottleGate(10, () => { clock += 10; return clock; });
    let secondRan = false;
    await gate.run(async () => { throw new Error('boom'); }).then(() => {}, () => {});
    await gate.run(async () => { secondRan = true; });
    report('节流闸·前次抛错链不断', secondRan);
  }

  // ===== ② 失效矩阵误判面（工程师 10 例之外的补充边界）=====
  report('失效·null body 不误判', weread.isExpiredSignal(200, null) === false);
  report('失效·纯空白 body 不误判', weread.isExpiredSignal(200, '   \n ') === false);
  report('失效·errCode 字符串 "-2012" 识别', weread.isExpiredSignal(200, '{"errCode":"-2012"}') === true);
  report('失效·errCode 浮点 -2012.0 识别', weread.isExpiredSignal(200, '{"errCode":-2012.0}') === true);
  report('非失效·非 JSON 文本（网关报错页）不误判', weread.isExpiredSignal(200, 'Gateway Timeout') === false);
  report('非失效·errCode -201 相近码不误伤', weread.isExpiredSignal(200, '{"errCode":-201}') === false);
  report('非失效·半截 JSON+2012 前缀不误判', weread.isExpiredSignal(200, '{"errCode":-20121') === false);
  report('失效·307 不在重定向矩阵内（按设计只认 301/302）', weread.isExpiredSignal(307, '{}') === false);
  report('非失效·null statusCode+JSON 不误判', weread.isExpiredSignal(null, '{"errCode":0}') === false);
  report('失效·errCode -2010（缺登录态）', weread.isExpiredSignal(200, '{"errCode":"-2010"}') === true);
  report('非失效·errCode -2041（风控）', weread.isExpiredSignal(200, '{"errCode":"-2041"}') === false);
  report('非失效·风控页 HTML 不误判', weread.isExpiredSignal(200, '<html><body>404 Not Found</body></html>') === false);

  // ===== ③ /web/mp/articles reviews 结构 + bizToBookId（2026-11 端点校准后）=====
  {
    const R = (id, title, originalId) => ({ reviewId: id, mpInfo: { title, originalId } });
    // 容器逐级回落：reviews / data / items / list / 顶层数组
    for (const k of ['reviews', 'data', 'items', 'list']) {
      const items = weread.articleListToFeedItems({ [k]: [{ subReviews: [{ review: R('MP_WXS_1_TokenX1', '标题', 'TokenX1') }] }] });
      report('feedItems·容器字段回落 ' + k, items.length === 1 && items[0].id === 'MP_WXS_1_TokenX1');
    }
    const noArr = weread.articleListToFeedItems({ foo: 1 });
    report('feedItems·无可识别容器→空', noArr.length === 0);
    const bare = weread.articleListToFeedItems({ reviews: [{ subReviews: [{ review: { reviewId: 'MP_WXS_1_TokenB1' } }] }] });
    report('feedItems·缺 mpInfo 兜底空标题 + reviewId 尾段短链', bare.length === 1 && bare[0].text === '' && bare[0].url === 'https://mp.weixin.qq.com/s/TokenB1' && bare[0].type === 'feed');
    const noId = weread.articleListToFeedItems({ reviews: [{ review: { mpInfo: { title: '无 id' } } }] });
    report('feedItems·无 reviewId 条目过滤', noId.length === 0);
    const badToken = weread.articleListToFeedItems({ reviews: [{ review: { reviewId: 'MP_WXS_1_!bad' } }] });
    report('feedItems·坏 token→url=null（不拼坏链）', badToken.length === 1 && badToken[0].url === null);
    const numId = weread.articleListToFeedItems({ reviews: [{ review: { reviewId: 42, mpInfo: { originalId: 'Tok42' } } }] });
    report('feedItems·数字 reviewId 归一为字符串', numId[0].id === '42');
    const longTitle = weread.articleListToFeedItems({ reviews: [{ review: R('R_Long1', 'x'.repeat(200), 'Long1') }] });
    report('feedItems·超长标题截断 80', longTitle[0].text.length === 80);
    report('flattenReviews·原始条数计入 offset', weread.flattenReviews({ reviews: [{ subReviews: [{ review: R('A_T1', 'a', 'T1') }, { review: R('B_T2', 'b', 'T2') }] }] }).length === 2);
    // bookId 公式：'MP_WXS_' + base64_decode(__biz)；解不出纯数字原样回落
    report('bizToBookId·标准/缺 padding/urldecode', weread.bizToBookId('MzkzMDc1MDgxMw==') === 'MP_WXS_3930750813' && weread.bizToBookId('MzkzMDc1MDgxMw') === 'MP_WXS_3930750813' && weread.bizToBookId('MzkzMDc1MDgxMw%3D%3D') === 'MP_WXS_3930750813');
    report('bizToBookId·非数字解码原样回落', weread.bizToBookId('MzA4abc==') === 'MzA4abc==');
    report('bizToBookId·空值→null', weread.bizToBookId(null) === null && weread.bizToBookId('') === null);
    report('articleToken·整链剥前缀/末尾回落', weread.articleToken('https://mp.weixin.qq.com/s/Tok9?x=1', 'R') === 'Tok9' && weread.articleToken(null, 'MP_WXS_1_Tok8') === 'Tok8');
    report('articleToken·实测 token 含 ~ 放行', weread.articleToken(null, 'MP_WXS_3930750813_kNBdCP0jjYXc0Bq9IKfb~w') === 'kNBdCP0jjYXc0Bq9IKfb~w');
    report('extractBiz·biz 后无参数截断', weread.extractBiz('https://mp.weixin.qq.com/s?__biz=ABC') === 'ABC');
    report('extractBiz·空串→null', weread.extractBiz('') === null);
    // cover 主路径（真实 Cookie 实测形态：无 errCode 字段，只有最新一篇）
    const COVER = { name: '绿联NAS私有云', title: '绿联NAS不止能存文件，还能写长篇小说？', reviewId: 'MP_WXS_3930750813_kNBdCP0jjYXc0Bq9IKfb~w', pic: 'https://x/p.jpg', template: 0 };
    const c1 = weread.coverToFeedItem(COVER);
    report('cover·1 条 feed + id/type/text', c1.id === COVER.reviewId && c1.type === 'feed' && c1.text === COVER.title);
    report('cover·短链拼对（~ 保留）', c1.url === 'https://mp.weixin.qq.com/s/kNBdCP0jjYXc0Bq9IKfb~w', c1.url);
    report('cover·超长标题截断 80', weread.coverToFeedItem({ reviewId: 'R_Tok88', title: 'x'.repeat(200) }).text.length === 80);
    report('cover·无 token→url=null', weread.coverToFeedItem({ reviewId: 'R_!bad' }).url === null);
    report('cover·非对象/空数据不抛错', weread.coverToFeedItem(null).id === '' && weread.coverToFeedItem({}).url === null);
  }

  // ===== ③b fetchForSub 注入式依赖：articles 风控静默回退（不真发网络请求）=====
  {
    const SUB = { mpId: 'MP_WXS_3930750813' };
    const COVER = { reviewId: 'MP_WXS_3930750813_kNBdCP0jjYXc0Bq9IKfb~w', title: '最新一篇' };
    let calls = 0;
    const fake = async url => {
      calls++;
      if (url.includes('/api/mp/cover')) return { ok: true, data: COVER };
      return { ok: false, expired: false, reason: '读书接口暂时拒绝请求，稍后再试（HTTP 200 | JSON | weread.qq.com/web/mp/articles）' };
    };
    const items = await weread.fetchForSub(SUB, 5, fake);
    report('fetchForSub·-2041 静默且只打一次 articles', items.length === 1 && calls === 2, 'n=' + items.length + ' calls=' + calls);
    report('fetchForSub·回退结果仍是 cover 短链', items[0] && items[0].url === 'https://mp.weixin.qq.com/s/kNBdCP0jjYXc0Bq9IKfb~w', items[0] && items[0].url);
    let err = null;
    try { await weread.fetchForSub(SUB, 1, async () => ({ ok: false, expired: true, reason: '微信读书登录已过期，请重新扫码（HTTP 200 | JSON | weread.qq.com/api/mp/cover）' })); } catch (e) { err = e; }
    report('fetchForSub·cover 失效才抛 wereadExpired', !!err && err.wereadExpired === true, err && err.message);
  }

  // ===== ④ subs.js 注入式依赖：RSS 零回归 + weread 隔离 =====
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-weread-'));
    subs.configure({ binDir: dir, cookiePath: path.join(dir, 'c.txt'), file: path.join(dir, 'subs.json') });
    settings.configure({ file: path.join(dir, 'settings.json'), defaultOutDir: dir });

    // RSS 路径不依赖 weread fetcher：先不注入，RSS 照常工作
    subs.setWereadFetcher(null);
    const rss = subs.add(RSS_URL, '对照RSS');
    assert(rss.ok, 'rss add 失败');
    let rssErr = null;
    try { const r = await subs.checkSub(subs.get(rss.sub.id), () => {}); assert(r.ok, 'rss checkSub 失败: ' + r.reason); }
    catch (e) { rssErr = e; }
    report('RSS·未注入 weread fetcher 仍零回归', !rssErr, rssErr && rssErr.message);

    // weread 订阅在 fetcher 未注入时显式报错（普通错误，可计 failStreak——合理）
    const wr = subs.addWeread({ mpId: 'MP1', name: '测试号' });
    report('addWeread·intervalMin 强制 30', wr.ok && subs.get(wr.sub.id).intervalMin === 30);
    let wrNoFetcherErr = null;
    try { await subs.checkSub(subs.get(wr.sub.id), () => {}); } catch (e) { wrNoFetcherErr = e; }
    report('weread·fetcher 未注入→显式错误', !!wrNoFetcherErr && !wrNoFetcherErr.wereadExpired, wrNoFetcherErr && wrNoFetcherErr.message);

    // fetcher 抛 e.wereadExpired：标志原样透传（main catch 依赖此标志跳过 failStreak）
    subs.setWereadFetcher(async () => {
      const e = new Error('微信读书登录已过期，请重新扫码');
      e.wereadExpired = true;
      throw e;
    });
    let expErr = null;
    try { await subs.checkSub(subs.get(wr.sub.id), () => {}); } catch (e) { expErr = e; }
    report('weread·失效标志经 checkSub 原样透传', !!expErr && expErr.wereadExpired === true);

    // 失效抛错后 RSS 订阅不受污染（同一 checkSub 链路串行跑 RSS 仍正常）
    let rssErr2 = null;
    try { const r = await subs.checkSub(subs.get(rss.sub.id), () => {}); assert(r.ok); } catch (e) { rssErr2 = e; }
    report('RSS·weread 失效异常后自身无污染', !rssErr2, rssErr2 && rssErr2.message);

    // update 白名单：weread 拒 10 分钟档，收 30/60；RSS 同字段不受影响
    const wrId = wr.sub.id, rssId = rss.sub.id;
    const r1 = subs.update(wrId, { intervalMin: 10 });
    report('update·weread 10 分钟档被拒', r1.ok && subs.get(wrId).intervalMin === 30);
    subs.update(wrId, { intervalMin: 60 });
    report('update·weread 60 分钟档接受', subs.get(wrId).intervalMin === 60);
    subs.update(wrId, { intervalMin: 999 });
    report('update·weread 非法档保持原值', subs.get(wrId).intervalMin === 60);
    subs.update(rssId, { intervalMin: 10 });
    report('update·RSS 10 分钟档不受 weread 白名单牵连', subs.get(rssId).intervalMin === 10);

    // addWeread 查重 + 缺 mpId
    const dup = subs.addWeread({ mpId: 'MP1' });
    report('addWeread·mpId 查重拒绝', !dup.ok);
    const noMp = subs.addWeread({});
    report('addWeread·缺 mpId 拒绝', !noMp.ok);
    // 回溯 pages 钳位 1..5 由 fetchForSub 保证（直接对注入 fetcher 传参断言）
    let gotPages = null;
    subs.setWereadFetcher(async (s, pages) => { gotPages = pages; return []; });
    await subs.backfill(wrId, () => {});
    report('backfill·weread 固定传 5 页', gotPages === 5, 'pages=' + gotPages);
  }

  // ===== ⑤ settings.wereadEnabled 归一化 =====
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-wrset-'));
    const file = path.join(dir, 's.json');
    fs.writeFileSync(file, JSON.stringify({ wereadEnabled: 'yes' }));
    settings.configure({ file, defaultOutDir: dir });
    report('settings·字符串真值归一为布尔 true', settings.get().wereadEnabled === true);
    fs.writeFileSync(file, JSON.stringify({ wereadEnabled: 0 }));
    settings.configure({ file, defaultOutDir: dir });
    report('settings·0 归一为 false', settings.get().wereadEnabled === false);
    fs.writeFileSync(file, JSON.stringify({}));
    settings.configure({ file, defaultOutDir: dir });
    report('settings·缺省默认 true', settings.get().wereadEnabled === true);
  }

  console.log('----');
  console.log('TOTAL: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
  rssServer.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
