#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_ROOT="$(cd "$ROOT/../.." && pwd)"
cd "$ROOT"

export JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk}"
export PATH="$JAVA_HOME/bin:$PATH"

echo "== java-toolchain =="
java -version 2>&1 | head -1
mvn -version | head -1

echo "== init =="
node "$PLUGIN_ROOT/plugins/xoloop/bin/xoloop-init.cjs" --dir "$ROOT" --force
grep -Fq "src/main/java/**" overnight.yaml
grep -Fq "src/test/java/**" overnight.yaml
grep -Fq "mvn test" overnight.yaml

echo "== native-tests =="
mvn -q test

echo "== simplify-measure =="
node "$PLUGIN_ROOT/plugins/xoloop/bin/xoloop-simplify.cjs" measure \
  --files "src/main/java/dev/xoloop/examples/ratelimit/TokenBucketRateLimiter.java,src/main/java/dev/xoloop/examples/ratelimit/RateLimitDecision.java" \
  > target/xoloop-simplify.json
node - <<'NODE'
const { scanExports } = require('../../plugins/xoloop/lib/xo_simplify_engine.cjs');
const exports = scanExports('src/main/java/dev/xoloop/examples/ratelimit/TokenBucketRateLimiter.java').exports;
for (const name of ['TokenBucketRateLimiter', 'allow', 'trackedKeyCount']) {
  if (!exports.has(name)) throw new Error(`missing Java export: ${name}`);
}
console.log(JSON.stringify({ exports: [...exports].sort() }));
NODE

echo "== docs-scan =="
node "$PLUGIN_ROOT/plugins/xoloop/bin/xoloop-docs.cjs" scan --scope "$ROOT" > target/xoloop-docs.json
grep -q '"undocumentedCount": 0' target/xoloop-docs.json
grep -q "Decide whether a key can perform one action" target/xoloop-docs.json

echo "== benchmark =="
node "$PLUGIN_ROOT/plugins/xoloop/bin/xoloop-benchmark.cjs" run --benchmark benchmarks/rate-limiter-benchmark.yaml

echo "== improve-routing =="
node -e 'const path=require("node:path"); const {extractTargetPaths}=require("../../plugins/xoloop/lib/improve_runner.cjs"); const benchmark={cases:[{entry_point:{command:"mvn -q -DskipTests compile exec:java -Dexec.mainClass=dev.xoloop.examples.ratelimit.RateLimiterBenchmark"}}]}; const targets=extractTargetPaths(benchmark,process.cwd()).map((file)=>path.relative(process.cwd(),file)); if(!targets.includes("src/main/java/dev/xoloop/examples/ratelimit/RateLimiterBenchmark.java")) throw new Error(`missing Java benchmark target: ${JSON.stringify(targets)}`); console.log(JSON.stringify({targets}));'

echo "== audit-static-preflight =="
node -e 'const fs=require("node:fs"); const {buildJavaStaticAuditFindings}=require("../../plugins/xoloop/lib/audit_runner.cjs"); const files=["src/main/java/dev/xoloop/examples/ratelimit/TokenBucketRateLimiter.java","src/main/java/dev/xoloop/examples/ratelimit/RateLimitDecision.java"]; const findings=files.flatMap((file)=>buildJavaStaticAuditFindings(fs.readFileSync(file,"utf8"),file)); if(findings.length!==0) throw new Error(`static audit findings remain: ${JSON.stringify(findings,null,2)}`); console.log(JSON.stringify({staticFindings:0}));'

echo "== live-agentic-provider =="
node --test "$PLUGIN_ROOT/tests/live_agentic_pipeline.test.cjs"

echo "== finalize-dry-run =="
node "$PLUGIN_ROOT/plugins/xoloop/bin/xoloop-finalize.cjs" \
  --dry-run \
  --ledger "$ROOT/.xoloop/session.jsonl" \
  --repo-root "$ROOT" > target/xoloop-finalize.json
grep -q '"keptEntries": 3' target/xoloop-finalize.json

echo "ALL_REAL_JAVA_CHECKS_PASS"
