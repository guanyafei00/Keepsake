// 文章引擎 M-A1 原型：单篇公众号文章 → 整页快照落盘
// 运行：electron tools/article-proto.js <文章URL> <输出目录>
// 产物：<outdir>/<标题>/index.html + meta.json + assets/（图片本地化）+ article.md
//
// M-A1 只求跑通闭环，验证四件事：
//   1. 公众号文章页在 Electron 里加载无阻（公开页、无登录墙）
//   2. 正文/标题/作者/时间能按站点规则提取（#js_content / #activity-name / #js_name）
//   3. 图片懒加载的真实地址在 data-src（src 是灰色占位）——这是公众号最大的坑
//   4. 图片带 Referer 下载可落地（mmbiz.qpic.cn 防盗链）
// 跑通后这套逻辑原样搬进 lib/article.js 接入队列。

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// URL 必须走环境变量 ART_URL 传入：实测 electron.exe 的 argv 里只要出现
// https://... 参数就启动失败退 127（本机宿主环境特有，机制未明，2026-10-26）。
// 运行：ART_URL=<文章URL> electron tools/article-proto.js [输出目录]
const URL_IN = process.env.ART_URL;
const OUT_ROOT = process.argv[2] || path.join(__dirname, 'article-out');
if (!URL_IN) { console.error('用法: ART_URL=<文章URL> electron tools/article-proto.js [输出目录]'); process.exit(1); }

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 图片下载的 Referer 规则表（M-A2 会挪进 lib/article-sites.js）
function refererFor(u) {
  if (u.includes('mmbiz.qpic.cn')) return 'https://mp.weixin.qq.com/';
  if (u.includes('zhimg.com')) return 'https://www.zhihu.com/';
  if (u.includes('hdslb.com')) return 'https://www.bilibili.com/';
  return undefined;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  console.log('[1/5] 打开隐藏窗口加载文章…');
  const win = new BrowserWindow({
    show: false, width: 1280, height: 2400,
    webPreferences: { javascript: true, images: true },
  });
  try {
    await win.loadURL(URL_IN, { userAgent: UA });
  } catch (e) {
    // loadURL 对部分跳转会抛 ERR_ABORTED，页面其实已加载，别当失败
    console.log('  loadURL 提示(可忽略):', e.message.slice(0, 80));
  }
  // 等图片懒加载触发：滚到底再回顶
  await win.webContents.executeJavaScript(`
    (async () => {
      const h = document.body.scrollHeight;
      for (let y = 0; y < h; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
      window.scrollTo(0, 0);
    })()
  `);
  await sleep(1500);

  console.log('[2/5] 提取正文与图片…');
  // 关键：在 DOM 里直接把真实图片地址换成 __KS_IMG_n__ 占位符再序列化。
  // 不能事后对 outerHTML 做字符串替换——序列化会把 & 转义成 &amp;，URL 永远匹配不上（M-A1 实测踩坑）。
  const data = await win.webContents.executeJavaScript(`
    (() => {
      const q = (s) => document.querySelector(s);
      const content = q('#js_content') || q('article') || document.body;
      const imgs = [...content.querySelectorAll('img')];
      const list = [];
      imgs.forEach((im) => {
        const real = im.getAttribute('data-src') || im.getAttribute('src') || '';
        if (real && real.startsWith('http')) {
          im.setAttribute('src', '__KS_IMG_' + list.length + '__');
          im.removeAttribute('data-src');
          list.push({ real });
        }
      });
      // 标题/作者/时间：公众号专用选择器，兜底取 meta
      const meta = (n) => q(\`meta[property="\${n}"]\`)?.content || q(\`meta[name="\${n}"]\`)?.content || '';
      return {
        url: location.href,
        title: (q('#activity-name')?.textContent || meta('og:title') || document.title).trim().replace(/\\s+/g, ' '),
        author: (q('#js_name')?.textContent || meta('og:article:author') || '').trim(),
        publishTime: (q('#publish_time')?.textContent || meta('article:published_time') || '').trim(),
        contentHtml: content.outerHTML,
        text: content.innerText,
        images: list,
      };
    })()
  `);

  console.log(`  标题: ${data.title}`);
  console.log(`  作者: ${data.author} · 时间: ${data.publishTime}`);
  console.log(`  正文 ${data.text.length} 字 · 图片 ${data.images.length} 张`);

  console.log('[3/5] 图片本地化下载…');
  const slug = (data.title || 'article').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  const dir = path.join(OUT_ROOT, slug);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  const net = require('electron').net;
  const ext = (u) => { const m = u.match(/wx_fmt=(\w+)/) || u.match(/\.(jpe?g|png|gif|webp)/i); return m ? (m[1] === 'jpeg' ? 'jpg' : m[1]) : 'jpg'; };
  let ok = 0, fail = 0;
  const swap = new Map();   // 占位符 → 最终引用（本地路径或回退原URL）
  for (let i = 0; i < data.images.length; i++) {
    const u = data.images[i].real;
    const ph = `__KS_IMG_${i}__`;
    try {
      const headers = {};
      const ref = refererFor(u);
      if (ref) headers.Referer = ref;
      const resp = await net.fetch(u, { headers, userAgent: UA });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = Buffer.from(await resp.arrayBuffer());
      const name = `img-${String(i + 1).padStart(3, '0')}.${ext(u)}`;
      fs.writeFileSync(path.join(dir, 'assets', name), buf);
      swap.set(ph, `assets/${name}`);
      ok++;
    } catch (e) {
      fail++;
      swap.set(ph, u);   // 下载失败：占位符换回原 URL（诚实降级，联网仍可看）
      console.log(`  ✗ 图 ${i + 1}: ${e.message.slice(0, 60)} — 保留原URL`);
    }
  }
  console.log(`  成功 ${ok} / 失败 ${fail}`);

  console.log('[4/5] 替换引用并落盘…');
  let html = data.contentHtml;
  for (const [ph, ref2] of swap) html = html.split(ph).join(ref2);
  const page = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${data.title}</title>
<style>body{max-width:680px;margin:40px auto;padding:0 20px;font:16px/1.9 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#222}
h1{font-size:24px;line-height:1.4} .meta{color:#888;font-size:14px;margin:12px 0 28px;border-bottom:1px solid #eee;padding-bottom:16px}
img{max-width:100%;height:auto;border-radius:6px} blockquote{border-left:3px solid #ddd;margin:0;padding-left:14px;color:#666}
pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto} .src-note{margin-top:48px;color:#aaa;font-size:13px}</style>
</head><body>
<h1>${data.title}</h1>
<div class="meta">${data.author || ''} · ${data.publishTime || ''}</div>
${html}
<div class="src-note">原文：${data.url}<br>由 Keepsake 文章引擎存档 · ${new Date().toLocaleString('zh-CN')}</div>
</body></html>`;
  fs.writeFileSync(path.join(dir, 'index.html'), page);

  // article.md 基础版（M-A1：段落纯文本；M-A2 换 Readability 结构化转换）
  const md = `# ${data.title}\n\n> ${data.author || ''} · ${data.publishTime || ''}\n> 原文：${data.url}\n\n${data.text}\n`;
  fs.writeFileSync(path.join(dir, 'article.md'), md);

  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    url: data.url, title: data.title, author: data.author, publishTime: data.publishTime,
    engine: 'article-proto', archivedAt: new Date().toISOString(),
    imagesTotal: data.images.length, imagesLocal: ok, imagesFailed: fail,
  }, null, 2));

  console.log(`[5/5] 完成 → ${dir}`);
  win.destroy();
  app.exit(0);
}).catch((e) => { console.error('失败:', e); app.exit(1); });
