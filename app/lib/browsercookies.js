// 浏览器登录态检测：Windows 文件锁预警（检测 + 人话提示，不做绕锁）
// 根因：Windows 下浏览器运行时对其 Cookie 数据库（如 Edge 的
// %LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Network\Cookies）加了拒绝共享的文件锁，
// yt-dlp / gallery-dl 的 --cookies-from-browser 都读不到（PermissionError Errno 13 /
// "Could not copy Chrome cookie database"，yt-dlp 官方 issue #7271）。
// gallery-dl 更隐蔽：只打一行 warning 就按游客态继续，用户完全无感知。
// 这是 OS 级硬限制，代码绕不过——本模块只负责「浏览器装没装 / 在不在运行」的检测与警告文案。
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 各浏览器：显示名 + 进程名（精确匹配用）+ 数据目录。
// 目录存在 = 已安装；进程名必须精确到浏览器本体——msedgewebview2.exe（WebView2 运行时，
// 很多桌面应用都带）不是 Edge 浏览器，模糊匹配会把「没开 Edge」误判成「Edge 在运行」
const BROWSERS = {
  chrome:  { name: 'Chrome',  exe: 'chrome.exe',  dir: () => path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data') },
  edge:    { name: 'Edge',    exe: 'msedge.exe',   dir: () => path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data') },
  firefox: { name: 'Firefox', exe: 'firefox.exe',  dir: () => path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles') },
  brave:   { name: 'Brave',   exe: 'brave.exe',    dir: () => path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'User Data') },
};

// 数据目录是否存在（= 已安装）。Firefox 特例：profiles.ini 在上一级目录，存在也算已装
function dirExists(dir) {
  try { return fs.existsSync(dir); } catch (e) { return false; }
}

// 浏览器状态检测：{ installed, running, name, exe }
// 只在 Windows 生效；其它平台不检测（直接当已装且没运行，绝不因检测打扰用户）
function browserState(browser) {
  const meta = BROWSERS[browser];
  if (!meta) return { installed: false, running: false, name: browser || '', exe: '' };
  const state = { installed: true, running: false, name: meta.name, exe: meta.exe };
  if (process.platform !== 'win32') return state;
  try {
    state.installed = dirExists(meta.dir())
      || (browser === 'firefox' && dirExists(path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'profiles.ini')));
  } catch (e) { state.installed = true; }   // 目录探测异常时按已装处理：宁可少提示，不可误报「未安装」
  // 进程检测：tasklist /FI 精确按映像名过滤（天然不会把 msedgewebview2.exe 算进 msedge.exe）。
  // execSync 必须 try/catch——tasklist 不存在/被拦截/超时会抛异常，一律按没运行处理
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq ' + meta.exe + '" /NH', { timeout: 8000, windowsHide: true });
    state.running = String(out).toLowerCase().includes(meta.exe.toLowerCase());
  } catch (e) { state.running = false; }
  return state;
}

// 人话警告：null = 无需提示（没选浏览器 / 已装且没在运行）
// 两种要提醒的情况：
//   1) 未安装 → --cookies-from-browser 必然失败（gallery-dl 还会静默回落游客态，必须提前说）
//   2) 已装但在运行 → Windows 文件锁导致读取失败（见文件头注释），让用户先完全退出浏览器
function cookieBrowserWarning(browser) {
  if (!browser || !BROWSERS[browser]) return null;
  const st = browserState(browser);
  if (!st.installed) {
    return '浏览器登录态：未检测到已安装的' + st.name + '，读取登录态会失败。请改选已安装的浏览器，或手动导入 cookies.txt';
  }
  if (st.running) {
    return '浏览器登录态：' + st.name + '正在运行，Windows 会锁定它的 Cookie 文件导致读取失败——请先完全退出' + st.name
      + '（任务管理器结束 ' + st.exe + ' 进程）再下载/订阅，或改用手动导入的 cookies.txt';
  }
  return null;
}

module.exports = { browserState, cookieBrowserWarning, BROWSERS };
