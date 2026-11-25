// 设计令牌审计：统计 index.html 中圆角/内边距/字号/间距/阴影的使用频次，找出不成体系的散值
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/../app/index.html', 'utf8');

// 只取 <style> 段
const css = (src.match(/<style>[\s\S]*?<\/style>/) || [''])[0];

const counter = (name, re) => {
  const map = new Map();
  let m;
  while ((m = re.exec(css))) {
    const v = m[1];
    map.set(v, (map.get(v) || 0) + 1);
  }
  const arr = [...map.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n== ${name}（${arr.reduce((s, e) => s + e[1], 0)} 处，${arr.length} 种取值）==`);
  arr.forEach(([v, n]) => console.log(`  ${v.padEnd(14)} × ${n}`));
};

counter('border-radius', /border-radius:([^;}]+)/g);
counter('font-size', /font-size:([^;}]+)/g);
counter('padding（简写）', /padding:([^;}]+)/g);
counter('gap', /gap:([^;}]+)/g);
counter('box-shadow', /box-shadow:([^;}]+)/g);

// 内联样式里的散值（设计令牌泄漏到 HTML）
const inline = (src.match(/style="[^"]*border-radius:[^"]*"/g) || []).map(s => s.match(/border-radius:([^;"]+)/)[1]);
const imap = new Map(); inline.forEach(v => imap.set(v, (imap.get(v) || 0) + 1));
console.log('\n== 内联 style 里的 border-radius ==');
[...imap.entries()].sort((a, b) => b[1] - a[1]).forEach(([v, n]) => console.log(`  ${v.padEnd(14)} × ${n}`));

// var() 令牌定义
const vars = src.match(/--r[a-z-]*:\s*[^;]+/g) || [];
console.log('\n== 圆角令牌定义 ==');
vars.slice(0, 10).forEach(v => console.log('  ' + v.trim()));
