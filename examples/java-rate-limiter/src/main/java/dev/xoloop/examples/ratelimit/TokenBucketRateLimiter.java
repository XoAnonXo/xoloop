package dev.xoloop.examples.ratelimit;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

/**
 * In-memory token bucket rate limiter for small services and tests.
 *
 * <p>Each key owns an independent bucket. A request is allowed when the bucket
 * has at least one token. Tokens refill over time up to the configured
 * capacity. The number of tracked keys is bounded to avoid unbounded memory
 * growth when callers send many distinct keys.</p>
 */
public final class TokenBucketRateLimiter {
  public static final int DEFAULT_MAX_TRACKED_KEYS = 10_000;

  private final int capacity;
  private final int refillTokens;
  private final long refillPeriodMillis;
  private final int maxTrackedKeys;
  private final Map<String, Bucket> buckets = new HashMap<>();

  public TokenBucketRateLimiter(int capacity, int refillTokens, long refillPeriodMillis) {
    this(capacity, refillTokens, refillPeriodMillis, DEFAULT_MAX_TRACKED_KEYS);
  }

  public TokenBucketRateLimiter(int capacity, int refillTokens, long refillPeriodMillis, int maxTrackedKeys) {
    if (capacity <= 0) {
      throw new IllegalArgumentException("capacity must be positive");
    }
    if (refillTokens <= 0) {
      throw new IllegalArgumentException("refillTokens must be positive");
    }
    if (refillPeriodMillis <= 0) {
      throw new IllegalArgumentException("refillPeriodMillis must be positive");
    }
    if (maxTrackedKeys <= 0) {
      throw new IllegalArgumentException("maxTrackedKeys must be positive");
    }
    this.capacity = capacity;
    this.refillTokens = refillTokens;
    this.refillPeriodMillis = refillPeriodMillis;
    this.maxTrackedKeys = maxTrackedKeys;
  }

  /**
   * Decide whether a key can perform one action at the supplied timestamp.
   */
  public synchronized RateLimitDecision allow(String key, long nowMillis) {
    String normalizedKey = normalizeKey(key);
    Bucket bucket = buckets.get(normalizedKey);
    if (bucket == null) {
      evictOldestBucketIfFull();
      bucket = new Bucket(capacity, nowMillis);
      buckets.put(normalizedKey, bucket);
    }
    bucket.lastAccessMillis = nowMillis;
    refill(bucket, nowMillis);

    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return RateLimitDecision.allowed(bucket.tokens);
    }

    return RateLimitDecision.rejected(millisUntilNextToken(bucket, nowMillis));
  }

  /**
   * Return the currently tracked key count. Useful for tests and diagnostics.
   */
  public synchronized int trackedKeyCount() {
    return buckets.size();
  }

  private String normalizeKey(String key) {
    String normalized = Objects.requireNonNull(key, "key must not be null").trim();
    if (normalized.isEmpty()) {
      throw new IllegalArgumentException("key must not be blank");
    }
    return normalized;
  }

  private void evictOldestBucketIfFull() {
    if (buckets.size() < maxTrackedKeys) {
      return;
    }
    String oldestKey = null;
    long oldestAccess = Long.MAX_VALUE;
    for (Map.Entry<String, Bucket> entry : buckets.entrySet()) {
      if (entry.getValue().lastAccessMillis < oldestAccess) {
        oldestKey = entry.getKey();
        oldestAccess = entry.getValue().lastAccessMillis;
      }
    }
    if (oldestKey != null) {
      buckets.remove(oldestKey);
    }
  }

  private void refill(Bucket bucket, long nowMillis) {
    if (nowMillis <= bucket.lastRefillMillis) {
      return;
    }

    long elapsed = nowMillis - bucket.lastRefillMillis;
    long periods = elapsed / refillPeriodMillis;
    if (periods <= 0) {
      return;
    }

    long tokensToAdd = periods * (long) refillTokens;
    bucket.tokens = (int) Math.min(capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefillMillis += periods * refillPeriodMillis;
  }

  private long millisUntilNextToken(Bucket bucket, long nowMillis) {
    long elapsedSinceRefill = Math.max(0, nowMillis - bucket.lastRefillMillis);
    long remainder = elapsedSinceRefill % refillPeriodMillis;
    return remainder == 0 ? refillPeriodMillis : refillPeriodMillis - remainder;
  }

  private static final class Bucket {
    private int tokens;
    private long lastRefillMillis;
    private long lastAccessMillis;

    private Bucket(int tokens, long lastRefillMillis) {
      this.tokens = tokens;
      this.lastRefillMillis = lastRefillMillis;
      this.lastAccessMillis = lastRefillMillis;
    }
  }
}
