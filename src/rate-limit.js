/**
 * Rate limit in-memory đơn giản cho endpoint public (install / enroll).
 * Không thay thế WAF/Nginx limit_req trên production, nhưng chặn brute-force token.
 */
function createRateLimiter({ windowMs = 60_000, max = 20 } = {}) {
  const hits = new Map(); // key -> { count, resetAt }

  function cleanup(now) {
    if (hits.size < 500) return;
    for (const [k, v] of hits) {
      if (v.resetAt <= now) hits.delete(k);
    }
  }

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const key = `${ip}:${req.path}`;
    cleanup(now);

    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).type("text/plain").send("Too many requests. Thử lại sau.");
    }
    next();
  };
}

module.exports = { createRateLimiter };
