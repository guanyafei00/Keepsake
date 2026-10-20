// 站点策略层：风控参数做成「数据」，可热更、可学习，不发版就能调
// 设计：
//   DEFAULTS  内置兜底策略（发版更新）
//   site-state.json  运行时学习到的档位（自适应退避的结果），持久化
//   未来：远程 rules.json 拉取后合并进运行时策略（远程 > 学习 > 内置）
const path = require('path');
const fs = require('fs');
const https = require('https');
const { atomicWrite, readJson } = require('./jsonfile');

let statePath = null;
let state = {};          // host -> { level, failures, breakerUntil }

function configure({ stateFile }) {
  statePath = stateFile;
  state = readJson(stateFile, {}, v => v && typeof v === 'object' && !Array.isArray(v));
  if (!state._hosts) state._hosts = {};
  loadPersistedRemote();   // 启动即恢复上次远程规则（远程 > 学习 > 内置 的「远程」层）
}

function save() {
  if (!statePath) return;
  try { atomicWrite(statePath, JSON.stringify(state, null, 2)); } catch (e) { console.warn('[strategy] save fail:', e.message); }
}

// 内置兜底策略：按 host 后缀匹配（子域自动命中，如 space.bilibili.com → bilibili.com）
const DEFAULTS = [
  { host: 'bilibili.com', sleep: 3, breakerThreshold: 3, breakerCooldownMs: 10 * 60 * 1000,
    backoffLevels: [3, 6, 15, 40], note: 'B站：连续请求触发 5min 惩罚，必须带间隔' },
  { host: 'pixiv.net', sleep: 1, breakerThreshold: 4, breakerCooldownMs: 15 * 60 * 1000,
    backoffLevels: [1, 3, 8, 20] },
  { host: 'x.com', sleep: 2, breakerThreshold: 3, breakerCooldownMs: 15 * 60 * 1000,
    backoffLevels: [2, 5, 12, 30] },
  { host: 'twitter.com', sleep: 2, breakerThreshold: 3, breakerCooldownMs: 15 * 60 * 1000,
    backoffLevels: [2, 5, 12, 30] },
  { host: 'instagram.com', sleep: 2, breakerThreshold: 3, breakerCooldownMs: 20 * 60 * 1000,
    backoffLevels: [2, 6, 15, 40] },
  { host: 'weibo.com', sleep: 2, breakerThreshold: 3, breakerCooldownMs: 10 * 60 * 1000,
    backoffLevels: [2, 5, 12, 30] },
];
const FALLBACK = { sleep: 1, breakerThreshold: 5, breakerCooldownMs: 5 * 60 * 1000, backoffLevels: [1, 3, 8, 20] };

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}
function matchHost(url) {
  const h = hostOf(url);
  if (!h) return null;
  return DEFAULTS.find(d => h === d.host || h.endsWith('.' + d.host)) || null;
}
function stateKey(url) {
  const m = matchHost(url);
  return m ? m.host : (hostOf(url) || '_direct');
}

// 取当前生效策略：档位决定 sleep（自适应退避的核心）
function forUrl(url) {
  const m = matchHost(url);
  const base = m ? { sleep: m.sleep, breakerThreshold: m.breakerThreshold, breakerCooldownMs: m.breakerCooldownMs, backoffLevels: m.backoffLevels } : { ...FALLBACK };
  const key = stateKey(url);
  const st = state._hosts[key] || { level: 0, failures: 0, breakerUntil: 0 };
  const level = Math.min(st.level || 0, (base.backoffLevels || FALLBACK.backoffLevels).length - 1);
  return { key, ...base, sleep: (base.backoffLevels || FALLBACK.backoffLevels)[level], level, failures: st.failures || 0, breakerUntil: st.breakerUntil || 0 };
}

function isBreakered(url) {
  const st = state._hosts[stateKey(url)];
  return !!(st && st.breakerUntil && Date.now() < st.breakerUntil);
}
function breakerRemainMs(url) {
  const st = state._hosts[stateKey(url)];
  return st && st.breakerUntil ? Math.max(0, st.breakerUntil - Date.now()) : 0;
}

// 失败：failures++；连续超阈值 → 熔断 + 档位升级
function reportFailure(url, isRateLimit) {
  const key = stateKey(url);
  const m = matchHost(url);
  // validRule 只校验已存在的字段，远程规则可整体省略这三项——
  // 缺失时必须回落 FALLBACK，否则 Date.now()+undefined=NaN → isBreakered 恒 false，熔断静默失效；
  // backoffLevels 缺失更会在档位升级时直接 TypeError
  const threshold = (m && m.breakerThreshold !== undefined) ? m.breakerThreshold : FALLBACK.breakerThreshold;
  const cooldown = (m && m.breakerCooldownMs !== undefined) ? m.breakerCooldownMs : FALLBACK.breakerCooldownMs;
  const levels = (m && m.backoffLevels) ? m.backoffLevels : FALLBACK.backoffLevels;
  const st = state._hosts[key] || (state._hosts[key] = { level: 0, failures: 0, breakerUntil: 0 });
  st.failures = (st.failures || 0) + 1;
  if (isRateLimit) st.level = Math.min((st.level || 0) + 1, levels.length - 1);
  if (st.failures >= threshold) {
    st.breakerUntil = Date.now() + cooldown;
    st.failures = 0;
  }
  save();
  return st;
}

// 成功：failures 清零；连续成功缓降档位
let _successStreak = {};
function reportSuccess(url) {
  const key = stateKey(url);
  const st = state._hosts[key];
  if (st) {
    st.failures = 0;
    _successStreak[key] = (_successStreak[key] || 0) + 1;
    if (_successStreak[key] >= 3 && (st.level || 0) > 0) {
      st.level--;
      _successStreak[key] = 0;
    }
    save();
  }
}

// ===== 远程热更（风控策略变化的「数据层」防线）=====
// 规则来源优先级：远程 rules.json > 持久化的上次远程规则 > 内置 DEFAULTS
// 规则文件格式：{ "version": "2026-10-05", "rules": [ { "host": "bilibili.com", "sleep": 5, ... } ] }

function remoteFile() {
  return statePath ? path.join(path.dirname(statePath), 'remote-rules.json') : null;
}

// 规则结构校验：host 必填且形如域名；数值参数限界（防远程脏数据搞炸策略层）；
// 字段白名单（未知字段不透传）；sleep 下限 1s（防规则服务器被劫持后关闭限速硬撞风控）
const RULE_FIELDS = ['host', 'sleep', 'backoffLevels', 'breakerThreshold', 'breakerCooldownMs', 'note'];
function validRule(r) {
  if (!r || typeof r.host !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(r.host)) return false;
  if (typeof r.sleep !== 'number' || r.sleep < 1 || r.sleep > 600) return false;
  if (r.backoffLevels !== undefined &&
      (!Array.isArray(r.backoffLevels) || !r.backoffLevels.length ||
       !r.backoffLevels.every(n => typeof n === 'number' && n >= 0 && n <= 3600))) return false;
  if (r.breakerThreshold !== undefined && (typeof r.breakerThreshold !== 'number' || r.breakerThreshold < 1 || r.breakerThreshold > 100)) return false;
  if (r.breakerCooldownMs !== undefined && (typeof r.breakerCooldownMs !== 'number' || r.breakerCooldownMs < 0 || r.breakerCooldownMs > 24 * 3600 * 1000)) return false;
  if (r.note !== undefined && typeof r.note !== 'string') return false;
  return true;
}

// 应用远程规则并持久化（meta.persist=false 时不落盘，供测试）
function applyRemoteRules(rules, meta = {}) {
  if (!Array.isArray(rules)) return { applied: 0, total: 0, error: 'rules 必须是数组' };
  const valid = rules.filter(validRule);
  for (const raw of valid) {
    // 字段白名单：未知字段不进策略层（
    const r = {};
    for (const k of RULE_FIELDS) if (raw[k] !== undefined) r[k] = raw[k];
    // forUrl 的 sleep 取自 backoffLevels[level]：远程只给 sleep 时，把它写进退避序列 0 档（其余档位沿用现有），否则改动不生效
    if (typeof r.sleep === 'number' && !Array.isArray(r.backoffLevels)) {
      const existing = DEFAULTS.find(d => d.host === r.host);
      const levels = (existing && existing.backoffLevels) || FALLBACK.backoffLevels;
      r.backoffLevels = [r.sleep, ...levels.slice(1)];
    }
    const i = DEFAULTS.findIndex(d => d.host === r.host);
    if (i >= 0) DEFAULTS[i] = { ...DEFAULTS[i], ...r, _src: 'remote' };
    else DEFAULTS.push({ note: '', ...r, _src: 'remote' });
  }
  if (meta.persist !== false && valid.length && remoteFile()) {
    try {
      atomicWrite(remoteFile(), JSON.stringify({ appliedAt: Date.now(), version: meta.version || null, rules: valid }, null, 2));
    } catch (e) { console.error('[strategy] remote rules persist fail:', e.message); }
  }
  return { applied: valid.length, total: rules.length };
}

// 启动时恢复上次应用的远程规则（远程服务不可达也不丢策略）
function loadPersistedRemote() {
  const f = remoteFile();
  if (!f) return;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
    if (Array.isArray(j.rules)) applyRemoteRules(j.rules, { version: j.version, persist: false });
  } catch (e) {}
}

// 拉取远程规则（Node https 直连规则服务器，非 B 站域名，无 TLS 指纹问题）
function fetchRemoteRules(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(new Error('timeout')); }, timeoutMs);
    let req;
    try {
      req = https.get(url, { headers: { 'User-Agent': 'Keepsake/0.1 (+rules)' } }, res => {
        clearTimeout(timer);
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (!Array.isArray(j.rules)) return reject(new Error('rules 字段缺失'));
            resolve(j);
          } catch (e) { reject(new Error('bad json')); }
        });
      });
      req.on('error', e => { clearTimeout(timer); reject(e); });
    } catch (e) { clearTimeout(timer); reject(e); }
  });
}

function snapshot() { return { defaults: DEFAULTS, learned: state._hosts }; }

module.exports = { configure, forUrl, isBreakered, breakerRemainMs, reportFailure, reportSuccess, applyRemoteRules, loadPersistedRemote, fetchRemoteRules, snapshot };
