// 站点规则表（文章引擎，lib/article.js 消费）：选择器 / 排除节点 / 懒加载等待参数 + 图片防盗链 Referer 规则
// 设计：规则匹配不到 → 通用 Readability 兜底（lib/article.js 内），成不成看页面，诚实报告。
// 规则按「正文容器 + 标题/作者/时间」三元组写，选择器允许多个候选（逗号分隔，querySelector 语义）。
module.exports = {
  // 站点规则（match 命中即用；waitMs = 滚动后额外等待毫秒数，给懒加载图填充时间）
  SITES: [
    {
      name: 'wechat',
      label: '微信公众号',
      match: /mp\.weixin\.qq\.com\/s/i,
      sel: { content: '#js_content', title: '#activity-name', author: '#js_name', time: '#publish_time' },
      // 公众号有「二次懒加载」尾部图（data-sec-load-status=2），提取时机必须晚于 data-src 全部填充——M-A1 实测
      waitMs: 2600,
      exclude: ['#js_pc_qr_code', '.qr_code_pc_outer', '#js_tags', '#content_bottom_area'],
    },
    {
      name: 'zhihu',
      label: '知乎',
      match: /(?:^|\.)zhihu\.com\/(?:question\/\d+|p\/\d+)/i,
      sel: {
        content: '.Post-RichTextContainer, .RichContent-inner, .QuestionAnswer-content',
        title: '.Post-Title, h1.QuestionHeader-title',
        author: '.AuthorInfo-name',
        time: '.ContentItem-time, .Post-Time',
      },
      exclude: ['.ContentItem-actions', '.Sticky', '.Question-sideColumn'],
      waitMs: 1800,
    },
    {
      name: 'bilibili',
      label: 'B站专栏',
      match: /bilibili\.com\/read\/cv/i,
      sel: {
        content: '.article-content, .opus-content, #article-content',
        title: '.title-container h1, h1.title, .article-title',
        author: '.up-name, .article-up',
        time: '.publish-text, .article-time',
      },
      waitMs: 1800,
    },
    {
      name: 'csdn',
      label: 'CSDN',
      match: /blog\.csdn\.net\//i,
      sel: {
        content: '#content_views',
        title: 'h1.title-article',
        author: '.follow-nick, #uid',
        time: '.time, .bar-content .time',
      },
      // hide-article-box 是 CSDN 的强制登录折叠层——直接丢弃：不绕过访问控制，能看到多少存多少（诚实降级）
      exclude: ['.hide-article-box', '#toolBarBox', '.recommend-box'],
      waitMs: 1500,
    },
    {
      name: 'cnblogs',
      label: '博客园',
      match: /cnblogs\.com\/[^/]+\/p\//i,
      sel: {
        content: '#cnblogs_post_body',
        title: '#cb_post_title_url',
        author: '#blogTitle a',
        time: '#post-date',
      },
    },
    {
      name: 'juejin',
      label: '掘金',
      match: /juejin\.cn\/post\//i,
      sel: {
        content: '.article-content',
        title: 'h1.article-title',
        author: '.username, .author-name',
        time: '.meta-item .time, time',
      },
      exclude: ['.article-suspended-panel', '.sidebar'],
      waitMs: 1500,
    },
    {
      name: 'sspai',
      label: '少数派',
      match: /sspai\.com\/post\//i,
      sel: {
        content: '.article-body, .content.wangEditor-txt',
        title: 'h1.title',
        author: '.avatarName, .name',
      },
      waitMs: 1500,
    },
    {
      name: 'jianshu',
      label: '简书',
      match: /jianshu\.com\/p\//i,
      // 简书正文类名是构建哈希（如 _1RuRku），不稳定——只给 article 标签，认不出就退 Readability
      sel: { content: 'article', title: 'h1', author: '' },
      waitMs: 1500,
    },
  ],

  // 图片防盗链 Referer 规则（按域名匹配；未命中 = 不带 Referer——大多数图床无防盗链）
  REFERERS: [
    [/mmbiz\.qpic\.cn/i, 'https://mp.weixin.qq.com/'],
    [/(?:^|\.)zhimg\.com/i, 'https://www.zhihu.com/'],
    [/hdslb\.com/i, 'https://www.bilibili.com/'],
  ],

  refererFor(u) {
    for (const [re, ref] of this.REFERERS) if (re.test(String(u || ''))) return ref;
    return undefined;
  },

  matchSite(url) {
    for (const s of this.SITES) if (s.match.test(String(url || ''))) return s;
    return null;
  },
};
