// README 截图启动器：清掉宿主注入的 ELECTRON_RUN_AS_NODE（会让 Electron 变纯 Node）与死代理
const { spawn } = require('child_process');
const path = require('path');
const electron = path.join(__dirname, '..', 'app', 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.HTTP_PROXY;
delete env.HTTPS_PROXY;
env.KEEPSAKE_CAPTURE = '1';
// GPU/渲染参数用 DGO_FLAGS 传入（空格分隔），便于穷举：
//   ""            纯净启动（依赖 main.js 的 disableHardwareAcceleration）
//   "--single-process"  单进程模式（无独立 GPU/渲染进程，沙箱 GPU 崩溃时可绕开）
const flags = (process.env.DGO_FLAGS || '--single-process').split(' ').filter(Boolean);
const p = spawn(electron, [...flags, path.join(__dirname, '..', 'app')], { env, stdio: 'inherit' });
p.on('exit', c => process.exit(c == null ? 0 : c));
