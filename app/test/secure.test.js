// R1.4 单测：lib/secure.js 凭据加密（fake provider 注入，CI 无 Electron 也能跑）
'use strict';
const assert = require('assert');
const secure = require('../lib/secure');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  PASS ' + name); }
  catch (e) { console.error('  FAIL ' + name); console.error('    ' + (e && e.message)); process.exitCode = 1; }
}

// fake provider：模拟 safeStorage 行为（对称变换 + 可用开关）
function makeFake(available) {
  return {
    isAvailable: () => available,
    encrypt: (s) => Buffer.from('FAKE::' + Buffer.from(s, 'utf8').toString('base64')),
    decrypt: (buf) => {
      const s = buf.toString();
      if (!s.startsWith('FAKE::')) throw new Error('garbage');
      return Buffer.from(s.slice(6), 'base64').toString('utf8');
    },
  };
}

console.log('== secure.js 单测 ==');

test('明文加密 → enc:v1 前缀密文 → 解密还原', () => {
  secure.configureProvider(makeFake(true));
  const enc = secure.encryptSecret('sk-my-secret-key');
  assert.ok(secure.isEncrypted(enc), '应为 enc:v1 前缀密文');
  assert.ok(!enc.includes('sk-my-secret-key'), '密文不得含明文');
  assert.strictEqual(secure.decryptSecret(enc), 'sk-my-secret-key');
});

test('无前缀（历史明文）解密原样返回——迁移前始终可用', () => {
  secure.configureProvider(makeFake(true));
  assert.strictEqual(secure.decryptSecret('plain-legacy-key'), 'plain-legacy-key');
});

test('safeStorage 不可用 → 诚实降级为明文（不假装加密）', () => {
  secure.configureProvider(makeFake(false));
  const out = secure.encryptSecret('sk-no-keyring');
  assert.strictEqual(out, 'sk-no-keyring', '加密不可用必须原样返回');
  assert.strictEqual(secure.decryptSecret(out), 'sk-no-keyring');
});

test('migrateSecret：明文 → 加密回写；幂等（已加密不再改写）', () => {
  secure.configureProvider(makeFake(true));
  let stored = 'sk-migrate-me';
  let writes = 0;
  assert.strictEqual(secure.migrateSecret(() => stored, (v) => { stored = v; writes++; }), true);
  assert.ok(secure.isEncrypted(stored), '迁移后应为密文');
  assert.strictEqual(writes, 1);
  assert.strictEqual(secure.migrateSecret(() => stored, (v) => { stored = v; writes++; }), false, '已加密的二次迁移必须是 no-op');
  assert.strictEqual(writes, 1);
});

test('跨机器解密失败 → 明确报错而不是静默空值', () => {
  secure.configureProvider({
    isAvailable: () => true,
    encrypt: (s) => Buffer.from('FAKE::' + Buffer.from(s, 'utf8').toString('base64')),
    decrypt: () => { throw new Error('decrypt fail'); },   // 模拟换机器 DPAPI 解不开
  });
  const enc = secure.encryptSecret('sk-x');
  assert.throws(() => secure.decryptSecret(enc), /DPAPI|其他机器/, '必须抛出含跨机器提示的错误');
});

test('空值/非字符串安全（不抛错）', () => {
  secure.configureProvider(makeFake(true));
  assert.strictEqual(secure.decryptSecret(''), '');
  assert.strictEqual(secure.decryptSecret(null), '');
  assert.strictEqual(secure.encryptSecret(''), '');
});

secure.configureProvider(null);   // 恢复默认，避免影响其他测试文件
console.log('== ' + passed + ' 个用例全部通过 ==');
