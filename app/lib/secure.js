// R1.4 凭据加密：settings.json 中的 BYOK 密钥用 Electron safeStorage（Windows=DPAPI）加密落盘
// 设计：
//   - 密文格式 'enc:v1:<base64>'，前缀标识版本，后续换算法可升 v2 并兼容解旧
//   - 读取侧无差别：识别前缀就解密，没前缀原样返回（老用户明文 key 直接可用，启动时再迁移加密）
//   - 加密不可用（Linux 无 keyring 等场景）诚实降级为明文 + 警告，不假装加密
//   - safeStorage 通过 provider 注入：默认 Electron safeStorage；测试传 fake（CI 无 electron）
'use strict';

const ENC_PREFIX = 'enc:v1:';

// 默认 provider：Electron safeStorage（惰性 require——CI/纯 Node 环境没有 electron，不注入就别碰它）
let _provider = null;
function defaultProvider() {
  if (_provider) return _provider;
  try {
    const { safeStorage } = require('electron');
    _provider = {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (buf) => safeStorage.decryptString(buf),
    };
  } catch (e) {
    _provider = { isAvailable: () => false, encrypt: null, decrypt: null };
  }
  return _provider;
}

// 测试/特殊环境注入（传 null 恢复默认）
function configureProvider(p) { _provider = p; }

function isEncrypted(s) {
  return typeof s === 'string' && s.startsWith(ENC_PREFIX);
}

// 明文 → 密文；加密不可用时原样返回（调用方无需关心，落盘状态如实）
function encryptSecret(plain) {
  if (!plain || typeof plain !== 'string' || isEncrypted(plain)) return plain || '';
  const p = defaultProvider();
  if (!p.isAvailable || !p.isAvailable()) {
    console.warn('[secure] safeStorage 不可用，凭据只能明文存 settings.json（建议检查系统 keyring）');
    return plain;
  }
  try {
    return ENC_PREFIX + Buffer.from(p.encrypt(plain)).toString('base64');
  } catch (e) {
    console.warn('[secure] 加密失败，回落明文存储:', e.message);
    return plain;
  }
}

// 存储值 → 明文；识别不了就原样返回（兼容历史明文，迁移前始终可用）
function decryptSecret(stored) {
  if (!stored || typeof stored !== 'string') return '';
  if (!isEncrypted(stored)) return stored;
  const p = defaultProvider();
  if (!p.decrypt) return '';   // 理论不达：有密文必有 provider；防御性返回空而非抛错
  try {
    return p.decrypt(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
  } catch (e) {
    // DPAPI 是机器+用户绑定的：从别的机器/用户拷来的 settings.json 解不开——如实报错，不静默给空数据
    throw new Error('凭据解密失败（这份 settings.json 可能来自其他机器，DPAPI 不跨机器）：请到设置页重新填写 AI Key');
  }
}

// 启动迁移：明文 key → 加密回写（一次性，幂等）。migrate 返回 true 表示发生了一次改写
function migrateSecret(getStored, setStored) {
  const cur = getStored();
  if (!cur || isEncrypted(cur)) return false;
  const enc = encryptSecret(cur);
  if (enc === cur) return false;   // 加密不可用/失败，维持明文
  setStored(enc);
  return true;
}

module.exports = { ENC_PREFIX, isEncrypted, encryptSecret, decryptSecret, migrateSecret, configureProvider };
