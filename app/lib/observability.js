'use strict';

const KNOWN_STRATEGY_HOSTS = ['bilibili.com', 'pixiv.net', 'x.com', 'twitter.com', 'instagram.com', 'weibo.com'];

function subscriptionStatuses(subscriptions, strategy, now = Date.now()) {
  return subscriptions.map(sub => {
    const failed = !!(sub.lastError && (!sub.lastCheck || (sub.lastFailAt || 0) > (sub.lastCheck || 0)));
    let cooldownAvailable = false;
    let cooldownUntil = null;
    let cooldownRemainingMs = null;
    try {
      const host = new URL(sub.url).hostname.toLowerCase();
      const matchedHost = KNOWN_STRATEGY_HOSTS.find(candidate => host === candidate || host.endsWith('.' + candidate));
      if (matchedHost && typeof strategy.forUrl === 'function') {
        const state = strategy.forUrl(sub.url);
        cooldownAvailable = true;
        cooldownUntil = Number(state.breakerUntil) || 0;
        cooldownRemainingMs = Math.max(0, cooldownUntil - now);
      }
    } catch (e) {}
    return {
      id: sub.id,
      name: sub.name,
      intervalMin: sub.intervalMin || 0,
      lastCheck: sub.lastCheck || 0,
      lastSuccessAt: sub.lastCheck || 0,
      lastFailAt: sub.lastFailAt || 0,
      lastError: failed ? String(sub.lastError || '') : '',
      failStreak: sub.failStreak || 0,
      paused: !!sub.paused,
      userPaused: !!sub.userPaused,
      cooldownAvailable,
      cooldownUntil,
      cooldownRemainingMs,
    };
  });
}

async function downloadCapacity(fs, dir, now = Date.now()) {
  const measuredAt = now;
  try {
    if (!fs || !fs.promises || typeof fs.promises.statfs !== 'function') {
      throw new Error('当前运行时不支持文件系统容量查询');
    }
    const stats = await fs.promises.statfs(dir);
    const blockSize = Number(stats.bsize || stats.frsize);
    if (!Number.isFinite(blockSize) || blockSize <= 0) throw new Error('文件系统未返回有效块大小');
    const totalBytes = Number(stats.blocks) * blockSize;
    const freeBytes = Number(stats.bavail) * blockSize;
    if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes) || totalBytes < 0 || freeBytes < 0) {
      throw new Error('容量数据无效');
    }
    return {
      available: true, path: dir, totalBytes, freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes), measuredAt, unavailableReason: '',
    };
  } catch (error) {
    return {
      available: false, path: dir, totalBytes: null, freeBytes: null, usedBytes: null,
      measuredAt, unavailableReason: String(error && error.message || error).slice(0, 160),
    };
  }
}

module.exports = { subscriptionStatuses, downloadCapacity };
