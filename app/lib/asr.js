// 本地转写（照 VidBee 方法）：whisper.cpp 独立 exe + 用户自选下载 Whisper 模型
// 流程：媒体文件 → ffmpeg 提 16kHz 单声道 wav → whisper-cli 输出 SRT + TXT（同目录）
// 模型源：默认 hf-mirror.com（国内直连），可切官方 HuggingFace。模型下载后完全离线可用。
const { spawn } = require('child_process');
const path = require('path');

// 平台化引擎文件名：win 加 .exe，mac/linux 裸名
function exe(n) { return process.platform === 'win32' ? n + '.exe' : n; }
const fs = require('fs');
const https = require('https');
const urlMod = require('url');   // 注意：勿用变量名 url——downloadModel 里的下载地址字符串曾遮蔽此模块，302 重定向时 url.resolve 必炸

let BIN = null;          // bin 目录（含 whisper-cli.exe + ffmpeg.exe）
let MODELS_DIR = null;
let PERSIST = null;      // 持久化回调（settings.set），存 active 模型
let activeModelId = null;

function configure({ binDir, modelsDir, onPersist }) {
  BIN = binDir; MODELS_DIR = modelsDir; PERSIST = onPersist || null;
  activeModelId = null;
}

// Whisper 模型目录（ggerganov/whisper.cpp 官方 ggml 量化模型）
// v0.2.15 修正：Turbo 此前标 547MB，实测 ggml-large-v3-turbo.bin 是 1.55GB——
// 错值除了误导用户（默默吃掉 1.6G 磁盘），还让 downloaded() 的 0.8 阈值校验形同虚设
//（下载一半的 900MB 残件会过 547*0.8 的线被误判完整）。sizeMB 必须如实。
const MODELS = [
  { id: 'tiny',             file: 'ggml-tiny.bin',             sizeMB: 75,    label: 'Tiny · 75MB · 最快，够用',        rec: false },
  { id: 'base',             file: 'ggml-base.bin',             sizeMB: 142,   label: 'Base · 142MB · 快，更好',        rec: false },
  { id: 'small',            file: 'ggml-small.bin',            sizeMB: 466,   label: 'Small · 466MB · 均衡，推荐',      rec: true },
  { id: 'large-v3-turbo',   file: 'ggml-large-v3-turbo.bin',   sizeMB: 1550,  label: 'Turbo · 1.5GB · 最准，体积大',   rec: false },
  { id: 'medium',           file: 'ggml-medium.bin',           sizeMB: 1530,  label: 'Medium · 1.5GB · 慢，更准',      rec: false },
];
const MIRRORS = [
  { id: 'mirror', label: '国内镜像（hf-mirror，推荐）', base: 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/' },
  { id: 'hf',     label: '官方 HuggingFace',           base: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' },
];
let mirror = 'mirror';
function setMirror(id) { if (MIRRORS.some(m => m.id === id)) mirror = id; }

function modelPath(id) {
  const m = MODELS.find(x => x.id === id);
  return m ? path.join(MODELS_DIR, m.file) : null;
}
function downloaded(id) {
  const p = modelPath(id);
  if (!p || !fs.existsSync(p)) return false;
  // 完整性粗校验：ggml 模型至少应有声明体积的 80%
  const m = MODELS.find(x => x.id === id);
  return fs.statSync(p).size > m.sizeMB * 1024 * 1024 * 0.8;
}
function listModels() {
  return MODELS.map(m => ({
    id: m.id, label: m.label, sizeMB: m.sizeMB, rec: m.rec,
    downloaded: downloaded(m.id),
    path: modelPath(m.id)
  }));
}
function anyModel() {
  // 优先用户指定的默认模型；未指定（或指定的没下载）时按声明顺序取第一个已下载的
  if (activeModelId && downloaded(activeModelId)) return activeModelId;
  const d = MODELS.find(m => downloaded(m.id));
  return d ? d.id : null;
}
function getActive() { return activeModelId; }
function setActive(id) {
  if (!id) { activeModelId = null; return true; }
  if (!MODELS.some(m => m.id === id)) return false;
  if (!downloaded(id)) return false;
  activeModelId = id;
  if (PERSIST) { try { PERSIST({ asrModel: id }); } catch (e) {} }
  return true;
}
function restoreActive(id) { if (id && MODELS.some(m => m.id === id) && downloaded(id)) activeModelId = id; }

// 删除已下载的模型文件，释放磁盘。使用中的模型不允许删（先切换到别的模型）——
// 否则转写队列跑到一半模型文件没了，报错比拦截难看得多。
function deleteModel(id) {
  const m = MODELS.find(x => x.id === id);
  if (!m) return { ok: false, reason: '未知模型' };
  if (!downloaded(id)) return { ok: false, reason: '该模型未下载' };
  if (activeModelId === id) return { ok: false, reason: '该模型正在使用中，请先切换到其他模型' };
  try {
    const sizeMB = Math.round(fs.statSync(modelPath(id)).size / 1048576);
    fs.unlinkSync(modelPath(id));
    return { ok: true, freedMB: sizeMB };
  } catch (e) {
    return { ok: false, reason: '删除失败：' + e.message };
  }
}

// 下载模型（content-length + chunk 计数报进度，onProgress(0-100)）
function downloadModel(id, onProgress) {
  return new Promise((resolve, reject) => {
    const m = MODELS.find(x => x.id === id);
    if (!m) return reject(new Error('未知模型'));
    if (downloaded(id)) return resolve(modelPath(id));
    fs.mkdirSync(MODELS_DIR, { recursive: true });
    const dlUrl = MIRRORS.find(x => x.id === mirror).base + m.file;
    const tmp = modelPath(id) + '.part';
    const go = (u, redirectLeft) => {
      const req = https.get(u, res => {
        res.on('error', reject);   // 网络半途断开不再变未捕获异常
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectLeft > 0) {
          res.resume();
          return go(urlMod.resolve(u, res.headers.location), redirectLeft - 1);   // 相对重定向也兜住
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载失败 HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        const out = fs.createWriteStream(tmp);
        let got = 0, last = -1, settled = false;
        const done = fn => { if (!settled) { settled = true; fn(); } };
        res.on('data', c => {
          got += c.length;
          if (total && onProgress) {
            const pct = Math.floor(got / total * 100);
            if (pct !== last) { last = pct; onProgress(pct); }
          }
        }).pipe(out);
        out.on('finish', () => {
          out.close(() => {
            try {
              // 完整性校验：远端声明了大小但本地明显不足 → 删残件报错（避免「报错后再点却提示完成」的假成功）
              if (total && got < total * 0.98) {
                try { fs.unlinkSync(tmp); } catch (e) {}
                return done(() => reject(new Error(`下载不完整（${Math.round(got / 1048576)}MB / ${Math.round(total / 1048576)}MB），请重试或切换下载源`)));
              }
              fs.renameSync(tmp, modelPath(id));
              done(() => resolve(modelPath(id)));
            } catch (e) { done(() => reject(e)); }
          });
        });
        out.on('error', e => done(() => reject(e)));
      });
      req.on('error', e => reject(e));
      req.setTimeout(60 * 1000, () => req.destroy(new Error('下载超时（网络不稳，可稍后重试或切换下载源）')));
    };
    go(dlUrl, 5);
  });
}

// 转写：媒体文件 → 16k wav → whisper-cli → 同目录 SRT + TXT
// onProgress(pct) 来自 whisper-cli 的 -pp 进度输出
function transcribe(mediaPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const modelId = opts.modelId || anyModel();
    if (!modelId) return reject(new Error('尚未下载任何转写模型（去设置页选一个）'));
    const mp = modelPath(modelId);
    const wav = path.join(MODELS_DIR, 'tmp-' + Date.now() + '.wav');
    const base = mediaPath.replace(/\.[^.]+$/, '');
    const ffmpeg = path.join(BIN, exe('ffmpeg'));
    const cli = path.join(BIN, 'whisper', exe('whisper-cli'));
    if (!fs.existsSync(cli)) return reject(new Error('whisper-cli.exe 缺失'));

    fs.mkdirSync(MODELS_DIR, { recursive: true });
    // 1) ffmpeg 提 16kHz 单声道 wav（whisper 要求）。加超时——挂死的 ffmpeg 不再永久卡住转写队列
    const ff = spawn(ffmpeg, ['-y', '-i', mediaPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { windowsHide: true });
    let ffErr = '';
    const ffTimer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} }, 10 * 60 * 1000);   // 10 分钟足够提完几个小时的音轨
    ff.stderr.on('data', d => ffErr += d);
    ff.on('error', e => { clearTimeout(ffTimer); reject(e); });
    ff.on('close', code => {
      clearTimeout(ffTimer);
      if (code !== 0) {
        try { fs.unlinkSync(wav); } catch (e) {}   // 提取失败不残留临时 wav
        return reject(new Error('音频提取失败: ' + ffErr.slice(-150)));
      }
      // 2) whisper-cli 转写（-pp 进度；-osrt -otxt 双输出到媒体同目录）
      const args = ['-m', mp, '-f', wav, '-l', opts.language || 'auto', '-pp', '-osrt', '-otxt', '-of', base];
      if (opts.language && opts.language !== 'auto') args.push('--prompt', '以下是普通话的句子。');   // 中文提示提升断句
      const child = spawn(cli, args, { windowsHide: true });
      let out = '', err = '', lastPct = 0;
      // 转写总超时 30 分钟——超长文件/CPU 过载导致的挂死不再永久占住串行队列
      const wTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) {}
        try { fs.unlinkSync(wav); } catch (e) {}
        reject(new Error('转写超时（30 分钟未完成，文件过长或 CPU 过载）'));
      }, 30 * 60 * 1000);
      const onProg = pct => { if (pct > lastPct && opts.onProgress) { lastPct = pct; opts.onProgress(pct); } };
      child.stdout.on('data', d => {
        out += d;
        const m = out.match(/progress\s*=\s*(\d+)%/g);
        if (m) { const last = m[m.length - 1].match(/(\d+)%/); if (last) onProg(parseInt(last[1], 10)); }
      });
      child.stderr.on('data', d => err += d);
      child.on('error', () => { clearTimeout(wTimer); try { fs.unlinkSync(wav); } catch (e) {} reject(new Error('whisper-cli 启动失败')); });
      child.on('close', wcode => {
        clearTimeout(wTimer);
        try { fs.unlinkSync(wav); } catch (e) {}
        if (wcode !== 0) return reject(new Error('转写失败 code=' + wcode + ': ' + (err.split('\n').find(l => l.includes('error')) || err).slice(0, 150)));
        onProg(100);
        resolve({
          srt: fs.existsSync(base + '.srt') ? base + '.srt' : null,
          txt: fs.existsSync(base + '.txt') ? base + '.txt' : null,
          model: modelId
        });
      });
    });
  });
}

module.exports = { configure, MODELS, MIRRORS, setMirror, listModels, downloadModel, transcribe, anyModel, downloaded, getActive, setActive, restoreActive, deleteModel };
