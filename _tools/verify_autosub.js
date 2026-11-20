// 端到端冒烟：自动字幕总开关（S2 附加）——从真实源码抽片段验证，非复刻
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const APP = path.join(__dirname, '..', 'app');
let pass = 0, fail = 0;
function ok(name, fn) {
  try { fn(); console.log('  PASS', name); pass++; }
  catch (e) { console.log('  FAIL', name, '—', e.message); fail++; }
}
const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf-8');
const setSrc = fs.readFileSync(path.join(APP, 'lib', 'settings.js'), 'utf-8');
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf-8');
const preload = fs.readFileSync(path.join(APP, 'preload.js'), 'utf-8');

console.log('\n[1] settings 字段');
ok('默认 false（configure + set 两路径）', () => {
  assert(setSrc.includes('if (data.autoSubtitle === undefined) data.autoSubtitle = false'));
  assert(setSrc.includes('if (p.autoSubtitle !== undefined) p.autoSubtitle = !!p.autoSubtitle'));
});
ok('settings:get 会暴露 autoSubtitle（get 返回全量 {...data}）', () => {
  assert(setSrc.includes('function get() { return { ...data }; }'));
});

console.log('\n[2] IPC + preload 桥接');
ok('main 注册 settings:setAutoSubtitle', () => {
  assert(mainSrc.includes("ipcMain.handle('settings:setAutoSubtitle'"));
});
ok('preload 暴露 settingsSetAutoSubtitle', () => {
  assert(preload.includes('settingsSetAutoSubtitle: (on) => ipcRenderer.invoke(\'settings:setAutoSubtitle\''));
});

console.log('\n[3] 下载入队注入 _subs');
ok('手动下载：_subs 叠加全局开关', () => {
  const line = mainSrc.split('\n').find(l => l.includes("const autoSubOn = !!settings.get().autoSubtitle;"));
  assert(line, '未找到 autoSubOn 定义');
  const addLine = mainSrc.split('\n').find(l => l.includes("const item = queue.add(url.trim()") && l.includes('autoSubOn'));
  assert(addLine && addLine.includes('|| autoSubOn'), '手动入队应 OR 全局开关: ' + addLine);
});
ok('订阅入队两处：_subs 叠加全局开关', () => {
  const hits = (mainSrc.match(/_subs: !!real\.autoSubs \|\| !!settings\.get\(\)\.autoSubtitle/g) || []).length;
  assert(hits === 2, '应有两处订阅入队叠加，实际 ' + hits);
});

console.log('\n[4] 完成回调无字幕兜底转写');
ok('兜底逻辑存在且限定视频/音频扩展名', () => {
  assert(mainSrc.includes('const autoSubFallback = !!settings.get().autoSubtitle;'));
  assert(mainSrc.includes('if (autoSubFallback && /\\.(mp4|mkv|webm|mov|avi|flv|m4a|mp3|wav)$/i.test(t.filePath))'), '应限定视频/音频扩展名');
  // 兜底判定在 enqueueTranscribe 之前、needTranscribe 赋值处
  assert(mainSrc.includes('if (!fs.existsSync(srt)) needTranscribe = true;   // 无字幕 → 兜底转写'));
});
ok('已有 srt 跳过（不重复吃 CPU）', () => {
  const m = mainSrc.match(/const srt = t\.filePath\.replace\([^;]+;[\s\S]*?if \(!fs\.existsSync\(srt\)\) needTranscribe = true;/);
  assert(m && m[0].includes('!fs.existsSync(srt)'), '应仅在无 srt 时兜底');
});
ok('防重复标记 _transcribed 保留', () => {
  assert(mainSrc.includes('if (t.status !== \'done\' || !t.filePath || t._transcribed) continue;'));
  assert(mainSrc.includes('t._transcribed = true;   // 防重复'));
});

console.log('\n[5] 设置页 UI');
ok('开关 checkbox + 保存函数存在', () => {
  assert(html.includes('id="autoSubtitleChk"') && html.includes('saveAutoSubtitle(this.checked)'));
  assert(html.includes('async function saveAutoSubtitle(on)'));
  assert(html.includes('window.keepsake.settingsSetAutoSubtitle(on)'));
});
ok('设置加载时回填 checked', () => {
  assert(html.includes("$('autoSubtitleChk').checked = !!s.autoSubtitle;"));
});
ok('文案说明默认关闭 + 本地转写吃 CPU', () => {
  assert(html.includes('默认关闭') && html.includes('whisper'));
});

console.log(`\n===== ${pass} PASS / ${fail} FAIL =====`);
process.exit(fail ? 1 : 0);
