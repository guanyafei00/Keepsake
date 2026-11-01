// JSON 持久化：任务队列重启恢复 + 站点档位（策略层自持久化）
const fs = require('fs');
const path = require('path');
const { atomicWrite, readJson } = require('./jsonfile');

let tasksPath = null;
let _saveTimer = null;
let _pendingItems = null;
function configure({ userData }) {
  tasksPath = path.join(userData, 'tasks.json');
}
function load() {
  // 必须是数组：损坏/类型不对时坏文件已被隔离为 .bad-*，返回空并让 save 重建
  return readJson(tasksPath, [], Array.isArray);
}
// 1s 防抖（下载高峰每次进度推送都全量同步写盘太重；flushNow 在退出前强制落盘
function save(items) {
  _pendingItems = items;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; flushNow(); }, 1000);
}
function flushNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (_pendingItems === null || !tasksPath) return;
  const items = _pendingItems;
  _pendingItems = null;
  try {
    atomicWrite(tasksPath, JSON.stringify(items.map(({ _child, _wasActive, ...rest }) => rest)));
  } catch (e) { console.warn('[store] save fail:', e.message); }
}

// #39 启动恢复判定（纯函数，便于单测）：
//   cleanExitFlagExists=true → 上次正常退出（调用方负责消费/清除标记），无需异常处理；
//   否则视为上次异常退出——tasks.json 有历史任务（非空）且存在未达终态任务时返回 abnormalExit=true，
//   由调用方把这些任务标记 interrupted 并弹恢复横幅。首次启动（无历史）/ 全部终态 → 均不提示。
// 注：上次遗留的 interrupted 状态任务（用户没恢复也没忽略）本轮同样计入，保持可恢复入口。
const NON_TERMINAL_STATUS = ['queued', 'downloading', 'held', 'interrupted'];
function startupRecovery({ cleanExitFlagExists, tasks }) {
  const list = Array.isArray(tasks) ? tasks : [];
  const interrupted = list.filter(t => t && NON_TERMINAL_STATUS.includes(t.status));
  return {
    abnormalExit: !cleanExitFlagExists && list.length > 0 && interrupted.length > 0,
    interrupted,   // 需标记 interrupted 的持久化任务引用（调用方按 id 定位）
    cleanExit: !!cleanExitFlagExists,
  };
}

module.exports = { configure, load, save, flushNow, startupRecovery, NON_TERMINAL_STATUS };
