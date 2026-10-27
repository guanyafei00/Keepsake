// QA 队列层集成测试（electron）：P1-1 队列侧窗口销毁联动
//   ① cancel 路径：取消抓取中的文章任务 → 窗口被 destroy、任务 canceled、槽位释放
//   ② 看门狗路径：无输出超阈值 → 看门狗 destroy 窗口、任务 error、槽位释放
// 运行：env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS electron tools/test-qa-edward-queue-cancel.js
const { app, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const queueMod = require('../lib/queue');
const strategy = require('../lib/strategy');

app.on('window-all-closed', e => e.preventDefault());

const LONG_TEXT = '这是一段足够长的正文文本，用来通过二十字门槛的提取判定，避免被当成版式失配。';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let pass = 0, fail = 0;
function report(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}
const pause = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-qa-q-'));
  const PAGES = {
    '/loop': '<!DOCTYPE html><html><head><title>loop</title></head><body><p>' + LONG_TEXT + '</p>' +
      '<script>setTimeout(function(){ while(true){} }, 50);</script></body></html>',
    // 慢图页：200 张图、每张 300ms 延迟 —— 供「下载中途取消」场景
    '/slow': '<!DOCTYPE html><html><head><title>slow</title></head><body><p>' + LONG_TEXT + '</p>' +
      Array.from({ length: 200 }, (_, i) => '<img src="/img/' + (i + 1) + '.png">').join('') + '</body></html>',
  };
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (/^\/img\//.test(u)) { setTimeout(() => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG); }, 300); return; }
    if (PAGES[u]) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGES[u]); return; }
    res.writeHead(404); res.end('not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const B = 'http://127.0.0.1:' + server.address().port;

  queueMod.configure({
    outDir,
    cookiePath: path.join(outDir, 'cookies.txt'),
    watchdogStallMin: 0.05,   // 3s 无输出即触-watchdog（disk timer 每 30s 巡检一次）
  });
  strategy.configure({ stateFile: path.join(outDir, 'strategy-state.json') });

  // ---- ① cancel 路径：死循环页，1.5s 后取消 ----
  {
    const q = new queueMod.DownloadQueue(() => {});
    const it = q.add(B + '/loop', { engine: 'article' });
    await pause(1500);
    const winBefore = BrowserWindow.getAllWindows().length;
    const okCancel = q.cancel(it.id);
    await pause(800);
    const after = q.items.get(it.id);
    report('P1-1队列 cancel() 返回 true', okCancel === true, '');
    report('P1-1队列 任务置 canceled', after && after.status === 'canceled', 'status=' + (after && after.status));
    report('P1-1队列 槽位释放（active=0）', q.active === 0, 'active=' + q.active);
    report('P1-1队列 抓取窗口已销毁', BrowserWindow.getAllWindows().length === 0,
      'before=' + winBefore + ' after=' + BrowserWindow.getAllWindows().length);
  }
  await pause(2000);

  // ---- ①b cancel 路径：图片下载中途取消 ----
  {
    const q = new queueMod.DownloadQueue(() => {});
    const it = q.add(B + '/slow', { engine: 'article' });
    await pause(3000);   // 进图片循环
    const prog = q.items.get(it.id).progress;
    q.cancel(it.id);
    await pause(800);
    const after = q.items.get(it.id);
    report('P1-1队列 图片循环中取消 → canceled 且窗口销毁',
      after.status === 'canceled' && BrowserWindow.getAllWindows().length === 0,
      'status=' + after.status + ' progress@cancel=' + prog + ' windows=' + BrowserWindow.getAllWindows().length);
    report('P1-1队列 槽位释放（active=0）', q.active === 0, 'active=' + q.active);
  }
  await pause(2000);

  // ---- ② 看门狗路径：/loop 页（无任何进度输出），3s 阈值 + 30s 巡检 → 最迟 ~33s 触发 ----
  {
    const q = new queueMod.DownloadQueue(() => {});
    const it = q.add(B + '/loop', { engine: 'article' });
    const t0 = Date.now();
    // 等到任务终态（error/超时兜底 60s）
    let after = q.items.get(it.id);
    for (let i = 0; i < 60 && after.status === 'downloading'; i++) { await pause(1000); after = q.items.get(it.id); }
    const elapsed = Math.round((Date.now() - t0) / 1000);
    report('P1-1队列 看门狗终止卡死任务', after.status === 'error' && /看门狗/.test(after.error || ''),
      elapsed + 's status=' + after.status + ' error=' + String(after.error).slice(0, 60));
    report('P1-1队列 看门狗路径槽位释放（active=0）', q.active === 0, 'active=' + q.active);
    report('P1-1队列 看门狗路径窗口已销毁', BrowserWindow.getAllWindows().length === 0,
      'windows=' + BrowserWindow.getAllWindows().length);
  }

  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  app.exit(fail ? 1 : 0);
}

app.whenReady().then(main).catch(e => { console.error('[test] fatal:', e); app.exit(2); });
