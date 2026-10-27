type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

export function rateLimitRetrySeconds(key: string) {
  return Math.max(1, Math.ceil(((buckets.get(key)?.resetAt ?? Date.now() + 60_000) - Date.now()) / 1000));
}

/** Fixed-window rate limiter. Returns true if the request is allowed. */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  cost = 1,
): boolean {
  const now = Date.now();
  if (!Number.isFinite(cost) || cost <= 0 || cost > limit) return false;
  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (!bucket && buckets.size >= 20_000) {
      for (const [oldKey, old] of buckets) if (now >= old.resetAt) buckets.delete(oldKey);
      if (buckets.size >= 20_000) return false;
    }
    buckets.set(key, { count: cost, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count + cost > limit) return false;
  bucket.count += cost;
  return true;
}

/** Periodic cleanup so the map does not grow forever. */
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}, 60_000).unref?.();
