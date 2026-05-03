package dev.xoloop.examples.ratelimit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class TokenBucketRateLimiterTest {
  @Test
  void allowsRequestsUntilBucketIsEmpty() {
    TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(2, 1, 1000);

    RateLimitDecision first = limiter.allow("user-1", 0);
    RateLimitDecision second = limiter.allow("user-1", 0);
    RateLimitDecision third = limiter.allow("user-1", 0);

    assertTrue(first.isAllowed());
    assertEquals(1, first.getRemainingTokens());
    assertTrue(second.isAllowed());
    assertEquals(0, second.getRemainingTokens());
    assertFalse(third.isAllowed());
    assertEquals(1000, third.getRetryAfterMillis());
  }

  @Test
  void refillsTokensByElapsedPeriods() {
    TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(3, 1, 1000);

    limiter.allow("user-1", 0);
    limiter.allow("user-1", 0);
    limiter.allow("user-1", 0);

    RateLimitDecision afterOnePeriod = limiter.allow("user-1", 1000);
    RateLimitDecision afterSeveralPeriods = limiter.allow("user-1", 5000);

    assertTrue(afterOnePeriod.isAllowed());
    assertEquals(0, afterOnePeriod.getRemainingTokens());
    assertTrue(afterSeveralPeriods.isAllowed());
    assertEquals(2, afterSeveralPeriods.getRemainingTokens());
  }

  @Test
  void keepsIndependentBucketsPerKey() {
    TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(1, 1, 1000);

    assertTrue(limiter.allow("alpha", 0).isAllowed());
    assertFalse(limiter.allow("alpha", 0).isAllowed());
    assertTrue(limiter.allow("beta", 0).isAllowed());
    assertEquals(2, limiter.trackedKeyCount());
  }

  @Test
  void trimsKeysBeforeTracking() {
    TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(1, 1, 1000);

    assertTrue(limiter.allow(" alpha ", 0).isAllowed());
    assertFalse(limiter.allow("alpha", 0).isAllowed());
    assertEquals(1, limiter.trackedKeyCount());
  }

  @Test
  void rejectsInvalidConfigurationAndKeys() {
    assertThrows(IllegalArgumentException.class, () -> new TokenBucketRateLimiter(0, 1, 1000));
    assertThrows(IllegalArgumentException.class, () -> new TokenBucketRateLimiter(1, 0, 1000));
    assertThrows(IllegalArgumentException.class, () -> new TokenBucketRateLimiter(1, 1, 0));
    assertThrows(IllegalArgumentException.class, () -> new TokenBucketRateLimiter(1, 1, 1000, 0));

    TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(1, 1, 1000);
    assertThrows(NullPointerException.class, () -> limiter.allow(null, 0));
    assertThrows(IllegalArgumentException.class, () -> limiter.allow("   ", 0));
  }

  @Test
  void reportsPartialRetryWindow() {
    TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(1, 1, 1000);

    limiter.allow("user-1", 0);
    RateLimitDecision rejected = limiter.allow("user-1", 250);

    assertFalse(rejected.isAllowed());
    assertEquals(750, rejected.getRetryAfterMillis());
  }

  @Test
  void capsRefillAtCapacityWhenSeveralPeriodsPass() {
    TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(3, 2, 1000);

    limiter.allow("user-1", 0);
    limiter.allow("user-1", 0);
    limiter.allow("user-1", 0);
    RateLimitDecision afterManyPeriods = limiter.allow("user-1", 10_000);

    assertTrue(afterManyPeriods.isAllowed());
    assertEquals(2, afterManyPeriods.getRemainingTokens());
  }

  @Test
  void ignoresNonMonotonicTimestampsForRefill() {
    TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(1, 1, 1000);

    assertTrue(limiter.allow("user-1", 1000).isAllowed());
    RateLimitDecision rejected = limiter.allow("user-1", 500);

    assertFalse(rejected.isAllowed());
    assertEquals(1000, rejected.getRetryAfterMillis());
  }

  @Test
  void evictsLeastRecentlyAccessedBucketWhenKeyLimitIsReached() {
    TokenBucketRateLimiter limiter = new TokenBucketRateLimiter(1, 1, 1000, 2);

    limiter.allow("alpha", 0);
    limiter.allow("beta", 10);
    limiter.allow("gamma", 20);

    assertEquals(2, limiter.trackedKeyCount());
    assertTrue(limiter.allow("alpha", 30).isAllowed());
  }

  @Test
  void decisionFactoriesPreventContradictoryStates() {
    RateLimitDecision allowed = RateLimitDecision.allowed(2);
    RateLimitDecision rejected = RateLimitDecision.rejected(500);

    assertTrue(allowed.isAllowed());
    assertEquals(0, allowed.getRetryAfterMillis());
    assertFalse(rejected.isAllowed());
    assertEquals(0, rejected.getRemainingTokens());
    assertThrows(IllegalArgumentException.class, () -> RateLimitDecision.allowed(-1));
    assertThrows(IllegalArgumentException.class, () -> RateLimitDecision.rejected(-1));
  }
}
