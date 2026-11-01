// #38 Playwright E2E 冒烟（_electron.launch 驱动真实 Keepsake 窗口）
// 运行：cd app && npm run test:e2e   （或 cd app/tools/e2e && npm test）
//
// 数据隔离：main.js 顶部已内置 KEEPSAKE_E2E 钩子（app.setPath('userData', tmpdir/keepsake-e2e-*)),
// 每次启动全新临时 profile，绝不读写用户真实数据。
// 环境要求（本机实测坑）：
//   - playwright 1.64.0 ↔ chromium-1248（%LOCALAPPDATA%/ms-playwright 已有 1248，装依赖时
//     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 防它另下浏览器）
//   - 宿主可能有死代理：本文件启动前清空 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY，避免 Chromium 走不通
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_DIR = path.resolve(__dirname, '..', '..');   // app/ 目录（package.json main 所在）
const HEADLESS = false;   // Electron 无头无意义，保持 headed（CI 可后续加 xvfb）

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; results.push('PASS | ' + name); console.log('PASS | ' + name); }
  catch (e) { fail++; results.push('FAIL | ' + name + ' | ' + (e && e.message)); console.log('FAIL | ' + name + ' | ' + (e && e.message)); }
}

function launchEnv() {
  const env = { ...process.env };
  env.KEEPSAKE_E2E = '1';   // main.js：userData → 隔离 profile（绝不触碰用户真实数据）
  env.KEEPSAKE_E2E_DIR = E2E_PROFILE;   // 本次运行固定目录：重启用例可验证持久化
  // 清宿主死代理（有的话 Chromium 引擎下载/更新探测会全部走死）
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
  // 关键：宿主 CLI 环境常带 ELECTRON_RUN_AS_NODE=1（WorkBuddy/VSCode 终端实测有）——继承下去
  // electron.exe 会按纯 node 跑，require('electron') 拿不到 protocol/app，进程秒退（"Process failed to launch!"）
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// 启动 app 并等主窗口渲染完成（侧边栏 + 任务输入框出现）。返回 { app, win }
// 本次运行级固定 profile：三次启动共用同一隔离目录（②的重启持久化用例需要）；进程结束清理
const E2E_PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'keepsake-e2e-run-'));
async function launchApp() {
  const app = await electron.launch({
    args: ['.'],
    cwd: APP_DIR,
    headless: HEADLESS,
    env: launchEnv(),
    timeout: 90 * 1000,
  });
  const win = await app.firstWindow();
  // 主窗口渲染就绪：任务输入框 + 侧边栏导航可见（首启有引擎引导/迁移逻辑，放宽到 60s）
  await win.waitForSelector('#urls', { timeout: 60 * 1000 });
  await win.waitForSelector('.sidebar .nav[data-page="tasks"]', { timeout: 10 * 1000 });
  return { app, win };
}

(async () => {
  // ---- ① 启动 → 主窗口渲染关键 UI ----
  let ctx = null;
  await t('① app 启动 → 主窗口渲染（侧边栏导航 / 任务区 / 页脚状态）', async () => {
    ctx = await launchApp();
    const { win } = ctx;
    const logo = (await win.textContent('.sidebar .logo')) || '';
    if (!logo.includes('Keepsake')) throw new Error('侧边栏 logo 不是 Keepsake: ' + logo);
    const navs = await win.$$eval('.sidebar .nav', els => els.map(e => e.textContent.trim()));
    for (const want of ['任务队列', '订阅', '媒体库', '设置']) {
      if (!navs.some(n => n.includes(want))) throw new Error('侧边栏缺导航: ' + want + ' 实际: ' + navs.join('|'));
    }
    if (!(await win.isVisible('#urls'))) throw new Error('任务输入框不可见');
    if (!(await win.isVisible('#btnAdd'))) throw new Error('「加入队列」按钮不可见');
  });
  await ctx.app.close();
  await new Promise(r => setTimeout(r, 1500));   // 留给进程退出/锁释放

  // ---- ② 设置开关持久化：autoCbz 点开 → 重启 → 状态保留 ----
  await t('② 设置页 autoCbz 开关 → 点开 → 重启后状态持久', async () => {
    // 第一次启动：切设置页，点开开关
    let { app, win } = await launchApp();
    await win.click('.sidebar .nav[data-page="settings"]');
    await win.waitForSelector('#autoCbzChk', { timeout: 10 * 1000 });
    const before = await win.isChecked('#autoCbzChk');
    if (before) throw new Error('autoCbz 默认应为关（false），实际已开——用例前提不成立');
    await win.click('#autoCbzChk');   // change → saveAutoCbz(true) → IPC → settings.json 落盘
    await win.waitForTimeout(1200);   // 等 IPC 往返 + 同步落盘完成
    await app.close();
    await new Promise(r => setTimeout(r, 1500));
    // 第二次启动：开关状态应从 settings.json 恢复为开
    const ctx2 = await launchApp();
    win = ctx2.win; app = ctx2.app;
    await win.click('.sidebar .nav[data-page="settings"]');
    await win.waitForSelector('#autoCbzChk', { timeout: 10 * 1000 });
    const after = await win.isChecked('#autoCbzChk');
    await app.close();
    if (!after) throw new Error('重启后 autoCbz 开关未保持开启（settings.json 持久化断裂）');
  });
  await new Promise(r => setTimeout(r, 1500));

  // ---- ③ 粘贴无效链接 → 探测条走 invalid 态（离线确定路径：视频号链接 classify 直接 invalid，零网络）----
  await t('③ 粘贴 invalid URL → 探测条显示「无法识别」（离线断言）', async () => {
    // 注：不用 example.com——unknown 域会走 yt-dlp 网络探测（30s 且依赖网络），离线不确定；
    // channels.weixin.qq.com 在 identify.classify 里直接判 invalid（受控浏览器专属），零网络、确定
    const { app, win } = await launchApp();
    await win.fill('#urls', 'https://channels.weixin.qq.com/profile/not-a-real-one');
    await win.waitForSelector('#probeStrip', { state: 'visible', timeout: 15 * 1000 });
    const strip = await win.textContent('#probeStrip');
    await app.close();
    if (!/无法识别/.test(strip || '')) throw new Error('探测条未走 invalid 态: ' + strip);
  });

  console.log('----');
  console.log(pass + ' passed, ' + fail + ' failed');
  try { fs.rmSync(E2E_PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => {
  // 启动器级失败（_electron.launch 起不来等）：如实退出非零，不硬凑通过
  console.error('E2E launcher error:', e && e.message);
  console.log(results.join('\n'));
  process.exit(2);
});
