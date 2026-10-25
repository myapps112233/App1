'use strict';

/** Token bucket used for sticker sends and for action attempts. */
function createBucket({ capacity, refillPerSecond, now = Date.now() }) {
  return {
    tokens: capacity,
    capacity,
    refillPerSecond,
    lastRefill: now,
  };
}

function takeToken(bucket, now) {
  const elapsed = Math.max(0, now - bucket.lastRefill) / 1000;
  if (elapsed > 0) {
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerSecond);
    bucket.lastRefill = now;
  }
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

/**
 * Fixed-window counter, good enough for coarse abuse control on cheap events.
 */
function createWindowCounter({ limit, windowMs, now = Date.now() }) {
  return { count: 0, limit, windowMs, resetAt: now + windowMs };
}

function hitWindow(counter, now) {
  if (now >= counter.resetAt) {
    counter.count = 0;
    counter.resetAt = now + counter.windowMs;
  }
  counter.count += 1;
  return counter.count <= counter.limit;
}

module.exports = { createBucket, takeToken, createWindowCounter, hitWindow };
