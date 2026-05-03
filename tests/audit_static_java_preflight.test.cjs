'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildJavaStaticAuditFindings,
  runAuditFixLoop,
} = require('../plugins/xoloop/lib/audit_runner.cjs');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('static Java audit catches unbounded maps and contradictory decision constructors', () => {
  const source = `
package demo;
import java.util.HashMap;
import java.util.Map;

public final class Limiter {
  private final Map<String, Bucket> buckets = new HashMap<>();
  public Decision allow(String key) {
    Bucket bucket = buckets.computeIfAbsent(key, ignored -> new Bucket());
    return new Decision(true, 0, 500);
  }
  private static final class Bucket {}
}

public final class Decision {
  public Decision(boolean allowed, int remainingTokens, long retryAfterMillis) {}
}
`;

  const findings = buildJavaStaticAuditFindings(source, 'src/main/java/demo/Limiter.java');

  assert.equal(findings.filter((finding) => finding.severity === 'P2').length, 2);
  assert.ok(findings.some((finding) => /grow without a bound/.test(finding.issue)));
  assert.ok(findings.some((finding) => /contradictory domain states/.test(finding.issue)));
});

test('audit loop fails closed on static Java findings even if model auditor misses them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-static-java-audit-'));
  try {
    write(path.join(root, 'src/main/java/demo/Limiter.java'), `
package demo;
import java.util.HashMap;
import java.util.Map;

public final class Limiter {
  private final Map<String, Bucket> buckets = new HashMap<>();
  public Decision allow(String key) {
    Bucket bucket = buckets.computeIfAbsent(key, ignored -> new Bucket());
    return new Decision(false, 1, 0);
  }
  private static final class Bucket {}
}

final class Decision {
  public Decision(boolean allowed, int remainingTokens, long retryAfterMillis) {}
}
`);

    const result = await runAuditFixLoop({
      target: {
        cwd: root,
        files: ['src/main/java/demo/Limiter.java'],
      },
      callAuditor: async () => ({ findings: [] }),
      callFixer: async () => ({ changeSet: [] }),
      maxRounds: 1,
      severityFloor: 'P2',
    });

    assert.equal(result.converged, false);
    assert.equal(result.reason, 'no-fix-proposed');
    assert.ok(result.finalAudit.staticFindings.length >= 1);
    assert.ok(result.finalAudit.findings.some((finding) => finding.source === 'static-java-audit'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('static Java audit ignores misleading comments when checking for eviction', () => {
  const source = `
package demo;
import java.util.HashMap;
import java.util.Map;

public final class Limiter {
  // TODO: add maxTrackedKeys and evict old buckets later.
  private final Map<String, Bucket> buckets = new HashMap<>();
  public void allow(String key) {
    buckets.computeIfAbsent(key, ignored -> new Bucket());
  }
  private static final class Bucket {}
}
`;

  const findings = buildJavaStaticAuditFindings(source, 'src/main/java/demo/Limiter.java');

  assert.ok(findings.some((finding) => /grow without a bound/.test(finding.issue)));
});
