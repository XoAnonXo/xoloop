# Java Rate Limiter

This project dogfoods XOLoop's Java integration with a real Maven/JUnit
library. It implements a bounded in-memory token bucket rate limiter.

## Run

```sh
mvn test
mvn -q -DskipTests compile exec:java -Dexec.mainClass=dev.xoloop.examples.ratelimit.RateLimiterBenchmark
```

## What It Exercises

- Java/Maven project detection (`pom.xml`)
- Java source and test path detection (`src/main/java`, `src/test/java`)
- Native validation (`mvn test`)
- Public Java API scanning
- Javadocs extraction
- Benchmark/improve command routing through Maven `exec:java`
- Audit static preflight for Java state-growth and decision-state issues
