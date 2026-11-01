// #37 CBZ 漫画册打包：散图目录 → 平级 <目录名>.cbz（内嵌 ComicInfo.xml 元数据）
// 0 npm 依赖：打包用 Windows 10+ 内置 bsdtar（System32/tar.exe）。必须显式 --format zip——
// .cbz 扩展名走 -a 自动识别不在其列表里，会落回 ustar 格式（实测踩坑，见 queue.js 历史注释）。
// 调用方：queue._maybeCbz（任务完成自动联动）与 main.js library:makeCbz（媒体库一键成册）共用。
// ComicInfo 采用 bsdtar 多 -C 注入：zip 内先收 -C <目录> . 的全部图片，再收临时 staging 里的
// ComicInfo.xml——原图目录零污染（XML 不落盘到原目录），staging 在 finally 里清理不留残留。
// bsdtar 用法已实测：`tar --format zip -cf out.cbz -C <dir> . -C <staging> ComicInfo.xml` →
// zip 条目 ./01.jpg / ComicInfo.xml（第二个 -C 相对第一个 chdir，必须用绝对路径）。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CBZ_MIN_IMAGES = 3;   // 目录内图片少于该数不成册（避免把单图/缩略图目录卷进去）
const CBZ_IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

// 从任务产出文件清单里选「图片最多的目录」（_maybeCbz 原逻辑抽成纯函数，便于单测）
function pickImageDir(files, minImages = CBZ_MIN_IMAGES) {
  if (!Array.isArray(files)) return null;
  const counts = new Map();   // dir -> 图片数
  for (const f of files) {
    if (typeof f !== 'string' || !CBZ_IMG_RE.test(f)) continue;
    const d = path.dirname(f);
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = null, bestN = 0;
  for (const [d, n] of counts) if (n > bestN) { best = d; bestN = n; }
  if (!best || bestN < minImages) return null;
  return best;
}

// 递归统计目录内图片数（媒体库手动成册用：给用户明确的「图片不足 N 张」反馈）。
// 带深度/数量上限防异常大目录卡死 IPC；符号链接跳过（与 library.walk 同规则防循环）
function countImagesInDir(dir) {
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 12 || n >= 100000) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      try {
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) walk(path.join(d, ent.name), depth + 1);
        else if (ent.isFile() && CBZ_IMG_RE.test(ent.name)) n++;
      } catch (e) {}
    }
  };
  walk(String(dir || ''), 0);
  return n;
}

// 输出路径：<目录名>.cbz 与目录平级（纯函数：幂等路径逻辑单测用）
function cbzOutPath(dir) {
  return path.join(path.dirname(dir), path.basename(dir) + '.cbz');
}

// XML 文本转义（& < > " ' 全覆盖；属性值/元素文本共用）
function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ComicInfo.xml 组装（ComicRack 标准字段；纯函数，单测覆盖转义与字段取舍）。
// meta: { title, series, writer, web, language, date } —— 缺省字段整个元素省略（空元素不如不写，
// 阅读器对空串 Year/Month 会解析报错）；date 取任务入队时间（Year/Month），无则用当前时间
function buildComicInfoXml(meta = {}) {
  // 注意 NaN 是 falsy：不能写 meta.date ? … : new Date()，否则非法时间戳会被静默替换成当前时间
  const d = (meta.date === undefined || meta.date === null) ? new Date() : new Date(meta.date);
  const valid = !isNaN(d.getTime());
  const el = (name, v) =>
    (v === undefined || v === null || v === '' ? '' : '  <' + name + '>' + xmlEsc(String(v)) + '</' + name + '>\n');
  let xml = '<?xml version="1.0" encoding="utf-8"?>\n';
  xml += '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n';
  xml += el('Series', meta.series || meta.title);   // 系列名缺省回落标题（单话册子 Series=Title）
  xml += el('Title', meta.title);
  xml += el('Writer', meta.writer);
  if (valid) {
    xml += el('Year', d.getFullYear());
    xml += el('Month', d.getMonth() + 1);
  }
  xml += el('LanguageIso', meta.language || 'zh-CN');
  xml += el('Web', meta.web);
  xml += '</ComicInfo>\n';
  return xml;
}

// 打包核心：dir 内容平铺进 zip 根（图片在册子第一层，标准 CBZ 布局）+ staging 里的 ComicInfo.xml。
// opts.existsFn / opts.tarFn 供单测注入（不真跑 bsdtar / 不真查磁盘）；默认走真实实现。
// 返回 { ok:true, cbz, skipped } 或 { ok:false, reason }——打包失败抛给调用方按需静默。
async function makeCbzFromDir(dir, meta = {}, opts = {}) {
  const existsFn = typeof opts.existsFn === 'function'
    ? opts.existsFn
    : (p => { try { return fs.existsSync(p); } catch (e) { return false; } });
  const out = cbzOutPath(dir);
  // 幂等：同名册子已存在（重试场景 / 重复点击成册）直接返回已有路径，不重打包
  if (existsFn(out)) return { ok: true, skipped: true, cbz: out };
  // ComicInfo.xml 写进系统临时目录 staging：不污染原图目录；finally 清理，不留任何临时残留
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'keepsake-cbz-'));
  try {
    fs.writeFileSync(path.join(staging, 'ComicInfo.xml'),
      buildComicInfoXml({ ...meta, title: meta.title || path.basename(dir) }));
    // 多 -C 顺序：先把 dir 内容全收进 zip 根，再切到 staging 收 ComicInfo.xml（绝对路径，见文件头）
    const args = ['--format', 'zip', '-c', '-f', out, '-C', dir, '.', '-C', staging, 'ComicInfo.xml'];
    if (typeof opts.tarFn === 'function') {
      await opts.tarFn({ dir, out, staging, args });   // 注入路径：单测断言参数/staging 状态
    } else {
      // 必须用绝对路径调系统 bsdtar——Git Bash 环境的 GNU tar 在 PATH 里优先且不支持 zip
      const tarExe = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
      await new Promise((resolve, reject) => {
        const child = spawn(tarExe, args, { windowsHide: true });
        let err = '';
        // 看门狗：10 分钟超时杀进程防永久挂死。定时器必须及时清除——挂着会让 node 进程
        // 活到超时点（打包失败/进程早退场景下 main 进程退出被无故拖住）
        const watchdog = setTimeout(() => { try { child.kill(); } catch (e) {} reject(new Error('cbz 打包超时')); }, 10 * 60000);
        watchdog.unref();
        const settle = (fn, arg) => { clearTimeout(watchdog); fn(arg); };
        child.stderr.on('data', d => { err += d; });
        child.on('error', e => settle(reject, e));
        child.on('close', code => code === 0
          ? settle(resolve)
          : settle(reject, new Error('tar exit ' + code + ' ' + err.slice(0, 100))));
      });
      if (!fs.existsSync(out)) throw new Error('打包进程正常退出但未生成 ' + out);
    }
    return { ok: true, skipped: false, cbz: out };
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = { CBZ_MIN_IMAGES, CBZ_IMG_RE, pickImageDir, countImagesInDir, cbzOutPath, xmlEsc, buildComicInfoXml, makeCbzFromDir };
