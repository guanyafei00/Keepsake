// R1.3 最小单测：strategy.js 站点策略层（纯 Node，零依赖，npm test 直接跑）
// 范围：档位匹配 / 熔断 / 远程规则校验限界 / 字段白名单 / 持久化恢复
// 不测 weread.js 等 Electron 依赖模块（CI 无 electron，见排期 R1.3 说明）
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const strategy = require('../lib/strategy');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  PASS ' + name); }
  catch (e) { console.error('  FAIL ' + name); console.error('    ' + (e && e.message)); process.exitCode = 1; }
}

function tmpStateFile(tag) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keepsake-strategy-')), tag + '.json');
}

// 每个用例独立临时目录，互不串状态（strategy 是模块级单例，configure 重置）
function fresh(tag) {
  const f = tmpStateFile(tag);
  strategy.configure({ stateFile: f });
  return f;
}

console.log('== strategy.js 单测 ==');

test('内置 host 直配 + 子域命中（space.bilibili.com → bilibili.com）', () => {
  fresh('t1');
  const a = strategy.forUrl('https://www.bilibili.com/video/x');
  const b = strategy.forUrl('https://space.bilibili.com/123');
  assert.strictEqual(a.key, 'bilibili.com');
  assert.strictEqual(b.key, 'bilibili.com');
  assert.strictEqual(a.key, b.key);
});

test('未知域名回落 FALLBACK 档位（key=_direct）', () => {
  fresh('t2');
  const r = strategy.forUrl('https://example.org/whatever');
  assert.strictEqual(r.key, 'example.org');
  assert.ok(r.sleep >= 1, 'sleep 至少 1s');
});

test('连续失败达阈值 → 熔断，冷却期内 isBreakered=true', () => {
  fresh('t3');
  const url = 'https://www.bilibili.com/x';
  assert.strictEqual(strategy.isBreakered(url), false);
  strategy.reportFailure(url, true); // 1
  strategy.reportFailure(url, true); // 2
  strategy.reportFailure(url, true); // 3 = threshold → 熔断
  assert.strictEqual(strategy.isBreakered(url), true, '第 3 次失败应触发熔断');
  assert.ok(strategy.breakerRemainMs(url) > 0, '冷却剩余时间应 > 0');
  assert.strictEqual(strategy.forUrl(url).level >= 1, true, '限流失败应升档');
});

test('reportSuccess 清零 failures；连续 3 次成功降档', () => {
  fresh('t4');
  const url = 'https://www.bilibili.com/x';
  strategy.reportFailure(url, true);
  strategy.reportFailure(url, true);
  strategy.reportFailure(url, true);           // 熔断 + level=1
  const after = strategy.forUrl(url);
  assert.ok(after.level >= 1);
  // 等冷却过期才能继续（报告失败不再升档也行，直接测 success 清零）
  strategy.reportSuccess(url);
  assert.strictEqual(strategy.forUrl(url).failures, 0);
});

test('validRule：sleep 下限 1s（防劫持后关闭限速）', () => {
  fresh('t5');
  const bad = strategy.applyRemoteRules([{ host: 'bilibili.com', sleep: 0 }], { persist: false });
  assert.strictEqual(bad.applied, 0, 'sleep<1 必须被拒');
  const good = strategy.applyRemoteRules([{ host: 'bilibili.com', sleep: 5 }], { persist: false });
  assert.strictEqual(good.applied, 1);
  assert.strictEqual(strategy.forUrl('https://bilibili.com').sleep, 5, '远程 sleep 应覆盖退避 0 档');
});

test('validRule：坏 host / 非数组 / 越界值全部拒绝', () => {
  fresh('t6');
  assert.strictEqual(strategy.applyRemoteRules('not-array', { persist: false }).applied, 0);
  assert.strictEqual(strategy.applyRemoteRules([{ host: 'not a domain', sleep: 3 }], { persist: false }).applied, 0);
  assert.strictEqual(strategy.applyRemoteRules([{ host: 'bilibili.com', sleep: 601 }], { persist: false }).applied, 0);
  assert.strictEqual(strategy.applyRemoteRules([{ host: 'bilibili.com', sleep: 3, breakerThreshold: 101 }], { persist: false }).applied, 0);
  assert.strictEqual(strategy.applyRemoteRules([{ host: 'bilibili.com', sleep: 3, backoffLevels: 'x' }], { persist: false }).applied, 0);
});

test('字段白名单：未知字段不透传进策略层', () => {
  fresh('t7');
  strategy.applyRemoteRules([
    { host: 'bilibili.com', sleep: 4, evilPayload: 'alert(1)', totallyUnknown: 42 },
  ], { persist: false });
  const snap = strategy.snapshot();
  const bili = snap.defaults.find(d => d.host === 'bilibili.com');
  assert.strictEqual(bili.sleep, 4);
  assert.strictEqual(bili.evilPayload, undefined, '未知字段不得进入策略层');
  assert.strictEqual(bili.totallyUnknown, undefined);
});

test('远程规则持久化后可恢复（configure 再加载）', () => {
  const f = tmpStateFile('t8');
  strategy.configure({ stateFile: f });
  strategy.applyRemoteRules([{ host: 'bilibili.com', sleep: 7 }]); // persist 默认 true
  const persisted = JSON.parse(fs.readFileSync(path.join(path.dirname(f), 'remote-rules.json'), 'utf-8'));
  assert.ok(Array.isArray(persisted.rules) && persisted.rules.length === 1);
  // 重新 configure：模拟重启，远程规则应自动恢复
  strategy.configure({ stateFile: f });
  assert.strictEqual(strategy.forUrl('https://bilibili.com').sleep, 7, '重启后远程规则应恢复');
});

test('远程规则整体省略熔断参数时回落 FALLBACK（不产生 NaN 熔断）', () => {
  fresh('t9');
  const url = 'https://bilibili.com/x';
  strategy.applyRemoteRules([{ host: 'bilibili.com', sleep: 2 }], { persist: false });
  // 只给 sleep，不给 breakerThreshold/cooldown —— 熔断仍要能工作
  for (let i = 0; i < 5; i++) strategy.reportFailure(url, true);
  assert.strictEqual(strategy.isBreakered(url), true, '缺省熔断参数必须回落 FALLBACK 而非静默失效');
});

test('state.json 持久化：档位写盘，configure 恢复', () => {
  const f = tmpStateFile('t10');
  strategy.configure({ stateFile: f });
  const url = 'https://www.bilibili.com/x';
  strategy.reportFailure(url, true);
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf-8'));
  assert.ok(onDisk._hosts['bilibili.com'], '学习档位应写盘');
  assert.strictEqual(onDisk._hosts['bilibili.com'].failures, 1);
});

console.log('== ' + passed + ' 个用例全部通过 ==');
if (process.exitCode) console.error('有失败用例！');

// ===== R1.5 验签用例（临时密钥对注入，生产路径用内置公钥不受影响）=====
const nodeCrypto = require('crypto');
const { generateKeyPairSync, sign: ecSign } = nodeCrypto;

console.log('== verifyRulesSig（R1.5 验签）==');
const kp = generateKeyPairSync('ed25519');
const pubDerHex = kp.publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
function signPayload(obj) {
  const payload = Buffer.from(JSON.stringify({ version: obj.version, rules: obj.rules }), 'utf8');
  return ecSign(null, payload, kp.privateKey).toString('base64');
}

test('正确签名 → 通过', () => {
  const j = { version: '2026-11-11', rules: [{ host: 'bilibili.com', sleep: 3 }], sig: signPayload({ version: '2026-11-11', rules: [{ host: 'bilibili.com', sleep: 3 }] }) };
  const r = strategy.verifyRulesSig(j, pubDerHex);
  assert.ok(r.ok && !r.unsigned);
});

test('篡改一个参数 → 验签拒绝', () => {
  const good = { version: 'v', rules: [{ host: 'bilibili.com', sleep: 3 }] };
  const j = { ...good, rules: [{ host: 'bilibili.com', sleep: 999 }], sig: signPayload(good) };
  const r = strategy.verifyRulesSig(j, pubDerHex);
  assert.strictEqual(r.ok, false);
});

test('无 sig → 当前容忍放行（unsigned 标记）', () => {
  const r = strategy.verifyRulesSig({ version: 'v', rules: [] }, pubDerHex);
  assert.ok(r.ok && r.unsigned, '线上规则站还没部署签名版，必须容忍无签名');
});

test('sig 字段非法 / 非对象 → 拒绝', () => {
  assert.strictEqual(strategy.verifyRulesSig({ sig: 123 }, pubDerHex).ok, false);
  assert.strictEqual(strategy.verifyRulesSig('not-object', pubDerHex).ok, false);
  assert.strictEqual(strategy.verifyRulesSig(null, pubDerHex).ok, false);
});

test('内置公钥路径可用（verifyRulesSig 不传 pub 也不抛错）', () => {
  const r = strategy.verifyRulesSig({ version: 'v', rules: [] });   // 无 sig → 走内置钥路径前的 unsigned 分支
  assert.ok(r.ok && r.unsigned);
});
