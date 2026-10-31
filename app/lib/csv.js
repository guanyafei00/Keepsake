'use strict';

function escapeCsvCell(value) {
  const text = String(value == null ? '' : value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function serializeCsv(headers, rows) {
  const allRows = [headers, ...rows];
  return '\uFEFF' + allRows.map(row => row.map(escapeCsvCell).join(',')).join('\r\n') + '\r\n';
}

async function exportGone({ subscriptions, getFiles, itemUrl, showSaveDialog, writeFile, now = new Date() }) {
  const rows = [];
  for (const sub of subscriptions) {
    if (!(sub.gone || []).length) continue;
    const files = getFiles(sub);
    for (const id of sub.gone) {
      const local = files[id] || [];
      let source = '';
      try { source = itemUrl(sub, { id, type: 'video' }) || itemUrl(sub, { id, type: 'text' }) || ''; } catch (error) {}
      rows.push([sub.name || '', sub.kind || '', id, source, local.join(' ; '), local.length ? '在' : '已不在本地']);
    }
  }
  if (!rows.length) return { ok: false, reason: '当前没有被判定为「源头已删除」的内容' };
  const csv = serializeCsv(['订阅名', '类型', '内容 ID', '源头链接', '本地文件', '本地状态'], rows);
  const result = await showSaveDialog('Keepsake-删帖清单-' + now.toISOString().slice(0, 10) + '.csv');
  if (result.canceled || !result.filePath) return { ok: false, reason: '已取消' };
  await writeFile(result.filePath, csv);
  return { ok: true, path: result.filePath, count: rows.length };
}


module.exports = { escapeCsvCell, serializeCsv, exportGone };
