// #46⑤ 引擎子进程输出容错解码：UTF-8 优先、非法序列回退 GBK（0 npm 依赖）
// 背景：两引擎本体已强制 UTF-8（yt-dlp --encoding / gallery-dl --config），但 Windows 中文环境下
// 子进程仍可能吐 GBK/CP936 字节——典型是 ffmpeg 合并报错、OS 层文件错误（文件名含中文）、
// 引擎未走强制开关的旁路输出。直接按 UTF-8 解码会变 U+FFFD 乱码，既毁用户可见错误文案，
// 也可能破坏 412/429 等错误分类匹配。零依赖方案：Node/Electron 自带全量 ICU，TextDecoder('gbk') 可用。
//
// 用法与 TextDecoder 子集对齐（drop-in）：
//   const dec = new TolerantDecoder();
//   child.stdout.on('data', d => out += dec.decode(d, { stream: true }));   // 流式
//   const text = dec.decode(buf);                                           // 一次性（默认 flush 尾字节）
//
// 判定策略：整块先按 UTF-8 严格模式（fatal）解；遇到非法序列整块改按 GBK 解，并锁定 GBK 模式
// （同一流不会中途换编码；纯 ASCII 两种编码结果一致，不触发切换）。流式时未完结的多字节尾字节
// 留到下一块，不会误判为非法。

const DEBUG = false;   // 排障开关：true 时打印编码切换事件

class TolerantDecoder {
  constructor() {
    this._utf8 = new TextDecoder('utf-8', { fatal: true });   // 严格模式：非法序列抛错 → 触发 GBK 回退
    try {
      this._gbk = new TextDecoder('gbk', { fatal: false });   // 无全量 ICU 的极端环境降级为 utf-8 宽松
    } catch (e) { this._gbk = new TextDecoder('utf-8'); }
    this._gbkMode = false;
    this._pending = null;   // GBK 模式后由 GBK 解码器自持流状态；UTF-8 模式下暂存未完结尾字节
  }

  // 找 data 末尾未完结的 UTF-8 多字节序列起点（返回安全可解码长度）。
  // 规则：从末尾回看最多 3 字节，若全是 10xxxxxx 续字节则截到首个非续字节处
  _safeUtf8Len(data) {
    let i = data.length - 1;
    let back = 0;
    while (i >= 0 && back < 4 && (data[i] & 0xc0) === 0x80) { i--; back++; }   // 跳过续字节
    if (i < 0) return 0;
    const lead = data[i];
    let need = 0;
    if ((lead & 0x80) === 0) need = 1;
    else if ((lead & 0xe0) === 0xc0) need = 2;
    else if ((lead & 0xf0) === 0xe0) need = 3;
    else if ((lead & 0xf8) === 0xf0) need = 4;
    else return i;   // 非法首字节：交给 strict 解码抛错（不在这里吞）
    const have = data.length - i;
    return have >= need ? data.length : i;   // 序列完整 → 全量可解；不完整 → 截到序列起点留待下块
  }

  decode(chunk, { stream = false } = {}) {
    if (chunk === null || chunk === undefined) return '';
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this._gbkMode) return this._gbk.decode(buf, { stream });
    const data = this._pending && this._pending.length ? Buffer.concat([this._pending, buf]) : buf;
    if (!data.length) return '';
    if (!stream) {
      // 一次性模式（flush 语义）：整块严格 UTF-8，失败整块 GBK
      try {
        this._pending = null;
        return this._utf8.decode(data);
      } catch (e) {
        this._latchGbk();
        return this._gbk.decode(data);
      }
    }
    // 流式：先切出完整序列前缀做严格解码，未完结尾字节留待下块
    const safeLen = this._safeUtf8Len(data);
    try {
      const text = this._utf8.decode(data.subarray(0, safeLen));   // fatal：任何非法字节都抛
      this._pending = safeLen < data.length ? data.subarray(safeLen) : null;
      return text;
    } catch (e) {
      // 块内存在非法 UTF-8 → 认定 GBK 流（含已暂存尾字节一并交给 GBK 解码器自持状态）
      this._latchGbk();
      this._pending = null;
      return this._gbk.decode(data, { stream: true });
    }
  }

  _latchGbk() {
    if (!this._gbkMode) {
      this._gbkMode = true;
      if (DEBUG) console.warn('[dec] 引擎输出非法 UTF-8，整流切换 GBK 解码');
    }
  }
}

module.exports = { TolerantDecoder };
