// QA 离线单测：P2-5 —— 文章引擎 deleted/paywall/select 失败不计站点熔断
// 纯 node 运行（stub 掉 article.fetchArticle，不启 electron）：node tools/test-queue-breaker-exempt.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const queueMod = require('../lib/queue');
const article = require('../lib/article');
const strategy = require('../lib/strategy');

queueMod.configure({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ks-p25-')) });
strategy.configure({ stateFile: path.join(os.tmpdir(), 'ks-p25-state-' + Date.now() + '.json') });

// 计数器挂到 strategy.reportFailure（queue.js 每次调用都走同一模块单例的属性查找）
let failReports = 0;
const origReportFailure = strategy.reportFailure;
strategy.reportFailure = function (url, rl) { failReports++; return origReportFailure.call(this, url, rl); };

function runOne(url, rejectWith) {
  return new Promise(resolve => {
    article.fetchArticle = () => Promise.reject(rejectWith);   // stub：队列文章引擎直接失败
    const q = new queueMod.DownloadQueue(() => {});
    const it = q.add(url, { engine: 'article' });
    setTimeout(() => resolve(q.items.get(it.id)), 150);
  });
}

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

(async () => {
  const base = failReports;

  // deleted / paywall / select → 不计熔断
  const itDel = await runOne('http://example.org/del', new article.ArticleError('deleted'));
  report('deleted 失败不计 reportFailure', failReports === base && itDel.status === 'error',
    'reports=' + (failReports - base) + ' status=' + itDel.status);

  const itPay = await runOne('http://example.org/pay', new article.ArticleError('paywall'));
  report('paywall 失败不计 reportFailure', failReports === base && itPay.status === 'error',
    'reports=' + (failReports - base) + ' status=' + itPay.status);

  const itSel = await runOne('http://example.org/sel', new article.ArticleError('select', '版式失配'));
  report('select 失败不计 reportFailure', failReports === base && itSel.status === 'error',
    'reports=' + (failReports - base) + ' status=' + itSel.status);

  // network 等其他失败 → 照常计熔断（对照组）
  const itNet = await runOne('http://example.org/net', new article.ArticleError('network', '超时'));
  report('network 失败照常计 reportFailure', failReports === base + 1 && itNet.status === 'error',
    'reports=' + (failReports - base) + ' status=' + itNet.status);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
