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
  report('非失效·404 HTML 页（端点不存在/改版）不误判', weread.isExpiredSignal(404, '<html><head><title>404 Not Found</title></head><body>page not found</body></html>') === false);
  report('非失效·风控页 HTML 不误判', weread.isExpiredSignal(200, '<html>当前操作存在风险，请稍后再试</html>') === false);
  report('非失效·普通业务页 HTML 不误判', weread.isExpiredSignal(200, '<html><title>微信读书</title><div>书架</div></html>') === false);
  report('非失效·errCode 0', weread.isExpiredSignal(200, '{"errCode":0,"data":{"ok":1}}') === false);
  report('非失效·其他业务码', weread.isExpiredSignal(200, '{"errCode":-1}') === false);
  report('非失效·空 body', weread.isExpiredSignal(200, '') === false);
  report('非失效·空白 body', weread.isExpiredSignal(200, '  \n ') === false);
  report('非失效·半截 JSON', weread.isExpiredSignal(200, '{"errCode":-2012') === false);
  report('非失效·200+合法JSON+429码位不介入', weread.isExpiredSignal(429, '{"errCode":0}') === false);

  // ===== ② articleUrl / extractBiz =====
  const built = weread.articleUrl({ __biz: 'MzA4abc==', mid: '224', idx: '1', sn: '9f3ab' });
  report('文章链接·四参拼装', built === 'https://mp.weixin.qq.com/s?__biz=MzA4abc%3D%3D&mid=224&idx=1&sn=9f3ab', built);
  report('文章链接·自带 url 优先', weread.articleUrl({ url: 'https://mp.weixin.qq.com/s/xyz' }) === 'https://mp.weixin.qq.com/s/xyz');
  report('文章链接·缺 sn → null', weread.articleUrl({ __biz: 'B', mid: '1', idx: '1' }) === null);
  report('文章链接·空条目 → null', weread.articleUrl(null) === null);
  report('extractBiz·base64 含等号', weread.extractBiz('https://mp.weixin.qq.com/s?__biz=MzA4abc123==&mid=22&idx=1&sn=x') === 'MzA4abc123==');
  report('extractBiz·无 __biz → null', weread.extractBiz('https://mp.weixin.qq.com/s/xyz') === null);

  // ===== ③ articleListToFeedItems（type:'feed' 复用 onNew 分流）=====
  const LIST = [
    { articleId: 'a1', title: '第一篇', __biz: 'BIZ1', mid: '11', idx: '1', sn: 's1' },
    { id: 'a2', title: '第二篇', url: 'https://mp.weixin.qq.com/s/direct' },
    { title: '无 id 应被过滤' },
    { articleId: 'a4', title: '字段缺 sn', __biz: 'BIZ4', mid: '44', idx: '1' },
  ];
  let items = weread.articleListToFeedItems({ articles: LIST });
  report('转换·对象形式 articles 字段', items.length === 3, 'n=' + items.length);
  report('转换·type=feed 复用 onNew 分流', items[0].type === 'feed' && items[0].id === 'a1' && items[0].text === '第一篇');
  report('转换·url 优先用回传值', items[1].url === 'https://mp.weixin.qq.com/s/direct');
  report('转换·四参拼装兜底', (items[0].url || '').startsWith('https://mp.weixin.qq.com/s?__biz=BIZ1&mid=11'));
  report('转换·字段缺失 url=null', items[2].url === null);
  report('转换·数组形式直传', weread.articleListToFeedItems(LIST).length === 3);
  report('游标·nextMaxTime 提取', weread.extractCursor({ nextMaxTime: 1700000000 }) === 1700000000);
  report('游标·缺失 → 0（首页即停）', weread.extractCursor({ foo: 1 }) === 0);

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

  server.close();
  console.log('----');
  console.log('TOTAL: ' + (pass + fail) + ' | PASS: ' + pass + ' | FAIL: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('[test] fatal:', e); try { server.close(); } catch (e2) {} process.exit(2); });
