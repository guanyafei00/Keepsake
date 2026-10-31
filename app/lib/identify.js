// 链接识别：URL 模式匹配分流 + yt-dlp 探测兜底
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const enc = require('./enc');

let BIN = path.join(__dirname, '..', 'resources', 'bin');
let COOKIE_PATH = path.join(__dirname, '..', 'resources', 'cookies.txt');
let PROXY = null;
function setBinDir(dir) { BIN = dir; }
function setCookiePath(p) { COOKIE_PATH = p; }   // 登录后识别探针也带上 cookie
function setProxy(p) { PROXY = p || null; }

// 已知图片/图文站 → gallery-dl（命中即信任，不做网络探测）
const GALLERY_PATTERNS = [
  /space\.bilibili\.com\/\d+/i,        // B站 UP 主页（动态图片流）
  /bilibili\.com\/opus\/\d+/i,         // B站图文动态
  /pixiv\.net/i,
  /twitter\.com\//i, /(?:^|\.)x\.com\//i,
  /instagram\.com/i,
  /weibo\.com/i, /weibo\.cn/i,
  /huashi6\.com/i, /artstation\.com/i,
  /danbooru\.donmai\.us/i, /gelbooru\.com/i, /yande\.re/i, /konachan\.com/i,
  /imgur\.com/i, /flickr\.com/i,
];

// 直连探测站：yt-dlp 已无法解析（抖音 a_bogus JSVMP 签名 / 快手 GraphQL+cookie），
// 走隐藏窗口让页面自己过反爬，webRequest 截获 CDN 直链（directprobe.js）。
// 小红书（#32）：笔记页（explore / discovery/item）与分享短链（xhslink.com）交由 direct 引擎
// 的隐藏窗口读取 __INITIAL_STATE__ 提取无水印图组/MP4；主站其他页面（用户主页等）不放行，
// 避免误把整站当单篇内容探测
const DIRECT_PATTERNS = [
  /(?:^|\.)douyin\.com\//i,          // 抖音网页/分享页（含 v.douyin.com 短链）
  /(?:^|\.)kuaishou\.com\//i,        // 快手
  /chenzhongtech\.com/i,             // 快手老域名
  /(?:^|\.)xiaohongshu\.com\/(?:explore|discovery\/item)\//i,   // 小红书笔记页（图文/视频笔记）
  /(?:^|\.|\/\/)xhslink\.com\//i,    // 小红书分享短链（裸域 xhslink.com/...，协议后无子域需容许 // 前缀）
];

const VIDEO_HINTS = [
  /bilibili\.com\/video\//i,
  /youtube\.com|youtu\.be/i,
  /v\.qq\.com/i, /ixigua\.com/i,
  /tiktok\.com/i,   // TikTok：yt-dlp 提取器可用，但需要代理网络（queue 侧会带 --proxy）
  /twitch\.tv/i, /vimeo\.com/i, /dailymotion\.com/i,
];

// 文章页 → article 引擎（进程内隐藏窗口抓取，lib/article.js；公众号/知乎/B站专栏/CSDN/博客园/掘金等）。
// 放在 VIDEO_HINTS 判定之后即可（两者无交集），但绝不含 B 站视频 /video/ ——重点自测项：
// bilibili.com/video/BVxxx 仍走 yt-dlp，只有 /read/cv 专栏进文章引擎
const ARTICLE_PATTERNS = [
  /mp\.weixin\.qq\.com\/s/i,                          // 微信公众号文章（/s 或 /s?__biz=）
  /bilibili\.com\/read\/cv/i,                         // B 站专栏
  /(?:^|\.)zhihu\.com\/(?:question\/\d+|p\/\d+)/i,    // 知乎问答/回答与专栏文章（zhuanlan.zhihu.com/p/…）
  /blog\.csdn\.net\//i,                               // CSDN 博客
  /cnblogs\.com\/[^/]+\/p\//i,                        // 博客园
  /juejin\.cn\/post\//i,                              // 掘金
  /sspai\.com\/post\//i,                              // 少数派
  /jianshu\.com\/p\//i,                               // 简书
];

// RSS/Atom feed 链接 → 订阅检查器（subs.js），不当单篇内容抓。模式刻意保守：只认「路径尾段」
// 与常见 feed 查询参数——feed 的常见形态就这几样（WordPress /feed/、/rss、atom.xml、index.xml、
// ?feed=rss2、FeedBurner、Blogger feeds/posts/default、reddit .rss），更冷门的样子宁可识别不了
// 也别误伤普通文章页；判定顺序在 ARTICLE_PATTERNS 之后（两者撞车时文章页优先）
const FEED_PATTERNS = [
  /\/feed\/?([?#]|$)/i,                      // /feed /feed/ /feed?xxx（WordPress 等）
  /\/rss\/?([?#]|$)/i,                       // /rss /rss/
  /\/atom\/?([?#]|$)/i,                      // /atom /atom/
  /\/(rss|atom|feeds?)\.(xml|php)([?#]|$)/i,  // feed.xml / rss.xml / atom.xml / feeds.xml / feeds.php
  /\/index\.xml([?#]|$)/i,                   // 部分静态博客约定
  /\.rss([?#]|$)/i,                          // reddit 等以 .rss 结尾的 feed
  /[?&]feed=(rss2?|atom|xml)?/i,             // ?feed=rss2 / ?feed=atom / ?feed=
  /[?&](rss|atom)=/i,                         // ?rss=1 / ?atom=1
  /feedburner\.com\/[a-z]/i,                 // FeedBurner 托管 feed
  /\/feeds\/posts\/default/i,                // Blogger
];
function isFeedUrl(u) { return FEED_PATTERNS.some(re => re.test(String(u || ''))); }

function classify(url) {
  const u = url.trim();
  if (!/^https?:\/\//i.test(u)) return { engine: 'invalid', reason: '不是 http(s) 链接' };
  // B站合集/系列页 → yt-dlp（BilibiliCollectionList/SeriesList 提取器，实测 119 项 flat 秒回）。
  // 必须在 space.bilibili.com 通用规则之前：gallery-dl 不认合集页，会整单失败
  if (/space\.bilibili\.com\/\d+\/lists\/\d+/i.test(u) ||
      /space\.bilibili\.com\/\d+\/channel\/(?:collectiondetail|seriesdetail)\?/i.test(u)) return { engine: 'yt-dlp' };
  // 微信视频号：无任何开放提取器（需微信客户端私有协议），粘贴链接诚实拒绝并引导到受控浏览器：
  // 主窗口点【📹 视频号】打开 persist:channels 持久会话窗口，官方页面正常浏览，
  // 播放后点窗口内【📥 归档】即可截获媒体流入队（embed_browser.js）
  if (/channels\.weixin\.qq\.com/i.test(u))
    return { engine: 'invalid', reason: '微信视频号请在界面中点击【视频号】通过受控浏览器浏览并一键归档' };
  if (DIRECT_PATTERNS.some(re => re.test(u))) return { engine: 'direct' };
  if (GALLERY_PATTERNS.some(re => re.test(u))) return { engine: 'gallery-dl' };
  if (VIDEO_HINTS.some(re => re.test(u))) return { engine: 'yt-dlp' };
  if (ARTICLE_PATTERNS.some(re => re.test(u))) return { engine: 'article' };
  // feed 链接不是单篇内容：贴进下载框会被 queue:add 拦下并提示去订阅页添加（UI 显示 📡 RSS 订阅）
  if (isFeedUrl(u)) return { engine: 'feed' };
  return { engine: 'unknown' }; // 交给 yt-dlp 探测（1000+ 站兜底）；纯博客文章页探测失败可手动确认
}

// yt-dlp 探测：拿到标题/UP主/时长；flat-playlist 秒级识别合集
function probe(url, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const cookie = COOKIE_PATH;
    const args = ['--dump-single-json', '--flat-playlist', '--no-warnings', '--skip-download', '--encoding', 'utf-8'];
    if (fs.existsSync(cookie)) args.push('--cookies', cookie);
    if (PROXY) args.push('--proxy', PROXY);
    args.push(url.trim());
    let out = '';
    const dec = new TextDecoder('utf-8');   // yt-dlp 已强制 --encoding utf-8（与 queue.js/subs.js 统一）
    const child = spawn(path.join(BIN, 'yt-dlp.exe'), args, { windowsHide: true });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { out += dec.decode(d, { stream: true }); });
    child.on('error', e => { clearTimeout(timer); resolve({ engine: 'yt-dlp', ok: false, reason: String(e) }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !out.trim()) return resolve({ engine: 'yt-dlp', ok: false, reason: '无法解析此链接' });
      try {
        const j = JSON.parse(out);
        resolve({
          engine: 'yt-dlp', ok: true,
          title: j.title || null,
          uploader: j.uploader || j.channel || null,
          duration: j.duration || null,
          isPlaylist: !!j._type || (j.entries && j.entries.length > 0),
          entryCount: j.entries ? j.entries.length : 1,
          extractor: j.extractor_key || null
        });
      } catch (e) {
        resolve({ engine: 'yt-dlp', ok: false, reason: '解析输出失败' });
      }
    });
  });
}

// 统一入口：识别 + （视频侧）元数据探测
async function identify(url) {
  const c = classify(url);
  if (c.engine === 'gallery-dl') return { engine: 'gallery-dl', ok: true, title: null, uploader: null };
  if (c.engine === 'invalid') return c;
  // 直连站不做 yt-dlp 元数据探测（注定失败白等 30 秒）；标题由 directprobe 加载页面时现取
  if (c.engine === 'direct') return { engine: 'direct', ok: true, title: null, uploader: null };
  // 文章站不做 yt-dlp 探测（文章页没有视频元数据，探测必失败白等 30 秒）；标题由文章流水线抓取后回填
  if (c.engine === 'article') return { engine: 'article', ok: true, title: null, uploader: null };
  // feed 不做 yt-dlp 探测（feed XML 没有视频元数据，探测必失败白等 30 秒）；标题由订阅首检从 feed 里取
  if (c.engine === 'feed') return { engine: 'feed', ok: true, title: null, uploader: null };
  const p = await probe(url);
  return p;
}

module.exports = { identify, classify, probe, setBinDir, setCookiePath, setProxy, isFeedUrl, FEED_PATTERNS };
