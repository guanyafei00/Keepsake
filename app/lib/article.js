// 文章抓取流水线（文章引擎核心，M-A2/A3 产品化）：
//   隐藏 BrowserWindow 加载页面 → 滚动触发懒加载 → 页内提取（站点规则 + Readability）
//   → 图片本地化（Referer 规则表防盗链）→ 4 件套落盘（index.html / article.md / meta.json / assets/）
//
// 交互约定：
//   fetchArticle({ url, outDir, onProgress, cancel }) → { dir, meta, fileCount }
//     onProgress(pct, note)  给队列更新进度条（pct 0-100）
//     cancel = { canceled }  取消标记：流水线在各步骤间与图片循环内自检，置位即退出
//     失败抛 ArticleError（kind: network/deleted/paywall/select/canceled，human 是对外人话文案）
//   recheck({ dir, cancel }) → { status: 'ok'|'deleted', edited: bool }（删帖检测最小版）
//
// 产品化吸收 M-A1 原型（app/tools/article-proto.js）实测踩坑：
//   1. 公众号图片真实地址在 data-src（src 是灰色占位）——正解 = 在 DOM 里把 src 换成
//      __KS_IMG_n__ 占位符并删 data-src 再序列化，下载后按占位符替换。绝不能事后对
//      outerHTML 做字符串替换：序列化把 & 转义成 &amp;，URL 永远匹配不上
//   2. 图片 Referer 规则表在 lib/article-sites.js（mmbiz/zhimg/hdslb）
//   3. 公众号「二次懒加载」尾部图：滚动后多等一轮，提取前再补滚一遍
//   4. 下载失败的图保留原 URL，诚实降级（meta.json 记 imagesFailed）
//   5. 绝不绕过付费墙/访问控制：提取不到正文时按「删帖/付费墙/版式失配」诚实分类报错

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { BrowserWindow } = require('electron');
const sites = require('./article-sites');
const { atomicWrite } = require('./jsonfile');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const LOAD_TIMEOUT_MS = 45 * 1000;    // 页面加载上限（含网络慢）
const IMG_TIMEOUT_MS = 30 * 1000;     // 单图下载上限
const MAX_IMAGES = 300;               // 单篇图片数上限（防异常页面把队列拖死）
const EXEC_TIMEOUT_MS = 30 * 1000;    // 页内脚本执行上限（页面死循环卡死时兜底，防窗口泄漏+队列假死）

// 删帖/违规标记（页面上出现即判「源头已删」；宽覆盖，误判代价低——只是标记，不动本地文件）
const DELETED_RE = /该内容已被发布者删除|该内容已被发布者撤回|此内容因违规无法查看|内容已被删除|内容不存在|此内容暂时无法查看|你访问的页面不存在|页面不存在或已删除|404 Not Found/;
// 付费墙/登录墙提示
const PAYWALL_RE = /需要付费|付费后可读|开通会员.{0,8}查看|登录后.{0,8}查看全文|付费专栏/;

const HUMAN = {
  network: '页面打不开：检查网络后重试，或确认链接在浏览器里能正常打开',
  deleted: '文章已被发布者删除或因违规无法查看',
  paywall: '该文章需要登录或付费才能阅读——Keepsake 不会绕过访问限制',
  select: '没有认出这篇文章的正文（页面版式可能变了），暂无法存档',
  canceled: '已取消',
};

class ArticleError extends Error {
  // kind 用于程序分类；human 用于对外文案（人话，渲染层直通显示）
  constructor(kind, detail) {
    super(detail ? HUMAN[kind] + '（' + String(detail).slice(0, 120) + '）' : HUMAN[kind]);
    this.kind = kind;
    this.human = HUMAN[kind] + (detail ? '（' + String(detail).slice(0, 120) + '）' : '');
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const checkCancel = (cancel) => { if (cancel && cancel.canceled) throw new ArticleError('canceled'); };

// ---- 页内脚本：@mozilla/readability 注入 ----
// Readability 是顶层 function 声明（非 IIFE），在页面上下文 executeJavaScript 即成全局；
// 免引 jsdom——直接喂页面原生 DOM（document.cloneNode(true)），0.6.0 版本 URI 取自 doc.baseURI
let _readabilitySrc = null;
function readabilitySrc() {
  if (_readabilitySrc !== null) return _readabilitySrc;
  try {
    _readabilitySrc = fs.readFileSync(
      path.join(__dirname, '..', 'node_modules', '@mozilla/readability', 'Readability.js'), 'utf-8');
  } catch (e) {
    _readabilitySrc = '';   // 依赖缺失（打包遗漏/杀软误删）：跳过 Readability，退站点规则/纯文本兜底
  }
  return _readabilitySrc;
}

// ---- 页内脚本：提取正文 + 图片占位符 + Markdown 转换 ----
// 占位符规则（__KS_IMG_n__）由 Node 侧替换；脚本内不用模板字符串/反引号，防转义地狱
function buildExtractJs(rule, url) {
  const ruleJson = JSON.stringify(rule ? { sel: rule.sel, exclude: rule.exclude } : null);
  return `
(() => {
  const rule = ${ruleJson};
  const q = s => { try { return document.querySelector(s); } catch (e) { return null; } };
  const metaTag = n => { const m = q('meta[property="' + n + '"]') || q('meta[name="' + n + '"]'); return (m && m.content) || ''; };
  const bodyText = document.body ? document.body.innerText : '';
  const DELETED_RE = ${DELETED_RE.toString()};
  const PAYWALL_RE = ${PAYWALL_RE.toString()};

  // ① Readability 先跑（在占位符污染 DOM 之前，clone 干净页面）
  let read = null, readErr = '';
  if (typeof Readability === 'function') {
    try { read = new Readability(document.cloneNode(true), { charThreshold: 100 }).parse(); }
    catch (e) { readErr = String(e && e.message || e); }
  }

  // ② 正文根：站点规则 > Readability > document.body
  let root = null, rootVia = '';
  if (rule && rule.sel && rule.sel.content) {
    const c = q(rule.sel.content);
    if (c) { root = c; rootVia = 'rule'; }
  }
  if (!root && read && read.content) {
    const d = document.createElement('div');
    d.innerHTML = read.content;
    root = d; rootVia = 'readability';
  }
  if (!root) { root = document.body; rootVia = 'body'; }

  // ③ 提取不到像样的正文：按删帖 / 付费墙 / 版式失配三分类诚实报错（绝不硬凑）
  // 阈值 20 字：只防「彻底提取失败」（预警/通知类短文正文也可能只有几十字，不能误伤）；
  // 删帖/付费墙标记检测在上面先行兜底，走到这里的基本都是真文章
  const rootTextLen = (root.textContent || '').trim().length;
  if (DELETED_RE.test(bodyText) && (rootVia !== 'rule' || rootTextLen < 20)) return { verdict: 'deleted' };
  if (rootVia !== 'rule' && (rootTextLen < 20 || (PAYWALL_RE.test(bodyText) && rootTextLen < 200))) {
    if (PAYWALL_RE.test(bodyText)) return { verdict: 'paywall' };
    return { verdict: 'select-miss', readErr: readErr, pageTitle: document.title };
  }

  // ④ 排除节点（评论区/侧栏/二维码——不存的东西在快照里也不留）
  if (rule && Array.isArray(rule.exclude)) {
    rule.exclude.forEach(sel => {
      try { Array.prototype.forEach.call(document.querySelectorAll(sel), n => n.remove()); } catch (e) {}
    });
  }

  // ⑤ 图片占位符：DOM 层把 src 换成 __KS_IMG_n__ 并清掉懒加载属性（坑点见文件头注释①）
  const urls = []; const phMap = new Map();
  const phFor = u => {
    u = String(u || '');
    try { u = new URL(u, location.href).href; } catch (e) { return null; }   // 相对路径图（个人博客常见）解析为绝对 URL
    if (!/^https?:\\/\\//i.test(u)) return null;
    if (!phMap.has(u)) { phMap.set(u, '__KS_IMG_' + urls.length + '__'); urls.push(u); }
    return phMap.get(u);
  };
  const imgSwap = scope => {
    Array.prototype.forEach.call(scope.querySelectorAll('img'), im => {
      const real = im.getAttribute('data-src') || im.getAttribute('src') || '';
      const ph = phFor(real);
      if (ph) {
        im.setAttribute('src', ph);
        im.removeAttribute('data-src'); im.removeAttribute('srcset'); im.removeAttribute('data-lazy-src');
      } else { im.remove(); }
    });
    // 公众号装饰背景图：真实地址在 data-lazy-bgimg（CSS background-image 形态，不是 img 标签——
    // M-A1 实测的「二次懒加载残图」就是它）。DOM 层换成占位符，Node 侧替换逻辑与 img 共用
    Array.prototype.forEach.call(scope.querySelectorAll('[data-lazy-bgimg]'), el => {
      const real = el.getAttribute('data-lazy-bgimg') || '';
      const ph = phFor(real);
      if (ph) {
        el.style.backgroundImage = 'url("' + ph + '")';
        el.removeAttribute('data-lazy-bgimg');
      }
    });
    // 公众号「二次懒加载」section（data-sec-load-status=2 + data-src）：JS 稍后才把它铺成
    // 背景图——提取时就得换成占位符，否则存档里只剩一段远程 URL（实测踩坑）
    Array.prototype.forEach.call(scope.querySelectorAll('[data-sec-load-status][data-src]:not(img)'), el => {
      const ph = phFor(el.getAttribute('data-src') || '');
      if (ph) {
        el.style.backgroundImage = 'url("' + ph + '")';
        el.removeAttribute('data-src');
        el.removeAttribute('data-sec-load-status');
      }
    });
    // 存档安全清洗（P1-4）：快照以 file:// 打开即本地上下文，绝不能执行原站脚本——规则路径
    // contentHtml 原样保留 script/on* 事件属性，不清洗等于把原站 JS 带进用户本机。删远程脚本
    // 节点 + 全部 on* 事件属性 + javascript: 伪协议，纯静态展示（Readability 路径重复过这里，幂等无害）
    Array.prototype.forEach.call(scope.querySelectorAll('script,iframe,object,embed'), n => n.remove());
    Array.prototype.forEach.call(scope.querySelectorAll('*'), el => {
      const attrs = Array.prototype.slice.call(el.attributes || []);
      attrs.forEach(a => {
        if (/^on/i.test(a.name)) { el.removeAttribute(a.name); return; }
        // 危险 scheme 判断：浏览器解析 URL 会剥 scheme 内 TAB/LF/CR（jav&#x09;ascript: 等效
        // javascript:），判断前先把值里的空白+C0 控制符全部归一剥掉，杜绝变体绕过（QA 复核缺口）。
        // 只在「判断」时归一，正常含空格 URL 不受影响；判定危险才整属性删除。
        // 顺带封 vbscript: 与 data:text/html（后者不碰 data:image 等安全用途）
        if (a.name === 'href' || a.name === 'src' || a.name === 'xlink:href') {
          const v = String(a.value).replace(/[\\s\\x00-\\x1f]+/g, '');
          if (/^(javascript|vbscript):/i.test(v) || /^data:text\\/html/i.test(v)) el.removeAttribute(a.name);
        }
      });
    });
  };
  imgSwap(root);
  const contentHtml = root.outerHTML;

  // ⑥ Markdown 源：Readability 正文优先（比页面容器干净），DOM 层换占位符后交给页内转换器
  const mdDiv = document.createElement('div');
  mdDiv.innerHTML = (read && read.content) ? read.content : contentHtml;
  imgSwap(mdDiv);
  // typeof 双保险（P1-2）：HTML_TO_MD_JS 注入失败/依赖缺失时退空 md，绝不能让提取整体 TypeError
  const md = (typeof window.__ksHtmlToMd === 'function') ? window.__ksHtmlToMd(mdDiv) : '';

  // ⑦ 元信息：站点规则选择器 > Readability > og meta > document.title
  const clean = s => String(s || '').replace(/\\s+/g, ' ').trim();
  const selTitle = rule && rule.sel && rule.sel.title ? q(rule.sel.title) : null;
  const selAuthor = rule && rule.sel && rule.sel.author ? q(rule.sel.author) : null;
  const selTime = rule && rule.sel && rule.sel.time ? q(rule.sel.time) : null;
  const title = clean(selTitle && selTitle.textContent)
    || (read && read.title ? clean(read.title) : '')
    || clean(metaTag('og:title')) || clean(document.title);
  const author = (clean(selAuthor && selAuthor.textContent) || clean(read && read.byline)
    || clean(metaTag('og:article:author')) || clean(metaTag('author'))).replace(/^by\\s*/i, '');
  const publishTime = clean(selTime && selTime.textContent) || clean(metaTag('article:published_time'));
  const text = (read && read.textContent) ? read.textContent : (root.innerText || '');

    return {
      verdict: 'ok', rootVia: rootVia,
      title: title, author: author, publishTime: publishTime,
      text: text, contentHtml: contentHtml, md: md,
      images: urls, siteName: location.hostname,
    };
})()`;
}

// 页内 HTML→Markdown 轻量转换器（与提取脚本同上下文注入）：
// 覆盖正文排版（标题/段落/列表/引用/代码/图片/链接/粗斜体）就够——md 是阅读副本，
// 保真存档是 index.html。图片 URL 原样进 md 文本（非属性），Node 侧可直接字符串替换。
// 注意必须包 IIFE 且无返回值：executeJavaScript 要求脚本结果可结构化克隆，裸赋值
// 表达式的值是函数，注入直接报「An object could not be cloned」（实测踩坑）
const HTML_TO_MD_JS = `
(function () {
window.__ksHtmlToMd = function htmlToMd(rootEl) {
  const inline = node => {
    let out = '';
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) { out += ch.nodeValue.replace(/\\s+/g, ' '); return; }
      if (ch.nodeType !== 1) return;
      const tag = ch.tagName.toLowerCase();
      if (tag === 'br') { out += '\\n'; return; }
      const inner = inline(ch);
      if (tag === 'strong' || tag === 'b') out += inner.trim() ? '**' + inner.trim() + '**' : '';
      else if (tag === 'em' || tag === 'i') out += inner.trim() ? '*' + inner.trim() + '*' : '';
      else if (tag === 'del' || tag === 's') out += inner.trim() ? '~~' + inner.trim() + '~~' : '';
      else if (tag === 'code') out += '\\u0060' + ch.textContent + '\\u0060';
      else if (tag === 'a') {
        const href = ch.getAttribute('href') || '';
        out += inner.trim() && href ? '[' + inner.trim() + '](' + href + ')' : inner;
      }
      else if (tag === 'img') { const src = ch.getAttribute('src') || ''; out += src ? '![](' + src + ')' : ''; }
      else out += inner;
    });
    return out;
  };
  const escT = s => s.replace(/([\\\\\`*_\\[\\]])/g, '\\\\$1');
  const lines = [];
  const block = node => {
    node.childNodes.forEach(ch => {
      if (ch.nodeType === 3) { const t = ch.nodeValue.trim(); if (t) lines.push(escT(t)); return; }
      if (ch.nodeType !== 1) return;
      const tag = ch.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) { const lv = '#'.repeat(+tag[1]); const t = inline(ch).trim(); if (t) lines.push('\\n' + lv + ' ' + t); }
      else if (tag === 'p') { const t = inline(ch).trim(); if (t) lines.push('\\n' + t); }
      else if (tag === 'blockquote') { const t = inline(ch).trim(); if (t) lines.push('\\n' + t.split('\\n').map(l => '> ' + l).join('\\n')); }
      else if (tag === 'pre') { const t = ch.textContent.replace(/\\n+$/, ''); if (t.trim()) lines.push('\\n\\u0060\\u0060\\u0060\\n' + t + '\\n\\u0060\\u0060\\u0060'); }
      else if (tag === 'ul' || tag === 'ol') {
        let i = 1;
        ch.childNodes.forEach(li => {
          if (li.nodeType !== 1 || li.tagName.toLowerCase() !== 'li') return;
          const mark = tag === 'ol' ? (i++) + '. ' : '- ';
          const t = inline(li).trim().replace(/\\n+/g, ' ');
          if (t) lines.push(mark + t);
        });
      }
      else if (tag === 'img') { const src = ch.getAttribute('src') || ''; if (src) lines.push('\\n![](' + src + ')'); }
      else if (tag === 'hr') { lines.push('\\n---'); }
      else if (tag === 'table') { const t = ch.textContent.replace(/\\s+/g, ' ').trim(); if (t) lines.push('\\n' + t); }
      else if (['figure','section','div','article','main','header','footer','aside','font','span'].includes(tag)) block(ch);
      else { const t = inline(ch).trim(); if (t) lines.push('\\n' + t); }
    });
  };
  block(rootEl);
  return lines.join('\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
};
})();`;

// 删帖复查页内脚本（轻量：只取删帖标记 + 正文文本算 hash，不做图片/落盘）
function buildRecheckJs(rule) {
  const sel = rule && rule.sel ? JSON.stringify(rule.sel) : 'null';
  return `
(() => {
  const sel = ${sel};
  const q = s => { try { return document.querySelector(s); } catch (e) { return null; } };
  const bodyText = document.body ? document.body.innerText : '';
  const DELETED_RE = ${DELETED_RE.toString()};
  if (DELETED_RE.test(bodyText)) return { verdict: 'deleted' };
  let text = '';
  let read = null;
  try { if (typeof Readability === 'function') read = new Readability(document.cloneNode(true), { charThreshold: 100 }).parse(); } catch (e) {}
  if (read && read.textContent) text = read.textContent;
  else if (sel && sel.content) { const c = q(sel.content); text = c ? c.innerText : bodyText; }
  else text = bodyText;
  return { verdict: 'ok', title: (read && read.title) || document.title, text: text };
})()`;
}

// ---- 隐藏加载窗口 ----
function createHiddenWindow() {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 2400,
    webPreferences: { javascript: true, images: true },
  });
  // 页面弹窗/新窗口一律拒绝（防部分站点抓取过程中弹登录窗）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

// executeJavaScript 超时包装（P1-1）：页面脚本卡死（while(true)/恶意页）时该 Promise 永不
// resolve → 流水线假死、隐藏窗口泄漏、队列槽位被永久占用。超时即销毁窗口再 reject——窗口是
// 抓取专属一次性资源，销毁后流水线下一步要么取消标记生效要么拋错退出，队列槽位必然释放
async function execWithTimeout(win, js, ms = EXEC_TIMEOUT_MS) {
  let timer = null;
  try {
    return await Promise.race([
      win.webContents.executeJavaScript(js),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { if (!win.isDestroyed()) win.destroy(); } catch (e) {}
          reject(new ArticleError('network', '页内脚本执行超时 ' + Math.round(ms / 1000) + 's，页面可能卡死'));
        }, ms);
      }),
    ]);
  } catch (e) {
    // 超时销毁窗口后，挂起中的 executeJavaScript 会补抛「Object has been destroyed」；
    // 窗口已销毁后再调用也拋同样错——统一归为网络/页面侧错误，不再往上泄漏内部异常
    if (/Object has been destroyed/i.test(String(e && e.message))) {
      throw new ArticleError('network', '抓取窗口已销毁（页面卡死或任务已取消）');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// loadURL 对部分跳转/子资源取消会抛 ERR_ABORTED，页面其实已在渲染——不当失败（原型实测）
async function loadPage(win, url, cancel) {
  checkCancel(cancel);
  try {
    await Promise.race([
      win.loadURL(url, { userAgent: UA }),
      sleep(LOAD_TIMEOUT_MS).then(() => { throw new Error('加载超时 ' + (LOAD_TIMEOUT_MS / 1000) + 's'); }),
    ]);
  } catch (e) {
    if (/ERR_ABORTED/i.test(String(e && e.message))) { /* 预期内：页面已在渲染 */ }
    else throw new ArticleError('network', String((e && e.message) || e).slice(0, 100));
  }
  await sleep(600);   // did-finish-load 后给首屏渲染一小段稳定期
  checkCancel(cancel);
}

// 滚动触发懒加载：滚到底再回顶 + 站点等待 + 第二轮快速补滚（公众号二次懒加载尾部图）
async function scrollAndSettle(win, rule, cancel) {
  checkCancel(cancel);
  await execWithTimeout(win, `
    (async () => {
      const h = document.body ? document.body.scrollHeight : 0;
      for (let y = 0; y < h; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 100)); }
      window.scrollTo(0, 0);
    })()`);
  await sleep((rule && rule.waitMs) || 1800);
  await execWithTimeout(win, `
    (async () => {
      const h = document.body ? document.body.scrollHeight : 0;
      for (let y = h; y > 0; y -= 1600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); }
      window.scrollTo(0, 0);
    })()`);
  await sleep(900);
  checkCancel(cancel);
}

// ---- 图片本地化 ----
function imgExt(u, contentType) {
  const m = String(u).match(/wx_fmt=(\w+)/) || String(u).match(/\.(jpe?g|png|gif|webp|bmp|avif)(?:[?#]|$)/i);
  if (m) { const e = m[1].toLowerCase(); return e === 'jpeg' ? 'jpg' : e; }
  const ct = String(contentType || '').toLowerCase();
  const mm = ct.match(/image\/(jpe?g|png|gif|webp|bmp|avif)/);
  if (mm) return mm[1] === 'jpeg' ? 'jpg' : mm[1];
  return 'jpg';
}

// 下载单图 → assets/img-001.jpg；失败返回 null（调用方保留原 URL，诚实降级）
async function downloadImage(u, dir, idx) {
  const { net } = require('electron');
  const headers = {};
  const ref = sites.refererFor(u);
  if (ref) headers.Referer = ref;   // 防盗链：按域名规则带页面 Referer（规则表见 lib/article-sites.js）
  try {
    const resp = await net.fetch(u, { headers, userAgent: UA, signal: AbortSignal.timeout(IMG_TIMEOUT_MS) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) throw new Error('空响应');
    const file = 'img-' + String(idx + 1).padStart(3, '0') + '.' + imgExt(u, resp.headers.get('content-type'));
    fs.writeFileSync(path.join(dir, 'assets', file), buf);
    return 'assets/' + file;
  } catch (e) {
    return null;
  }
}

// ---- 目录规划：{outDir}/article/{作者或站点}/{标题slug}/ ----
// P0-1：作者/标题来自远程页面内容，可能被构造成 ..（纯点段）——不拒绝就会 path.join 写穿
// 到下载目录外。这里除剥非法字符外，对清洗后仍是纯点的段一律退 fallback
function sanitizeSeg(s, fallback) {
  const seg = String(s || '').replace(/[\\/:*?"<>|#&]+/g, '').trim().slice(0, 40);
  if (/^\.+$/.test(seg)) return fallback;
  return seg || fallback;
}
function slugify(t) {
  const s = String(t || '').replace(/[\\/:*?"<>|\s#&]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  if (/^\.+$/.test(s)) return 'article';
  return s || 'article';
}
// 同一篇文章重跑：meta.json 里 url 一致 → 原地覆盖更新；否则换 -2/-3 后缀防覆盖别的文章。
// P0-1 双保险：base 由远程内容拼接而成，断言最终落点必须在 outDir 内，越界直接拒抓。
// P2-1：占坑改用 mkdirSync(recursive:false) 原子抢占——同作者同标题的两篇文章并发抓取时，
// 后到者 EEXIST 且 meta.url 与当前不同 → 换下一候选，不再互相覆盖
function resolveDir(outDir, authorSeg, slug, url) {
  const base = path.join(outDir, 'article', authorSeg, slug);
  if (!path.resolve(base).startsWith(path.resolve(outDir) + path.sep)) {
    throw new ArticleError('select', '存档路径解析越界，已拒绝抓取');
  }
  fs.mkdirSync(path.dirname(base), { recursive: true });   // 先铺父级，占坑创建才有父目录可用
  const candidates = [base, ...[2, 3, 4, 5].map(n => base + '-' + n)];
  for (const d of candidates) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(d, 'meta.json'), 'utf-8'));
      if (m.url === url) return d;
    } catch (e) { /* 无 meta 或读不了 → 视作未占用 */ }
    try {
      fs.mkdirSync(d, { recursive: false });
      return d;
    } catch (e) {
      if (e && e.code === 'EEXIST') continue;   // 已被占（别的文章或并发抓取中）→ 换下一候选
      throw new ArticleError('select', '创建存档目录失败: ' + String((e && e.code) || e).slice(0, 60));
    }
  }
  // 兜底：时间戳目录（同毫秒并发碰撞时换名重试，最多 5 次）
  for (let i = 0; i < 5; i++) {
    const d = base + '-' + Date.now().toString(36);
    try { fs.mkdirSync(d, { recursive: false }); return d; }
    catch (e) { if (!e || e.code !== 'EEXIST') throw new ArticleError('select', '创建存档目录失败: ' + String((e && e.code) || e).slice(0, 60)); }
  }
  throw new ArticleError('select', '存档目录占用冲突');
}

function normalizeText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 50000);
}
function textHash(t) {
  return crypto.createHash('sha256').update(normalizeText(t), 'utf-8').digest('hex');
}

// 内嵌阅读样式的 index.html（正文 HTML 来自存档页面，title/meta 转义防注入）
function pageHtml(title, author, publishTime, url, contentHtml) {
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{max-width:680px;margin:40px auto;padding:0 20px;font:16px/1.9 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#222;background:#fff}
h1{font-size:24px;line-height:1.4} .meta{color:#888;font-size:14px;margin:12px 0 28px;border-bottom:1px solid #eee;padding-bottom:16px}
img{max-width:100%;height:auto;border-radius:6px} blockquote{border-left:3px solid #ddd;margin:0;padding-left:14px;color:#666}
pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto} code{background:#f6f8fa;padding:1px 5px;border-radius:4px}
pre code{background:none;padding:0} table{border-collapse:collapse} td,th{border:1px solid #ddd;padding:4px 8px}
.src-note{margin-top:48px;color:#aaa;font-size:13px}</style>
</head><body>
<h1>${esc(title)}</h1>
<div class="meta">${esc(author)}${author && publishTime ? ' · ' : ''}${esc(publishTime)}</div>
${contentHtml}
<div class="src-note">原文：<a href="${esc(url)}">${esc(url)}</a><br>由 Keepsake 文章引擎存档 · ${new Date().toLocaleString('zh-CN')}</div>
</body></html>`;
}

// =====================================================================
// 主流水线：抓取单篇文章 → 4 件套
// =====================================================================
async function fetchArticle({ url, outDir, onProgress = () => {}, cancel = null }) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new ArticleError('network', '不是有效的 http(s) 链接');
  const prog = (pct, note) => { try { onProgress(pct, note); } catch (e) {} };
  const rule = sites.matchSite(url);

  const win = createHiddenWindow();
  // 把窗口挂到 cancel 控制对象上：队列 cancel/看门狗 kill 时能 destroy 卡死的窗口（P1-1）
  if (cancel) cancel.win = win;
  try {
    prog(3, '加载页面');
    await loadPage(win, url, cancel);

    prog(15, '触发懒加载');
    await scrollAndSettle(win, rule, cancel);

    // Readability 注入（依赖缺失时静默跳过，提取脚本内 typeof 判断兜底）
    const rSrc = readabilitySrc();
    if (rSrc) {
      try { await execWithTimeout(win, rSrc); } catch (e) { /* 注入失败退兜底提取 */ }
    }
    // HTML→MD 转换器必须无条件注入（P1-2）：提取脚本第⑥步无条件调用 __ksHtmlToMd，
    // 若只在 if(rSrc) 里注入，Readability 依赖缺失时整个提取 100% TypeError 失败
    // （双保险：提取脚本内也有 typeof 判断）
    try { await execWithTimeout(win, HTML_TO_MD_JS); } catch (e) { /* 注入失败退兜底 */ }

    prog(30, '提取正文');
    const data = await execWithTimeout(win, buildExtractJs(rule, url));
    if (!data || typeof data !== 'object') throw new ArticleError('select', '页内脚本无返回');
    if (data.verdict === 'deleted') throw new ArticleError('deleted');
    if (data.verdict === 'paywall') throw new ArticleError('paywall');
    if (data.verdict === 'select-miss') throw new ArticleError('select', data.readErr || '');
    if (!data.contentHtml || !data.contentHtml.trim()) throw new ArticleError('select', '正文为空');

    // 目录与落盘准备
    const host = (() => { try { return new URL(url).hostname; } catch (e) { return 'site'; } })();
    const authorSeg = sanitizeSeg(data.author, rule ? rule.label : host);
    const dir = resolveDir(outDir, authorSeg, slugify(data.title), url);
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });

    // 图片本地化（顺序下载：对图床客气一点，也避免并发触发防盗链风控）
    const imgs = (data.images || []).slice(0, MAX_IMAGES);
    const swap = new Map();   // 占位符 → 最终引用（本地相对路径或回退原 URL）
    let okN = 0, failN = 0;
    for (let i = 0; i < imgs.length; i++) {
      checkCancel(cancel);
      const ref = await downloadImage(imgs[i], dir, i);
      if (ref) { swap.set('__KS_IMG_' + i + '__', ref); okN++; }
      else { swap.set('__KS_IMG_' + i + '__', imgs[i]); failN++; }   // 诚实降级：保留原 URL，联网仍可看
      prog(42 + Math.round((i + 1) / Math.max(1, imgs.length) * 48), '图片 ' + (i + 1) + '/' + imgs.length);
    }
    // 占位符 → 引用替换（占位符纯 ASCII 无 & 不受转义影响，split/join 全量替换）
    let html = data.contentHtml, md = data.md || '';
    for (const [ph, ref] of swap) { html = html.split(ph).join(ref); md = md.split(ph).join(ref); }
    // 兜底清扫（P1-3）：页内对全部图都打了占位符，但 Node 侧只下载前 MAX_IMAGES 张——
    // 超出部分的 __KS_IMG_n__ 字面量绝不能写进存档（有对应下载记录的用其引用，没有的置空）
    html = html.replace(/__KS_IMG_\d+__/g, m => swap.get(m) || '');
    md = md.replace(/__KS_IMG_\d+__/g, m => swap.get(m) || '');

    prog(94, '写入文件');
    const hash = textHash(data.text);
    const meta = {
      kind: 'keepsake-article',          // 媒体库识别标记（library.js readArticleEntry）
      engine: 'article',
      url: url,
      finalUrl: url,
      title: data.title || '未命名文章',
      author: data.author || '',
      publishTime: data.publishTime || '',
      site: rule ? rule.name : host,
      archivedAt: new Date().toISOString(),
      contentHash: hash,                 // 删帖复查比对基准（正文归一化文本的 sha256）
      textLength: normalizeText(data.text).length,
      imagesTotal: imgs.length,
      imagesLocal: okN,
      imagesFailed: failN,
      status: 'ok',                      // 'ok' | 'deleted'（重新检查后更新）
      lastCheckedAt: null,
      editedAt: null,
      deletedAt: null,
    };
    fs.writeFileSync(path.join(dir, 'index.html'), pageHtml(meta.title, meta.author, meta.publishTime, url, html), 'utf-8');
    fs.writeFileSync(path.join(dir, 'article.md'),
      `# ${meta.title}\n\n> ${meta.author || ''}${meta.author && meta.publishTime ? ' · ' : ''}${meta.publishTime || ''}\n> 原文：${url}\n\n${md}\n`, 'utf-8');
    atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));

    prog(100, '完成');
    return { dir, meta, fileCount: 3 + okN };
  } finally {
    try { win.destroy(); } catch (e) {}
  }
}

// =====================================================================
// 删帖检测最小版：重抓原文页，比正文 hash
// =====================================================================
async function recheck({ dir, cancel = null, onProgress = () => {} }) {
  const metaPath = path.join(dir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));   // 缺文件/坏 JSON 直接抛，调用方报错
  if (!meta.url) throw new ArticleError('network', 'meta.json 缺少原文链接，无法复查');
  const prog = pct => { try { onProgress(pct); } catch (e) {} };
  const rule = sites.matchSite(meta.url);

  const win = createHiddenWindow();
  // 同 fetchArticle：窗口挂到 cancel 控制对象上，取消时队列能 destroy 卡死窗口（P1-1）
  if (cancel) cancel.win = win;
  try {
    prog(10);
    await loadPage(win, meta.url, cancel);
    prog(40);
    await scrollAndSettle(win, rule, cancel);
    prog(70);
    const rSrc = readabilitySrc();
    if (rSrc) { try { await execWithTimeout(win, rSrc); } catch (e) {} }
    const data = await execWithTimeout(win, buildRecheckJs(rule));

    const now = Date.now();
    meta.lastCheckedAt = now;
    if (data.verdict === 'deleted') {
      meta.status = 'deleted';
      meta.deletedAt = now;
      atomicWrite(metaPath, JSON.stringify(meta, null, 2));
      return { status: 'deleted', edited: false, title: meta.title };
    }
    // hash 变化 = 原文被编辑（本地存档不动，只做标记——是否重新存档由用户决定）
    const hash = textHash(data.text);
    const edited = !!meta.contentHash && hash !== meta.contentHash;
    meta.status = 'ok';
    if (edited) { meta.editedAt = now; meta.contentHash = hash; }   // 以最新 hash 为基准，避免重复提醒
    else { meta.editedAt = null; }
    atomicWrite(metaPath, JSON.stringify(meta, null, 2));
    prog(100);
    return { status: 'ok', edited, title: meta.title };
  } finally {
    try { win.destroy(); } catch (e) {}
  }
}

module.exports = { fetchArticle, recheck, ArticleError,
  // 页内脚本构建器一并导出：QA 可离线单测提取逻辑（不抓网、只喂 DOM）
  _pageScripts: { buildExtractJs, buildRecheckJs, HTML_TO_MD_JS, readabilitySrc },
  // 目录规划函数一并导出：QA 可离线单测路径穿越防护（P0-1）
  _pathHelpers: { sanitizeSeg, slugify, resolveDir } };
