package dev.xoloop.examples.ratelimit;

/**
 * Immutable result returned by {@link TokenBucketRateLimiter#allow(String, long)}.
 */
public final class RateLimitDecision {
  private final boolean allowed;
  private final int remainingTokens;
  private final long retryAfterMillis;

  private RateLimitDecision(boolean allowed, int remainingTokens, long retryAfterMillis) {
    if (remainingTokens < 0) {
      throw new IllegalArgumentException("remainingTokens must be non-negative");
    }
    if (retryAfterMillis < 0) {
      throw new IllegalArgumentException("retryAfterMillis must be non-negative");
    }
    this.allowed = allowed;
    this.remainingTokens = remainingTokens;
    this.retryAfterMillis = retryAfterMillis;
  }

  /**
   * Create a decision for an allowed request.
   */
  public static RateLimitDecision allowed(int remainingTokens) {
    return new RateLimitDecision(true, remainingTokens, 0);
  }

  /**
   * Create a decision for a rejected request.
   */
  public static RateLimitDecision rejected(long retryAfterMillis) {
    return new RateLimitDecision(false, 0, retryAfterMillis);
  }

  /**
   * Return true when the request consumed a token and may proceed.
   */
  public boolean isAllowed() {
    return allowed;
  }

  /**
   * Return the number of tokens still available after this decision.
   */
  public int getRemainingTokens() {
    return remainingTokens;
  }

  /**
   * Return how long the caller should wait before retrying a rejected request.
   */
  public long getRetryAfterMillis() {
    return retryAfterMillis;
  }
}
