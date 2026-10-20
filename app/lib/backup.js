// 数据安全包（#70 增长①）：设置/订阅一键导出导入（换机搬家）
// 迁移包 = JSON：settings（outDir/notify/AI 配置等）+ subs（含 known/lastSeen，增量比对不丢）。
// 不含：cookies（风控指纹敏感，跨机应重登）、转写模型（大文件，首次使用自动下载）、媒体文件本体。
// 导入策略：订阅按 URL 去重合并（已有的跳过），设置覆盖合并——绝不静默删除现有数据。
const fs = require('fs');

const BUNDLE_VERSION = 1;

// settings 恢复白名单（防导入包注入未知键）。补 minFreeMB（#70① 新增设置项）
const SETTINGS_KEYS = ['outDir', 'notifyDone', 'notifyMode', 'aiUrl', 'aiKey', 'aiModel', 'asrMirror', 'minFreeMB', 'maxConcurrent', 'rateLimitMB'];

function buildBundle({ settings, subs }) {
  return {
    app: 'Keepsake', bundleVersion: BUNDLE_VERSION, at: new Date().toISOString(),
    // 明文 Key 风险提示（消费端应展示/保留该字段）
    _warning: '本文件含 AI API Key 明文，请妥善保管，不要分享',
    settings, subs,
  };
}

// 导出：paths = { settingsFile, subsFile }；返回 { ok, bundle, counts } 或 { ok:false, reason }
function collect(paths) {
  try {
    const settings = JSON.parse(fs.readFileSync(paths.settingsFile, 'utf-8'));
    let subs = [];
    try { subs = JSON.parse(fs.readFileSync(paths.subsFile, 'utf-8')); } catch (e) {}
    if (!Array.isArray(subs)) subs = [];
    const bundle = buildBundle({
      settings: Object.fromEntries(SETTINGS_KEYS.filter(k => settings[k] !== undefined).map(k => [k, settings[k]])),
      subs: subs.map(s => {
        // 轻量化：known/goneSeen 是增量比对核心要带上；瞬时状态不带
        const { failStreak, ...rest } = s;
        return rest;
      }),
    });
    return { ok: true, bundle, counts: { subs: bundle.subs.length, settings: Object.keys(bundle.settings).length } };
  } catch (e) { return { ok: false, reason: '读取配置失败: ' + e.message }; }
}

// 导入：settingsSetter(patch) 写设置；subsAdd(url, name, extra) 走正常添加流程（复用分类/命名），
//   extra = 包内订阅的 group/intervalMin/userPaused/autoTranscribe（调用方自行恢复）；
// 返回摘要。全程逐条防御：单个坏元素只记 errors，绝不中断整体（
async function apply(bundle, { settingsSetter, subsAdd, subsUrls }) {
  if (!bundle || !['Keepsake', 'DGO'].includes(bundle.app) || !bundle.bundleVersion) return { ok: false, reason: '不是有效的 Keepsake 迁移包（兼容旧版 DGO 包）' };
  const out = { settingsApplied: 0, subsAdded: 0, subsSkipped: 0, errors: [] };
  // 1) 设置覆盖合并（只动白名单键）
  const s = bundle.settings || {};
  const patch = {};
  for (const k of SETTINGS_KEYS) if (s[k] !== undefined && s[k] !== null && s[k] !== '') patch[k] = s[k];
  // outDir 必须是字符串，非字符串剔出 patch（目录合法性由调用方 settingsSetter 校验）
  if (patch.outDir !== undefined && typeof patch.outDir !== 'string') {
    delete patch.outDir;
    out.errors.push('outDir: 类型非法（应为字符串路径），已跳过');
  }
  if (Object.keys(patch).length) { settingsSetter(patch); out.settingsApplied = Object.keys(patch).length; }
  // 2) 订阅按 URL 合并（URL 已存在的跳过；导入包里的 URL 必须能被当前版本分类，失败的记 errors 不中断）
  // subs 非数组按空清单处理并报错
  let subsIn = bundle.subs;
  if (!Array.isArray(subsIn)) {
    if (subsIn !== undefined && subsIn !== null) out.errors.push('subs 字段类型非法（应为数组），已按空清单处理');
    subsIn = [];
  }
  const existing = new Set((subsUrls || []).map(u => String(u).trim()));
  for (const sub of subsIn) {
    try {
      if (!sub || typeof sub !== 'object' || Array.isArray(sub)) { out.errors.push('订阅条目格式非法，已跳过'); continue; }
      const url = String(sub.url || '').trim();
      if (!url) { out.errors.push(String(sub.name || '（无名订阅）') + ': URL 为空，已跳过'); continue; }
      if (existing.has(url)) { out.subsSkipped++; continue; }
      // 分组/频率/暂停/自动转写随包恢复（未带字段的旧包不受影响）
      const extra = {};
      if (sub.group !== undefined) extra.group = sub.group;
      if (sub.intervalMin !== undefined) extra.intervalMin = sub.intervalMin;
      if (sub.userPaused !== undefined) extra.userPaused = sub.userPaused;
      if (sub.autoTranscribe !== undefined) extra.autoTranscribe = sub.autoTranscribe;
      const r = subsAdd(url, sub.name || undefined, extra);
      if (r && r.ok) { out.subsAdded++; existing.add(url); }
      else out.errors.push((sub.name || url) + ': ' + ((r && r.reason) || '添加失败').slice(0, 60));
    } catch (e) { out.errors.push('订阅导入异常: ' + String(e.message || e).slice(0, 60)); }
  }
  return { ok: true, ...out };
}

module.exports = { collect, apply, SETTINGS_KEYS };
