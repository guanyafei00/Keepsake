// QA 自研攻击测试（Edward 复核用，不依赖工程师脚本）：
//   ① P0-1 新攻击向量：标题 `../`、作者 `..\`、纯点+分隔符混合、末尾点号 slug
//   ② P1-4 自构脏页面：script/on*/javascript: 三类 + 大小写/TAB 实体/伪协议变体
// 运行：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS electron tools/test-qa-edward-attack.js
// 可用 QA_ONLY=caseA,caseB 选场景
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const article = require('../lib/article');
const sites = require('../lib/article-sites');
const { resolveDir, sanitizeSeg, slugify } = article._pathHelpers;

// 伪站点规则：命中本地测试 URL，强制 root=rule 路径（Readability 不参与 root 选择），
// 用于验证 P1-4 清洗逻辑在「规则路径」下同样生效（公众号/CSDN 等真实规则站点都走这条路）
sites.matchSite = () => ({ name: 'qa-fake', label: 'QA伪规则', match: /.*/,
  sel: { content: 'article', title: 'h1' }, waitMs: 200 });

app.on('window-all-closed', e => e.preventDefault());
// 诊断：所有 webContents 的导航事件（定位 dirty2 加载超时根因用）
app.on('web-contents-created', (e, wc) => {
  wc.on('did-finish-load', () => console.log('[diag] did-finish-load id=' + wc.id));
  wc.on('did-fail-load', (ev, code, desc, url) => console.log('[diag] did-fail-load id=' + wc.id + ' code=' + code + ' ' + desc + ' ' + String(url).slice(0, 80)));
  wc.on('did-start-navigation', (ev, url) => console.log('[diag] did-start-navigation id=' + wc.id + ' ' + String(url).slice(0, 80)));
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const LONG_TEXT = '这是一段足够长的正文文本，用来通过二十字门槛的提取判定，避免被当成版式失配。';

const PAGES = {
  // 新向量 A：标题含 ../，作者含 ..\ （工程师测的是裸 ..，这里换角度）
  '/p0a': '<!DOCTYPE html><html><head><title>../escape_attempt</title>' +
    '<meta name="author" content="..\\..\\evil"></head>' +
    '<body><p>' + LONG_TEXT + '</p><img src="/img/1.png"></body></html>',
  // 新向量 B：纯点与分隔符混合（清洗后变纯点）+ 标题末尾点号
  '/p0b': '<!DOCTYPE html><html><head><title>....</title>' +
    '<meta name="author" content="..#/#."></head>' +
    '<body><p>' + LONG_TEXT + '</p><img src="/img/2.png"></body></html>',
  '/p0c': '<!DOCTYPE html><html><head><title>Trailing....</title>' +
    '<body><p>' + LONG_TEXT + '</p><img src="/img/3.png"></body></html>',
  // 二分定位：A 组 = script/img onerror/三个 javascript: 链接；B 组 = svg onload + iframe
  // 页首先置空 alert：载荷模式文本原样保留，但不会弹模态框阻塞渲染进程（否则加载必然超时）
  '/dirty2': '<!DOCTYPE html><html><head><title>自构脏页面A</title></head><body>' +
    '<script>window.alert=function(){};window.confirm=function(){};window.prompt=function(){};</script>' +
    '<article><p>' + LONG_TEXT + '</p>' +
    '<script>alert(1)</script>' +
    '<img src="/img/4.png" onerror="alert(1)">' +
    '<a href="javascript:alert(2)">坏链接</a>' +
    '<a href="JaVaScRiPt:alert(3)">大小写变体</a>' +
    '<a href="jav&#x09;ascript:alert(4)">TAB实体变体</a>' +
    '</article></body></html>',
  '/dirty2b': '<!DOCTYPE html><html><head><title>自构脏页面B</title></head><body>' +
    '<script>window.alert=function(){};</script>' +
    '<article><p>' + LONG_TEXT + '</p>' +
    '<svg onload="alert(5)"></svg>' +
    '<iframe src="javascript:alert(6)"></iframe>' +
    '<div onclick="alert(7)">点我</div>' +
    '</article></body></html>',
  // 隔离定位：iframe javascript: src 是否独立导致主框架 load 永不完成
  '/iso_iframe': '<!DOCTYPE html><html><head><title>iso-iframe</title></head><body>' +
    '<script>window.alert=function(){};</script>' +
    '<article><p>' + LONG_TEXT + '</p><iframe src="javascript:alert(6)"></iframe></article></body></html>',
  '/iso_svg': '<!DOCTYPE html><html><head><title>iso-svg</title></head><body>' +
    '<script>window.alert=function(){};</script>' +
    '<article><p>' + LONG_TEXT + '</p><svg onload="alert(5)"></svg></article></body></html>',
  '/iso_iframe_plain': '<!DOCTYPE html><html><head><title>iso-iframe-plain</title></head><body>' +
    '<article><p>' + LONG_TEXT + '</p><iframe src="about:blank"></iframe></article></body></html>',
  // 规则路径（rule.sel.content）脏页面：验证 P1-4 清洗不依赖 Readability
  '/ruleDirty': '<!DOCTYPE html><html><head><title>规则路径脏页面</title></head><body>' +
    '<script>window.alert=function(){};</script>' +
    '<article><p>' + LONG_TEXT + '</p>' +
    '<script>alert(1)</script>' +
    '<img src="/img/5.png" onerror="alert(1)">' +
    '<a href="javascript:alert(2)">坏链接</a>' +
    '<a href="jav&#x09;ascript:alert(4)">TAB实体变体</a>' +
    '<svg onload="alert(5)"></svg>' +
    '<div onclick="alert(7)">点我</div>' +
    '</article></body></html>',
};

let pass = 0, fail = 0;
const findings = [];
function report(name, ok, detail) {
  if (ok) pass++; else { fail++; findings.push(name); }
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

async function main() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-qa-'));
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (/^\/img\//.test(u)) { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); return; }
    if (PAGES[u]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGES[u]); return; }
    res.writeHead(404); res.end('not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const B = 'http://127.0.0.1:' + server.address().port;
  console.log('[test] server at ' + B + '  outDir=' + outDir);
  const ONLY = (process.env.QA_ONLY || '').split(',').filter(Boolean);
  const skip = n => ONLY.length && !ONLY.includes(n);
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const insideOut = d => path.resolve(d).startsWith(path.resolve(outDir) + path.sep);

  // ---- 离线层：resolveDir 直接喂攻击段，断言越界抛错且 outDir 外无产物 ----
  // （resolveDir 契约：只对「真越界」负责；字面目录名 ..#/#. 不越界 → 不抛是正确的，
  //   清洗层兜底由 sanitizeSeg/slugify 断言 + 端到端场景覆盖）
  if (!skip('offline')) {
    for (const [label, a, s] of [
      ['作者=.. 标题=..', '..', '..', 'http://q/off1'],
      ['作者=..\\..\\evil', '..\\..\\evil', '..', 'http://q/off2'],
    ]) {
      let threw = null;
      try { resolveDir(outDir, a, s, 'http://q/x'); } catch (e) { threw = e; }
      report('离线 resolveDir 越界拒绝: ' + label,
        threw && threw.kind === 'select',
        threw ? ('kind=' + threw.kind) : '未抛错');
    }
    // 清洗层断言：混合分隔符纯点必须退 fallback / article
    report('离线 sanitizeSeg("..#/#.") → fallback（清洗后纯点）', sanitizeSeg('..#/#.', 'fb') === 'fb',
      'got: ' + sanitizeSeg('..#/#.', 'fb'));
    report('离线 slugify("../") → article（剥分隔符后纯点）', slugify('../') === 'article',
      'got: ' + slugify('../'));
    report('离线 sanitizeSeg("..\\..") → fallback', sanitizeSeg('..\\..', 'fb') === 'fb',
      'got: ' + sanitizeSeg('..\\..', 'fb'));
    // 字面目录名（不越界）：resolveDir 正常返回且落点必须在 outDir 内
    try {
      const d = resolveDir(outDir, '..#/#.', '../', 'http://q/off3');
      report('离线 字面目录名不越界且落点在 outDir 内', insideOut(d), d);
    } catch (e) {
      report('离线 字面目录名不越界且落点在 outDir 内', false, '意外抛错: ' + (e && e.kind));
    }
    const escapedProbe = path.resolve(outDir, '..', 'escape_attempt');
    report('离线攻击后 outDir 外无越界目录', !fs.existsSync(escapedProbe), escapedProbe);
  }

  // ---- 端到端向量 A：标题 ../ + 作者 ..\..\evil ----
  if (!skip('p0a')) {
    try {
      const r = await article.fetchArticle({ url: B + '/p0a', outDir });
      const ok = insideOut(r.dir);
      report('P0-1e2e 标题../+作者..\\ 产物在 outDir 内', ok, r.dir);
      if (!ok) findings.push('P0-1e2e-a');
      else {
        const meta = JSON.parse(fs.readFileSync(path.join(r.dir, 'meta.json'), 'utf-8'));
        report('P0-1e2e meta 正确', meta.url === B + '/p0a', 'dir=' + path.basename(r.dir));
      }
    } catch (e) {
      // 拒抓也算安全（fail-closed），但要求是 select 类错误而非内部异常
      const ok = e && e.kind === 'select';
      report('P0-1e2e 标题../+作者..\\ 产物在 outDir 内（fail-closed 拒抓）', ok, String(e.human || e.message).slice(0, 80));
    }
  }
  await pause(1000);

  // ---- 端到端向量 B：纯点混合分隔符 ----
  if (!skip('p0b')) {
    try {
      const r = await article.fetchArticle({ url: B + '/p0b', outDir });
      report('P0-1e2e 纯点混合分隔符 产物在 outDir 内', insideOut(r.dir), r.dir);
    } catch (e) {
      report('P0-1e2e 纯点混合分隔符（fail-closed 拒抓）', e && e.kind === 'select', String(e.human || e.message).slice(0, 80));
    }
  }
  await pause(1000);

  // ---- 端到端向量 C：标题末尾点号（Windows 会剥尾点，确认不越界、目录可落盘）----
  if (!skip('p0c')) {
    try {
      const r = await article.fetchArticle({ url: B + '/p0c', outDir });
      report('P0-1e2e 末尾点号标题 产物在 outDir 内', insideOut(r.dir), r.dir);
    } catch (e) {
      report('P0-1e2e 末尾点号标题（fail-closed 拒抓）', e && e.kind === 'select', String(e.human || e.message).slice(0, 80));
    }
  }
  await pause(1000);

  // ---- P1-4 自构脏页面：三类必清 + 变体 ----
  const dirtyCheck = async (page, tag) => {
    const r = await article.fetchArticle({ url: B + page, outDir });
    const html = fs.readFileSync(path.join(r.dir, 'index.html'), 'utf-8');
    const md = fs.readFileSync(path.join(r.dir, 'article.md'), 'utf-8');
    report('P1-4 ' + tag + ' index.html 无 <script>', !/<script/i.test(html), '');
    report('P1-4 ' + tag + ' index.html 无 on* 事件属性', !/\son\w+\s*=/i.test(html), '');
    report('P1-4 ' + tag + ' index.html 无 javascript: 伪协议', !/javascript\s*:/i.test(html), '');
    report('P1-4 ' + tag + ' index.html 无 <iframe>', !/<iframe/i.test(html), '');
    report('P1-4 ' + tag + ' 大小写变体 JaVaScRiPt: 已清', !/JaVaScRiPt/i.test(html), '');
    const residue = (html.match(/jav[^"']{0,12}script[^"']{0,20}/i) || [''])[0];
    report('P1-4 ' + tag + ' TAB 实体伪协议已清', !residue, residue ? '疑似残留: ' + residue : '');
    report('P1-4 ' + tag + ' article.md 无 javascript: 伪协议', !/javascript\s*:/i.test(md), '');
    report('P1-4 ' + tag + ' 正文文字完好（未误伤）', html.indexOf('足够长的正文') >= 0 && md.indexOf('足够长的正文') >= 0, '');
  };
  if (!skip('dirty2')) {
    try { await dirtyCheck('/dirty2', 'A组'); } catch (e) {
      report('P1-4 A组脏页面抓取成功', false, String(e.human || e.message).slice(0, 90));
    }
  }
  await pause(1000);
  if (!skip('dirty2b')) {
    try { await dirtyCheck('/dirty2b', 'B组'); } catch (e) {
      report('P1-4 B组脏页面抓取成功', false, String(e.human || e.message).slice(0, 90));
    }
  }

  // ---- 隔离场景（QA_ONLY=iso）----
  if (!skip('iso')) {
    for (const [page, tag] of [['/iso_iframe', 'iframe javascript: src'], ['/iso_svg', 'svg onload'], ['/iso_iframe_plain', 'iframe about:blank']]) {
      const t0 = Date.now();
      try {
        await article.fetchArticle({ url: B + page, outDir });
        report('隔离 ' + tag + ' 可加载', true, Math.round((Date.now() - t0) / 1000) + 's');
      } catch (e) {
        report('隔离 ' + tag + ' 可加载', false, Math.round((Date.now() - t0) / 1000) + 's ' + String(e.human || e.message).slice(0, 60));
      }
      await pause(1000);
    }
  }

  // ---- 规则路径 P1-4 清洗（QA_ONLY=rulepath）----
  if (!skip('rulepath')) {
    try {
      const r = await article.fetchArticle({ url: B + '/ruleDirty', outDir });
      const html = fs.readFileSync(path.join(r.dir, 'index.html'), 'utf-8');
      const md = fs.readFileSync(path.join(r.dir, 'article.md'), 'utf-8');
      report('P1-4规则路径 无 <script>', !/<script/i.test(html), '');
      report('P1-4规则路径 无 on* 事件属性', !/\son\w+\s*=/i.test(html), '');
      const residue = (html.match(/jav[^"']{0,12}script[^"']{0,20}/i) || [''])[0];
      report('P1-4规则路径 无 javascript:/TAB变体残留', !residue, residue ? '残留: ' + residue : '');
      report('P1-4规则路径 正文文字完好', html.indexOf('足够长的正文') >= 0 && md.indexOf('足够长的正文') >= 0, '');
      report('P1-4规则路径 meta.title 来自规则选择器', r.meta.title === '规则路径脏页面', r.meta.title);
    } catch (e) {
      report('P1-4 规则路径脏页面抓取成功', false, String(e.human || e.message).slice(0, 90));
    }
  }

  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (findings.length) console.log('[findings] ' + findings.join('; '));
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(main).catch(e => { console.error('[test] fatal:', e); app.exit(2); });
