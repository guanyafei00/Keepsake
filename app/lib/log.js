// 文件日志（主进程关键事件落盘 userData/logs/，出问题有据可查
// 策略：按天一个文件（keepsake-YYYY-MM-DD.log），自动清理 7 天前的旧日志；
// 单条截断 500 字符防异常输出把日志撑爆；任何写入失败静默（日志绝不能反过来影响主流程）
const fs = require('fs');
const path = require('path');

let DIR = null;

function init(dir) {
  try {
    DIR = dir;
    fs.mkdirSync(dir, { recursive: true });
    prune();
  } catch (e) { DIR = null; }
}

// 本地日期（不用 toISOString——UTC 会在北京时间早上把日志记到"昨天"）
function localDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function line(level, tag, msg) {
  if (!DIR) return;
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const text = `[${localDate(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] [${level}] [${tag}] ${String(msg).replace(/\s+/g, ' ').slice(0, 500)}\n`;
  try { fs.appendFileSync(path.join(DIR, 'keepsake-' + localDate(d) + '.log'), text); } catch (e) {}
}

const info = (tag, msg) => line('INFO', tag, msg);
const warn = (tag, msg) => line('WARN', tag, msg);
const error = (tag, msg) => line('ERROR', tag, msg);

// 只保留最近 7 天
function prune() {
  try {
    const cut = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(DIR)) {
      const m = /^keepsake-(\d{4}-\d{2}-\d{2})\.log$/.exec(f) || /^dgo-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);   // 兼容改名前的旧日志一并清理
      if (m && new Date(m[1] + 'T00:00:00').getTime() < cut) { try { fs.unlinkSync(path.join(DIR, f)); } catch (e) {} }
    }
  } catch (e) {}
}

module.exports = { init, info, warn, error };
