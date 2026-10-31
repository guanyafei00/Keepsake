// 剪贴板监听（机制借鉴 RipMe 的「复制链接自动收集」，clean-room 完全重写）：
// 轮询系统剪贴板文本，出现新 URL 时回调。安全边界：
//   ① 只读文本，绝不自动入队——URL 交给 UI 填进输入框，入队必须用户点按钮确认
//   ② 启动瞬间的剪贴板内容算基线，不当「新检测」弹出来骚扰
//   ③ getText 抛错（个别环境剪贴板被占用）静默跳过本轮，绝不影响主流程
//   ④ isActive 门控（#40）：仅当窗口获得焦点或最小化/隐藏到托盘时才检测，
//      非活跃期间只静默更新基线（不把用户在别处复制的旧内容当「新检测」补弹）
class ClipWatcher {
  constructor(getText, onUrl, isActive) {
    this.getText = getText;   // () => string：注入剪贴板读取（Electron clipboard.readText 的薄封装）
    this.onUrl = onUrl;       // (url) => void：检测到新 URL
    this.isActive = isActive || null;   // () => boolean：可选活跃门控（false = 本轮只更新基线不检测）
    this._timer = null;
    this._last = null;
  }

  // 从任意文本提取第一个 http(s) URL。引号/尖括号/括号不算 URL 的一部分
  // （网页复制的 <a href="...">、markdown 链接都能干净剥离）
  static extractUrl(text) {
    const m = String(text || '').match(/https?:\/\/[^\s"'<>()\[\]]+/i);
    return m ? m[0] : null;
  }

  start(intervalMs = 1500) {
    if (this._timer) return;
    try { this._last = this.getText(); } catch (e) { this._last = null; }   // 基线
    this._timer = setInterval(() => {
      let t;
      try { t = this.getText(); } catch (e) { return; }
      if (t === this._last) return;   // 没变化：绝大多数轮询走这里，零开销
      this._last = t;
      // 活跃门控：窗口既无焦点又在前台可见（用户正在别的窗口工作）→ 本轮不检测，
      // 只把基线跟上，避免恢复活跃后把旧剪贴板当新链接补弹
      if (this.isActive && !this.isActive()) return;
      const url = ClipWatcher.extractUrl(t);
      if (url && this.onUrl) { try { this.onUrl(url); } catch (e) {} }
    }, intervalMs);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

// ---- #40 提示前置过滤（纯函数，单测覆盖）----
// 可提示的引擎白名单：能识别为「可下载内容」的链接才值得打扰用户；
// feed（该去订阅页）/ invalid（识别不了）/ unknown（没把握）一律不提示
const NOTIFY_ENGINES = new Set(['direct', 'yt-dlp', 'gallery-dl', 'article']);
function classifyNotifiable(engine) { return NOTIFY_ENGINES.has(engine); }

// 24h 去重窗口：同一链接一天内只提示一次（lastSeenAt 为 undefined/null = 从未提示过）
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
function withinDedupe(lastSeenAt, now, windowMs = DEDUPE_WINDOW_MS) {
  return typeof lastSeenAt === 'number' && Number.isFinite(lastSeenAt) && now - lastSeenAt < windowMs;
}

module.exports = { ClipWatcher, NOTIFY_ENGINES, classifyNotifiable, withinDedupe, DEDUPE_WINDOW_MS };
