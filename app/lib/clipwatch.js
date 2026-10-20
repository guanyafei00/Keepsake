// 剪贴板监听（机制借鉴 RipMe 的「复制链接自动收集」，clean-room 完全重写）：
// 轮询系统剪贴板文本，出现新 URL 时回调。安全边界：
//   ① 只读文本，绝不自动入队——URL 交给 UI 填进输入框，入队必须用户点按钮确认
//   ② 启动瞬间的剪贴板内容算基线，不当「新检测」弹出来骚扰
//   ③ getText 抛错（个别环境剪贴板被占用）静默跳过本轮，绝不影响主流程
class ClipWatcher {
  constructor(getText, onUrl) {
    this.getText = getText;   // () => string：注入剪贴板读取（Electron clipboard.readText 的薄封装）
    this.onUrl = onUrl;       // (url) => void：检测到新 URL
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
      const url = ClipWatcher.extractUrl(t);
      if (url && this.onUrl) { try { this.onUrl(url); } catch (e) {} }
    }, intervalMs);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}

module.exports = { ClipWatcher };
