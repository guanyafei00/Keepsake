// 应用设置：userData/settings.json（当前仅 outDir，后续可扩展）
const fs = require('fs');
const path = require('path');
const { atomicWrite, readJson } = require('./jsonfile');

let FILE = null;
let data = {};

function configure({ file, defaultOutDir }) {
  FILE = file;
  data = readJson(FILE, {}, v => v && typeof v === 'object' && !Array.isArray(v));
  if (!data.outDir || typeof data.outDir !== 'string') data.outDir = defaultOutDir;
  // 通知设置默认值（notifyDone=开关，notifyMode=each 单项即通知 / batch 全部完成后统一通知）——坏值归一化
  if (data.notifyDone === undefined) data.notifyDone = true; else data.notifyDone = !!data.notifyDone;
  if (!['each', 'batch'].includes(data.notifyMode)) data.notifyMode = 'each';
  // #70①：磁盘剩余空间阈值 MB（下载目录所在盘低于该值任务挂起；0=关闭检测；未设置默认 1000）
  if (data.minFreeMB === undefined) data.minFreeMB = 1000;
  else data.minFreeMB = Math.max(0, Math.floor(Number(data.minFreeMB) || 0));
  // 队列并发数（同时下载任务数 1-5；旧版本无此键 → 默认 2，与历史行为一致）
  if (data.maxConcurrent === undefined) data.maxConcurrent = 2;
  else data.maxConcurrent = Math.min(5, Math.max(1, Math.floor(Number(data.maxConcurrent) || 2)));
  // 下载限速 MB/s（0=不限；仅对视频下载生效——yt-dlp 与直连引擎；gallery-dl 图文站走请求间隔策略不限速）
  if (data.rateLimitMB === undefined) data.rateLimitMB = 0;
  else data.rateLimitMB = Math.min(100, Math.max(0, Math.floor(Number(data.rateLimitMB) || 0)));
  // 浏览器登录态来源（''=不读浏览器，用 cookies.txt；chrome/edge/firefox/brave=引擎 --cookies-from-browser 直读该浏览器）。
  // 引擎原生能力（yt-dlp 与 gallery-dl 均支持），本程序只拼参数不碰 cookie 解密——Chromium v20 app-bound 加密无解，交给引擎处理
  if (!['', 'chrome', 'edge', 'firefox', 'brave'].includes(data.cookieBrowser)) data.cookieBrowser = '';
  // B站 线路/CDN 手动选线（''=自动不指定；baidu/tencent/aliyun/wscloud/huawei=国内 CDN 线路枚举）。
  // 注：当前 yt-dlp(2026.08.19) 的 bilibili 提取器未注册 cdn extractor-arg，该值经 --extractor-args "bilibili:cdn=<值>"
  // 透传为前向兼容钩子；待上游/分支支持后无需改码即可生效（详见 #15 说明）
  if (!['', 'baidu', 'tencent', 'aliyun', 'wscloud', 'huawei'].includes(data.biliLine)) data.biliLine = '';
  // 回溯并发数（同时回溯的订阅数 1-6；旧版本无此键 → 默认 3，与历史行为一致）
  if (data.backfillParallel === undefined) data.backfillParallel = 3;
  else {
    const n = Number(data.backfillParallel);
    data.backfillParallel = Math.min(6, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 3));
  }
  // 图站（gallery-dl）任务完成后自动把图片目录打包成 CBZ（漫画归档友好；0 依赖，用系统自带 bsdtar）
  if (data.autoCbz === undefined) data.autoCbz = false; else data.autoCbz = !!data.autoCbz;
  // 剪贴板监听（复制链接自动填入输入框；默认关——后台读剪贴板属于敏感行为，让用户显式打开）
  if (data.clipboardWatch === undefined) data.clipboardWatch = false; else data.clipboardWatch = !!data.clipboardWatch;
}

function get() { return { ...data }; }
function set(patch) {
  const p = { ...(patch || {}) };
  // minFreeMB 写入前归一化（负数/非数字归 0＝关闭检测；与 configure 启动路径同规则）
  if (p.minFreeMB !== undefined) p.minFreeMB = Math.max(0, Math.floor(Number(p.minFreeMB) || 0));
  // 并发/限速归一化（与 configure 同规则，双保险）
  if (p.maxConcurrent !== undefined) p.maxConcurrent = Math.min(5, Math.max(1, Math.floor(Number(p.maxConcurrent) || 2)));
  if (p.rateLimitMB !== undefined) p.rateLimitMB = Math.min(100, Math.max(0, Math.floor(Number(p.rateLimitMB) || 0)));
  // 浏览器来源/CBZ 开关归一化（与 configure 同规则，双保险）
  if (p.cookieBrowser !== undefined && !['', 'chrome', 'edge', 'firefox', 'brave'].includes(p.cookieBrowser)) p.cookieBrowser = '';
  if (p.biliLine !== undefined && !['', 'baidu', 'tencent', 'aliyun', 'wscloud', 'huawei'].includes(p.biliLine)) p.biliLine = '';
  if (p.backfillParallel !== undefined) {
    const n = Number(p.backfillParallel);
    p.backfillParallel = Math.min(6, Math.max(1, Number.isFinite(n) ? Math.floor(n) : 3));
  }
  if (p.autoCbz !== undefined) p.autoCbz = !!p.autoCbz;
  if (p.clipboardWatch !== undefined) p.clipboardWatch = !!p.clipboardWatch;
  Object.assign(data, p);
  try { atomicWrite(FILE, JSON.stringify(data, null, 2)); } catch (e) { console.warn('[settings] save fail:', e.message); }
  return get();
}
// 目录校验：存在/可创建/可写
function validateDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { ok: true };
  } catch (e) { return { ok: false, reason: e.message }; }
}

module.exports = { configure, get, set, validateDir };
