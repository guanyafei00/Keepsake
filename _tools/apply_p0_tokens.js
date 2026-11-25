// P0 令牌收敛：圆角→4档令牌 / 字号→字阶 / 间距奇数→4pt网格（只动 <style> 段的间距）
const fs = require('fs');
const p = __dirname + '/../app/index.html';
let src = fs.readFileSync(p, 'utf8');
const before = src;

// —— 1. 圆角：裸 px → 4 档令牌（6/8/12/14）——
const rmap = { 4:'var(--r-xs)',5:'var(--r-xs)',6:'var(--r-xs)',7:'var(--r-sm)',8:'var(--r-sm)',9:'var(--r-sm)',10:'var(--r-md)',11:'var(--r-md)',12:'var(--r-md)',13:'var(--r)',14:'var(--r)',16:'var(--r)',18:'var(--r)' };
src = src.replace(/(border-radius:)([^;"}]+)/g, (m, prop, val) => {
  const nv = val.trim().split(/\s+/).map(t => {
    const mm = t.match(/^(\d+)px$/);
    return mm && rmap[mm[1]] ? rmap[mm[1]] : t;   // 多值/50%/999px/0/var() 原样保留
  }).join(' ');
  return prop + nv;
});
// 令牌本体对齐新档位
src = src.replace('--r-md:10px; --r-sm:7px;', '--r-md:12px; --r-sm:8px;');

// —— 2. 字号：22 种 → 字阶 12/13/14/16/18/20/25/40/44 ——
const fsMap = v => {
  const n = parseFloat(v);
  if (n <= 12.5) return '12';           // 可读性底线：<12px 全提 12
  if (n <= 13.5) return '13';
  if (n <= 15) return '14';
  if (n <= 17) return '16';
  if (n <= 20) return '18';
  if (n === 23 || n === 26) return '25';
  return String(n);                      // 20/25/40/44 保留
};
src = src.replace(/(font-size:)([\d.]+)px/g, (m, prop, v) => prop + fsMap(v) + 'px');

// —— 3. 间距：仅 <style> 段，奇数 3/5/7/9/11/13 → 4/4/8/8/12/12（负值跳过）——
const gi = src.indexOf('<style>'), ge = src.indexOf('</style>');
let css = src.slice(gi, ge);
const smap = { 3:'4', 5:'4', 7:'8', 9:'8', 11:'12', 13:'12' };
css = css.replace(/(padding|margin|gap|row-gap|column-gap)(-top|-right|-bottom|-left)?:(\s*)([^;}]+)/g, (m, prop, side, sp, val) => {
  const nv = val.trim().split(/\s+/).map(t => {
    if (t.startsWith('-')) return t;                 // 负 margin 原样
    const mm = t.match(/^(\d+)px$/);
    return mm && smap[mm[1]] ? smap[mm[1]] + 'px' : t;
  }).join(' ');
  return prop + (side || '') + ':' + sp + nv;
});
src = src.slice(0, gi) + css + src.slice(ge);

fs.writeFileSync(p, src);
console.log('changed:', src !== before, 'bytes:', src.length);
// 残余统计
const radius = [...new Set((src.match(/border-radius:[^;"}]+/g) || []).map(s => s.split(':')[1]))];
console.log('radius values now:', radius.length, JSON.stringify(radius));
const fset = [...new Set((src.match(/font-size:[\d.]+px/g) || []).map(s => s.split(':')[1]))];
console.log('font sizes now:', fset.length, JSON.stringify(fset));
