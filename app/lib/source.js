// 来源索引（用户需求）：媒体文件 → 来源链接/下载方式（订阅 or 单条）
// 数据来源：队列任务完成时记录（任务知道 URL 与产出的全部文件路径）。
// 存 userData/source-index.json——下载目录保持纯净（不往里面写 sidecar 文件）。
// 局限（诚实声明）：只对索引建立之后的下载生效，历史文件无来源记录。
const { atomicWrite, readJson } = require('./jsonfile');

let FILE = null;
let map = {};
const MAX = 20000;   // 上限防无限膨胀：超过时淘汰最旧的记录

function configure({ file }) {
  FILE = file;
  map = readJson(FILE, {}, v => v && typeof v === 'object' && !Array.isArray(v));
}

function save() {
  try {
    const keys = Object.keys(map);
    if (keys.length > MAX) {
      keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
      for (const k of keys.slice(0, keys.length - MAX)) delete map[k];
    }
    atomicWrite(FILE, JSON.stringify(map));
  } catch (e) { /* 日志索引写失败不影响主流程 */ }
}

// files: 单路径或路径数组；meta: { url, via: 'sub'|'task', subId, title }
function record(files, meta) {
  const list = Array.isArray(files) ? files : [files];
  let dirty = false;
  for (const f of list) {
    if (!f || typeof f !== 'string') continue;
    map[f] = { ...meta, at: Date.now() };
    dirty = true;
  }
  if (dirty) save();
  return dirty;
}

function get(p) { return map[p] || null; }
function size() { return Object.keys(map).length; }

module.exports = { configure, record, get, size };
