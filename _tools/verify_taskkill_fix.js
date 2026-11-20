// taskkill ENOENT 崩溃修复回归验证
// 用法：node _tools/verify_taskkill_fix.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '::', e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const APP = path.resolve(__dirname, '../app');
const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf-8');
const queueSrc = fs.readFileSync(path.join(APP, 'lib/queue.js'), 'utf-8');

console.log('\n=== A. 源码静态断言 ===');
ok('main.js killEngineSubprocesses 用绝对路径(taskkill.exe)', () => {
  const seg = mainSrc.slice(mainSrc.indexOf('function killEngineSubprocesses'), mainSrc.indexOf('function killEngineSubprocesses') + 900);
  assert(/System32.*taskkill\.exe/.test(seg), 'no abs path');
  assert(/fs\.existsSync\(tkAbs\)/.test(seg), 'no existsSync fallback');
});
ok('main.js taskkill spawn 挂 error 监听', () => {
  const seg = mainSrc.slice(mainSrc.indexOf('function killEngineSubprocesses'), mainSrc.indexOf('function killEngineSubprocesses') + 900);
  // taskkill 分支：spawn 后紧跟 .on('error')
  assert(/cp\.spawn\(tk,[\s\S]{0,300}?\.on\('error', \(\) => \{\}\)/.test(seg), 'taskkill spawn no error handler');
});
ok('main.js pkill 分支也挂 error 监听', () => {
  assert(/cp\.spawn\('pkill'[\s\S]{0,200}?\.on\('error'/.test(mainSrc), 'pkill no error handler');
});
ok('queue.js killTree 用绝对路径 + error 监听', () => {
  const seg = queueSrc.slice(queueSrc.indexOf('function killTree'), queueSrc.indexOf('function killTree') + 700);
  assert(/System32.*taskkill\.exe/.test(seg), 'no abs path');
  assert(/p\.on\('error'/.test(seg), 'no error handler');
  assert(/child\.kill\('SIGKILL'\)/.test(seg), 'no fallback kill');
});

console.log('\n=== B. 运行时：spawn 不存在命令不冒泡崩溃 ===');
// 模拟 PATH 里没有 taskkill 的场景：直接 spawn 一个铁定不存在的名字
// 挂 error 监听后，ENOENT 只会触发回调，不应变成 uncaughtException
(async () => {
  let crashed = null;
  const onUncaught = (e) => { crashed = e; };
  process.on('uncaughtException', onUncaught);

  const p = spawn('__definitely_not_a_real_command_' + Date.now(), ['/F'], { stdio: 'ignore' });
  let gotError = false;
  p.on('error', (e) => { gotError = e && e.code === 'ENOENT'; });
  await new Promise(r => p.on('close', r));
  await new Promise(r => setTimeout(r, 50));
  process.removeListener('uncaughtException', onUncaught);

  ok('ENOENT 触发了 error 回调（被接住）', () => assert(gotError, 'error callback not fired'));
  ok('未冒泡成 uncaughtException（不崩主进程）', () => assert(crashed === null, crashed && crashed.message));

  console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(2); });
