#!/usr/bin/env node
// 签名更新清单：node tools/sign_update.js <version> <url> [sha256] [notesFile|-] [pageUrl]
// 私钥路径：环境变量 DGO_UPDATE_KEY 或默认 ../update-signing/private.pem（相对本脚本）
// notesFile：更新内容文本文件路径；传 '-' 从 stdin 读。notes/page 会进签名原文（防篡改）
// 输出：可直接发布的 update.json（含 sig）
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 供 CI / 测试直接 require 调用
function signManifest(version, url, sha256, keyPath, notes, page) {
  keyPath = keyPath || process.env.DGO_UPDATE_KEY || path.join(__dirname, '..', 'update-signing', 'private.pem');
  if (!fs.existsSync(keyPath)) throw new Error('找不到私钥: ' + keyPath);
  const j = { version, url, sha256: sha256 || '' };
  if (notes) j.notes = notes;
  if (page) j.page = page;
  j.sig = crypto.sign(null, Buffer.from(`${version}|${url}|${j.sha256}|${notes || ''}|${page || ''}`), fs.readFileSync(keyPath)).toString('base64');
  return j;
}

const [version, url, sha256, notesPath, page] = process.argv.slice(2);
if (require.main === module && (!version || !url)) {
  console.error('用法: node tools/sign_update.js <version> <url> [sha256] [notesFile|-] [pageUrl]');
  console.error('示例: node tools/sign_update.js 0.1.1 "https://github.com/guanyafei00/Keepsake/releases/download/v0.1.1-beta/DGO-Setup-0.1.1.exe" <安装包sha256> notes.txt "https://github.com/guanyafei00/Keepsake/releases/tag/v0.1.1-beta"');
  process.exit(1);
}
if (require.main === module) {
  let notes = '';
  if (notesPath === '-') notes = fs.readFileSync(0, 'utf-8').trim();
  else if (notesPath) notes = fs.readFileSync(notesPath, 'utf-8').trim();
  console.log(JSON.stringify(signManifest(version, url, sha256, undefined, notes, page), null, 2));
}
module.exports = { signManifest };
