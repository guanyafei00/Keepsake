// QA 集成测试（electron 主进程跑）：文章引擎修复项端到端验证
// 用法：
//   本地场景:  electron tools/test-article-fixes-electron.js
//   公众号回归: ART_URL='https://mp.weixin.qq.com/s/xxx' electron tools/test-article-fixes-electron.js
// 注意：必须以 electron GUI 模式跑（不能 ELECTRON_RUN_AS_NODE）——测试里起真实 BrowserWindow
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const article = require('../lib/article');

app.on('render-process-gone', (e, wc, d) => console.log('[diag] render-process-gone:', JSON.stringify(d)));
app.on('child-process-gone', (e, d) => console.log('[diag] child-process-gone:', JSON.stringify(d)));
// 场景间存在「全部窗口已销毁」的间隙，阻止 Electron 默认的退出行为（否则后续场景跑不到）
app.on('window-all-closed', e => e.preventDefault());

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const LONG_TEXT = '这是一段足够长的正文文本，用来通过二十字门槛的提取判定，避免被当成版式失配。';

// 本地测试页（占位 %TEXT% 会替换为 LONG_TEXT）
const PAGES = {
  // P1-1：页面加载完成后 50ms 起死循环卡死渲染进程主线程
  '/loop': '<!DOCTYPE html><html><head><title>loop</title></head><body><p>' + LONG_TEXT + '</p>' +
    '<script>setTimeout(function(){ while(true){} }, 50);</script></body></html>',
  // P0-1 端到端：作者/标题都是 ..
  '/dot': '<!DOCTYPE html><html><head><title>..</title>' +
    '<meta name="author" content=".."></head>' +
    '<body><p>' + LONG_TEXT + '</p><img src="/img/1.png"></body></html>',
  // P1-4：正文带 script / on* / javascript: 伪协议
  '/dirty': '<!DOCTYPE html><html><head><title>脏页面测试</title></head><body>' +
    '<article><p>' + LONG_TEXT + '</p>' +
    '<script>window.__dirty = 1;</script>' +
    '<img src="/img/2.png" onerror="alert(1)">' +
    '<a href="javascript:alert(2)">坏链接</a>' +
    '</article></body></html>',
  // P1-3：310 张图（超 MAX_IMAGES=300）
  '/many': '<!DOCTYPE html><html><head><title>多图测试</title></head><body><p>' + LONG_TEXT + '</p>' +
    Array.from({ length: 310 }, (_, i) => '<img src="/img/' + (i + 1) + '.png">').join('') +
    '</body></html>',
  // P2-1：同作者同标题不同内容
  '/dup1': '<!DOCTYPE html><html><head><title>并发重名测试文章</title>' +
    '<meta name="author" content="并发作者"></head><body><p>第一篇的内容标记 DUPONE ' + LONG_TEXT + '</p><img src="/img/11.png"></body></html>',
  '/dup2': '<!DOCTYPE html><html><head><title>并发重名测试文章</title>' +
    '<meta name="author" content="并发作者"></head><body><p>第二篇的内容标记 DUPTWO ' + LONG_TEXT + '</p><img src="/img/12.png"></body></html>',
};

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

async function main() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-fix-'));
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (/^\/img\//.test(u)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return; }
    if (PAGES[u]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGES[u]); return; }
    res.writeHead(404); res.end('not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const B = 'http://127.0.0.1:' + server.address().port;
  console.log('[test] server at ' + B + '  outDir=' + outDir);
  const ONLY = (process.env.KS_ONLY || '').split(',').filter(Boolean);   // 场景开关（排查用）
  const skip = n => ONLY.length && !ONLY.includes(n);
  const pause = ms => new Promise(r => setTimeout(r, ms));   // 场景间隔：给被销毁窗口的渲染进程收尾时间

  // ---- P1-1：死循环页面 → 30s 超时报错退出 + 窗口销毁 ----
  if (!skip('loop')) {
  const t0 = Date.now();
  try {
    await article.fetchArticle({ url: B + '/loop', outDir });
    report('P1-1 死循环页面按错误退出', false, '竟然成功返回了');
  } catch (e) {
    const ms = Date.now() - t0;
    const okErr = e && e.kind === 'network' && /超时/.test(e.human || '');
    report('P1-1 死循环页面按错误退出', !!okErr, Math.round(ms / 1000) + 's kind=' + (e && e.kind) + ' ' + String(e.human || e.message).slice(0, 60));
  }
  report('P1-1 抓取窗口已销毁（无泄漏）', BrowserWindow.getAllWindows().length === 0,
    'windows=' + BrowserWindow.getAllWindows().length);
  }
  await pause(2000);

  // ---- P0-1 端到端：作者/标题为 .. 的完整抓取，产物必须落在 outDir 内 ----
  if (!skip('dot')) {
  try {
    const r = await article.fetchArticle({ url: B + '/dot', outDir });
    const inside = path.resolve(r.dir).startsWith(path.resolve(outDir) + path.sep);
    report('P0-1 作者/标题为 .. 产物仍在 outDir 内', inside, r.dir);
  } catch (e) {
    report('P0-1 作者/标题为 .. 产物仍在 outDir 内', false, String(e.human || e.message));
  }
  }
  await pause(1000);

  // ---- P1-4：脏页面清洗 + P1-2：HTML_TO_MD 注入后 md 有内容 ----
  if (!skip('dirty')) {
  try {
    const r = await article.fetchArticle({ url: B + '/dirty', outDir });
    const html = fs.readFileSync(path.join(r.dir, 'index.html'), 'utf-8');
    const md = fs.readFileSync(path.join(r.dir, 'article.md'), 'utf-8');
    report('P1-4 index.html 无 script 标签', !/<script/i.test(html), '');
    report('P1-4 index.html 无 on* 事件属性', !/onerror|onclick|onload/i.test(html), '');
    report('P1-4 index.html 无 javascript: 伪协议', !/javascript:/i.test(html), '');
    report('P1-2 article.md 有正文内容（转换器注入成功）', md.indexOf('足够长的正文') >= 0, md.slice(0, 80).replace(/\n/g, ' '));
  } catch (e) {
    report('P1-4 脏页面抓取成功', false, String(e.human || e.message));
  }
  }
  await pause(1000);

  // ---- P1-3：310 张图 → 无占位符残留 ----
  if (!skip('many')) {
  try {
    const r = await article.fetchArticle({ url: B + '/many', outDir });
    const html = fs.readFileSync(path.join(r.dir, 'index.html'), 'utf-8');
    const md = fs.readFileSync(path.join(r.dir, 'article.md'), 'utf-8');
    report('P1-3 index.html 无 __KS_IMG_ 残留', html.indexOf('__KS_IMG_') < 0, '');
    report('P1-3 article.md 无 __KS_IMG_ 残留', md.indexOf('__KS_IMG_') < 0, '');
    report('P1-3 超限图按 MAX_IMAGES 截断', r.meta.imagesTotal === 300, 'total=' + r.meta.imagesTotal + ' local=' + r.meta.imagesLocal);
  } catch (e) {
    report('P1-3 多图页面抓取成功', false, String(e.human || e.message));
  }
  }
  await pause(1000);

  // ---- P2-1：同作者同标题不同 URL 并发抓取 → 两个目录不互踩 ----
  if (!skip('dup')) {
  try {
    const [r1, r2] = await Promise.all([
      article.fetchArticle({ url: B + '/dup1', outDir }),
      article.fetchArticle({ url: B + '/dup2', outDir }),
    ]);
    const d1 = path.resolve(r1.dir), d2 = path.resolve(r2.dir);
    report('P2-1 并发落不同目录', d1 !== d2, d1 + '  vs  ' + d2);
    const m1 = JSON.parse(fs.readFileSync(path.join(d1, 'meta.json'), 'utf-8'));
    const m2 = JSON.parse(fs.readFileSync(path.join(d2, 'meta.json'), 'utf-8'));
    report('P2-1 两篇 meta 完整且 URL 各自正确', m1.url === B + '/dup1' && m2.url === B + '/dup2',
      m1.url + ' / ' + m2.url);
  } catch (e) {
    report('P2-1 并发抓取成功', false, String(e.human || e.message));
  }
  }

  // ---- 公众号回归（可选，走 ART_URL 环境变量）----
  const ART_URL = process.env.ART_URL;
  if (ART_URL) {
    try {
      const r = await article.fetchArticle({ url: ART_URL, outDir: process.env.ART_OUTDIR || outDir });
      report('回归 公众号抓取 7/7 图', r.meta.imagesTotal === 7 && r.meta.imagesLocal === 7,
        'total=' + r.meta.imagesTotal + ' local=' + r.meta.imagesLocal + ' dir=' + r.dir);
      const rc = await article.recheck({ dir: r.dir });
      report('回归 recheck ok', rc.status === 'ok', 'status=' + rc.status + ' edited=' + rc.edited);
    } catch (e) {
      report('回归 公众号抓取', false, String(e.human || e.message));
    }
  }

  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(main).catch(e => { console.error('[test] fatal:', e); app.exit(2); });
