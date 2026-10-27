// 文章引擎 CLI 自测（QA 入口）：单篇抓取 → 4 件套落盘，打印结果
//
// 用法（URL 必须走环境变量：electron.exe 的 argv 里出现 https:// 参数会启动失败退 127——
// 本机宿主环境特有，机制未明，2026-10-26）：
//   cd app
//   ART_URL='https://mp.weixin.qq.com/s/xxxx' env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
//     ./node_modules/electron/dist/electron.exe tools/article-test.js [输出目录]
//
// 删帖复查自测（对已存档目录跑）：
//   ART_DIR='.../article/作者/标题' electron tools/article-test.js --recheck

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const article = require('../lib/article');

const URL_IN = process.env.ART_URL;
const DIR_IN = process.env.ART_DIR;
const OUT_ROOT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, 'article-out');
const IS_RECHECK = process.argv.includes('--recheck');

if (!URL_IN && !DIR_IN) {
  console.error('用法: ART_URL=<文章URL> electron tools/article-test.js [输出目录]');
  console.error('复查: ART_DIR=<已存档文章目录> electron tools/article-test.js --recheck');
  process.exit(1);
}

// 隐藏窗口销毁后会触发 Electron 默认「最后一个窗口关闭 → 自动退出(码 0)」，
// 抢在下方 setTimeout(app.exit(1)) 之前——失败退出码永远变 0（QA 实测踩坑），必须压掉
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    if (IS_RECHECK) {
      const r = await article.recheck({ dir: DIR_IN });
      console.log('RECHECK:', JSON.stringify(r));
      setTimeout(() => app.exit(0), 200);
      return;
    }
    console.log('[article-test] 抓取:', URL_IN);
    const r = await article.fetchArticle({
      url: URL_IN,
      outDir: OUT_ROOT,
      onProgress: (pct, note) => { if (pct % 10 === 0 || pct === 100) console.log(`  [${String(pct).padStart(3)}%] ${note || ''}`); },
    });
    console.log('OK →', r.dir);
    console.log('  标题:', r.meta.title);
    console.log('  作者:', r.meta.author || '（空）', '· 时间:', r.meta.publishTime || '（空）');
    console.log('  图片:', r.meta.imagesLocal + '/' + r.meta.imagesTotal, '本地化', r.meta.imagesFailed ? '（' + r.meta.imagesFailed + ' 张失败保留原URL）' : '');
    for (const f of ['index.html', 'article.md', 'meta.json']) {
      const p = path.join(r.dir, f);
      console.log('  ' + f + ':', fs.existsSync(p) ? fs.statSync(p).size + ' bytes' : '缺失!');
    }
    setTimeout(() => app.exit(0), 200);
  } catch (e) {
    console.error('FAIL [' + (e.kind || '?') + ']:', e.human || e.message);
    setTimeout(() => app.exit(1), 200);
  }
});
