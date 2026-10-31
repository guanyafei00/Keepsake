'use strict';
const assert = require('assert');
const fs = require('fs');
const { subscriptionStatuses, downloadCapacity } = require('../lib/observability');

async function test(name, fn) {
  try { await fn(); console.log('PASS ' + name); }
  catch (error) { console.error('FAIL ' + name + ': ' + error.stack); process.exitCode = 1; }
}

async function main() {
  const strategyCalls = [];
  const strategy = { forUrl(url) { strategyCalls.push(url); return { breakerUntil: 5000 }; } };
  const rows = subscriptionStatuses([
    { id: 'a', name: 'A', url: 'https://www.bilibili.com/space/1', lastCheck: 1000, lastFailAt: 2000, lastError: '429', failStreak: 2, paused: true },
    { id: 'b', name: 'B', url: 'https://example.net/u/1', lastCheck: 0, lastFailAt: 3000, lastError: '<img>', failStreak: 1, userPaused: true },
  ], strategy, 3000);
  await test('returns accurate subscription timestamps and pause state', () => {
    assert.strictEqual(rows[0].lastSuccessAt, 1000);
    assert.strictEqual(rows[0].lastFailAt, 2000);
    assert.strictEqual(rows[0].paused, true);
    assert.strictEqual(rows[0].userPaused, false);
    assert.strictEqual(rows[1].lastSuccessAt, 0);
    assert.strictEqual(rows[1].lastError, '<img>');
  });
  await test('only maps host when subscription URL matches a known strategy host', () => {
    assert.strictEqual(rows[0].cooldownAvailable, true);
    assert.strictEqual(rows[0].cooldownUntil, 5000);
    assert.strictEqual(rows[0].cooldownRemainingMs, 2000);
    assert.strictEqual(rows[1].cooldownAvailable, false);
    assert.strictEqual(rows[1].cooldownUntil, null);
    assert.deepStrictEqual(strategyCalls, ['https://www.bilibili.com/space/1']);
  });
  await test('capacity query reports values and measuredAt', async () => {
    const fakeFs = { promises: { statfs: async () => ({ bsize: 10, blocks: 100, bavail: 25 }) } };
    assert.deepStrictEqual(await downloadCapacity(fakeFs, '/downloads', 1234), {
      available: true, path: '/downloads', totalBytes: 1000, freeBytes: 250, usedBytes: 750, measuredAt: 1234, unavailableReason: '',
    });
  });
  await test('capacity query failure is unavailable, never fake zero', async () => {
    const result = await downloadCapacity({ promises: { statfs: async () => { throw new Error('denied'); } } }, '/private', 2345);
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.totalBytes, null);
    assert.strictEqual(result.freeBytes, null);
    assert.strictEqual(result.usedBytes, null);
    assert.strictEqual(result.measuredAt, 2345);
    assert.match(result.unavailableReason, /denied/);
  });
  await test('capacity query rejects unsupported statfs with explicit unavailable result', async () => {
    const result = await downloadCapacity({}, '/downloads', 3456);
    assert.strictEqual(result.available, false);
    assert.strictEqual(result.usedBytes, null);
    assert.match(result.unavailableReason, /不支持/);
  });
  if (process.exitCode) process.exit(1);
}
main().catch(error => { console.error(error.stack); process.exit(1); });
