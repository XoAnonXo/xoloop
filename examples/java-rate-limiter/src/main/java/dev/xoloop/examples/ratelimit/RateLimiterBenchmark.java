package dev.xoloop.examples.ratelimit;

/**
 * Tiny deterministic benchmark entry point for XOLoop benchmark/improve routing.
 */
public final class RateLimiterBenchmark {
  private RateLimiterBenchmark() {}

  /**
   * Run a deterministic smoke benchmark and print JSON metrics.
   */
  public static void main(String[] args) {
    TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(1000, 1000, 1, 500);
    long started = System.nanoTime();
    int allowed = 0;
    for (int i = 0; i < 100_000; i += 1) {
      if (limiter.allow("bench-" + (i % 100), i).isAllowed()) {
        allowed += 1;
      }
    }
    long elapsedNanos = Math.max(1, System.nanoTime() - started);
    long decisionsPerSecond = (100_000L * 1_000_000_000L) / elapsedNanos;
    System.out.println("{\"decisions_per_second\":" + decisionsPerSecond + "}");
    if (allowed <= 0) {
      throw new IllegalStateException("benchmark should allow at least one request");
    }
  }
}
