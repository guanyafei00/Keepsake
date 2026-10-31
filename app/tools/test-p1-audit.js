'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { exportGone } = require('../lib/csv');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const main = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const indexSource = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const subsSource = fs.readFileSync(require.resolve('../lib/subs'), 'utf8');

function run(name, fn) {
  try { const result = fn(); if (result && typeof result.then === 'function') return result.then(() => console.log('PASS ' + name), e => { console.error('FAIL ' + name + ': ' + e.stack); process.exitCode = 1; }); console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name + ': ' + error.stack); process.exitCode = 1; }
}

function loadTranslateError() {
  const match = html.match(/function translateError\(e\) \{[\s\S]*?\n\}/);
  assert(match, 'translateError found');
  const context = {};
  vm.runInNewContext(match[0] + '\nthis.translateError = translateError;', context);
  return context.translateError;
}

run('#16 412/-352 maps before broad codes', () => assert.match(loadTranslateError()('HTTP Error 412: -352'), /B 站风控限流/));
run('#16 429 takes priority over 403 and offers cooldown advice', () => assert.match(loadTranslateError()('HTTP 403; retry got HTTP 429 Too Many Requests'), /请求太快被限流/));
run('#16 403 language is conservative', () => assert.match(loadTranslateError()('HTTP Error 403: Forbidden'), /可能需要登录.*或链接已失效/));
run('#16 original error title and translated content are escaped', () => {
  assert.match(html, /title="\$\{t\.error \? esc\(t\.error\) : ''\}"/);
  assert.match(html, /esc\(translateError\(t\.error\)\)/);
  const translated = loadTranslateError()('<img onerror=alert(1)>');
  assert.strictEqual(translated, '<img onerror=alert(1)>');
});
run('#23 all inspection entry points serialize on one chain and recover after rejection', async () => {
  assert.match(main, /let _subChain = Promise\.resolve\(\[\]\);/);
  assert.match(main, /const run = _subChain\.then\(\(\) => doCheckAllSubs\(onlyId\)\);/);
  assert.match(main, /_subChain = run\.then\(\(\) => \{\}, \(\) => \[\]\);/);
  assert.match(main, /setTimeout\(schedule, CHECK_INTERVAL_MS\)/);
  assert.match(main, /ipcMain\.handle\('subs:check', \(e, \{ id \}\) => checkAllSubs\(id \|\| null\)\)/);
  assert.match(main, /checkAllSubs\(r\.sub\.id\)/);
  assert.match(main, /ipcMain\.handle\('subs:resume'/);
  assert.match(subsSource, /userPaused: false/);
  let chain = Promise.resolve();
  let active = 0, peak = 0, calls = 0;
  const enqueue = fn => {
    const run = chain.then(fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
  const fail = enqueue(async () => { active++; peak = Math.max(peak, active); calls++; await Promise.resolve(); active--; throw new Error('first rejects'); });
  const next = enqueue(async () => { active++; peak = Math.max(peak, active); calls++; await Promise.resolve(); active--; return 'later ran'; });
  await assert.rejects(fail, /first rejects/);
  assert.strictEqual(await next, 'later ran');
  assert.strictEqual(peak, 1);
  assert.strictEqual(calls, 2);
});
run('#31 exportGone no-data, cancel, BOM, CSV escaping and file mapping contract', async () => {
  const noData = await exportGone({ subscriptions: [], getFiles: () => ({}), itemUrl: () => '', showSaveDialog: async () => ({}), writeFile: async () => {} });
  assert.strictEqual(noData.ok, false);
  assert.match(noData.reason, /没有/);
  const base = {
    subscriptions: [{ id: 's1', name: '订阅, "重要"\n第二行', kind: 'rss', gone: ['item,"\n1'] }],
    getFiles: () => ({ 'item,"\n1': ['/download/a,"b.mp4'] }),
    itemUrl: () => 'https://example.test/item?id="1"',
    writeFile: async () => {},
  };
  const canceled = await exportGone({ ...base, showSaveDialog: async () => ({ canceled: true }) });
  assert.deepStrictEqual(canceled, { ok: false, reason: '已取消' });
  let written = '';
  const exported = await exportGone({ ...base, showSaveDialog: async () => ({ filePath: '/tmp/gone.csv' }), writeFile: async (_p, csv) => { written = csv; }, now: new Date('2026-10-31T00:00:00Z') });
  assert.strictEqual(exported.ok, true);
  assert.ok(written.charCodeAt(0) === 0xFEFF);
  assert.ok(written.includes('"订阅, ""重要""\n第二行"'));
  assert.ok(written.includes('"item,""\n1"'));
  assert.match(written, /"\/download\/a,""b\.mp4"/);
  assert.match(written, /在/);
  assert.match(written, /源头链接/);
  assert.strictEqual(exported.count, 1);
  const missing = await exportGone({ ...base, getFiles: () => ({}), showSaveDialog: async () => ({ filePath: '/tmp/gone.csv' }), writeFile: async (_p, csv) => { written = csv; } });
  assert.match(written, /已不在本地/);
});

Promise.resolve().then(() => new Promise(resolve => setTimeout(resolve, 20))).then(() => {
  if (process.exitCode) process.exit(1);
});
