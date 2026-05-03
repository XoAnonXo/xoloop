'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { runBuildPipeline } = require('../plugins/xoloop/lib/build_pipeline.cjs');
const { loadModelProposal } = require('../plugins/xoloop/lib/autoresearch_loop.cjs');
const { runAuditFixLoop } = require('../plugins/xoloop/lib/audit_runner.cjs');
const { makeProposalLoader, createLiveAgentProvider, readLiveAgentEvidence } = require('../plugins/xoloop/lib/live_agent_provider.cjs');
const { summarizeCompleteness } = require('../plugins/xoloop/lib/completeness_checker.cjs');
const { SUPPORTED_LANGUAGES, LIVE_AGENTIC_MODES } = require('../plugins/xoloop/lib/language_parity.cjs');

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function javaAdapterYaml() {
  return [
    'repo:',
    '  name: live-agentic-java',
    '  baseline_validation:',
    '    - mvn -q test',
    '  final_validation:',
    '    - mvn -q test',
    'surfaces:',
    '  - id: java',
    '    title: Java',
    '    description: Java surface',
    '    paths:',
    '      - src/main/java/**',
    '    test_paths:',
    '      - src/test/java/**',
    '    invariants:',
    '      - keep tests green',
    '    risk: guarded',
    '    required_test_kinds:',
    '      - regression',
    '    quick_validation:',
    '      - mvn -q test',
    '    full_validation:',
    '      - mvn -q test',
    'manual_only_paths: []',
    'shared_paths: []',
    'defaults:',
    '  report_dir: reports/overnight',
    '  branch_prefix: codex/overnight',
    '  attempt_limit: 1',
    '  repair_turns: 0',
    '  proposal_mode: legacy',
    '  proposer:',
    '    provider: external-command',
    '    model: live-agent-test',
    '  audit:',
    '    provider: auto',
    '',
  ].join('\n');
}

function javaFeatureYaml() {
  return [
    'feature: Java greeting helper',
    'version: 1',
    'acceptance:',
    '  - Greeting.message returns hello text',
    'new_surface:',
    '  id: greeting',
    '  title: Greeting',
    '  paths:',
    '    - src/main/java/dev/xoloop/live/Greeting.java',
    '  test_paths:',
    '    - src/test/java/dev/xoloop/live/GreetingTest.java',
    '  invariants:',
    '    - use JUnit tests',
    '  risk: guarded',
    '  required_test_kinds:',
    '    - regression',
    'integration_seams: []',
    'dependencies: []',
    'constraints: []',
    '',
  ].join('\n');
}

function pomXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>dev.xoloop</groupId>
  <artifactId>live-agentic-java</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-surefire-plugin</artifactId>
        <version>3.2.5</version>
      </plugin>
    </plugins>
  </build>
</project>
`;
}

function testSource() {
  return `package dev.xoloop.live;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

final class GreetingTest {
  @Test
  void returnsMessage() {
    assertEquals("hello from live agent", Greeting.message());
  }
}
`;
}

function codeSource() {
  return `package dev.xoloop.live;

public final class Greeting {
  private Greeting() {
  }

  public static String message() {
    return "hello from live agent";
  }
}
`;
}

test('Java live-agentic provider wiring invokes build/audit runners and shared mode loaders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-live-java-'));
  const evidencePath = path.join(root, '.xoloop', 'live-agentic.jsonl');
  writeFile(root, 'overnight.yaml', javaAdapterYaml());
  writeFile(root, 'feature.greeting.yaml', javaFeatureYaml());
  writeFile(root, 'src/main/java/dev/xoloop/live/BadDecision.java', 'package dev.xoloop.live; public class BadDecision { public final boolean allowed; public final long retryAfterMillis; public BadDecision(boolean allowed, long retryAfterMillis) { this.allowed = allowed; this.retryAfterMillis = retryAfterMillis; } }');

  const provider = createLiveAgentProvider({
    provider: 'subagent-test-provider',
    evidencePath,
    handler: async (payload) => {
      if (payload.mode === 'build' && payload.role === 'spec-writer') {
        return {
          text: JSON.stringify({
            operations: [
              { op: 'create_file', path: 'pom.xml', content: pomXml() },
              { op: 'create_file', path: 'src/test/java/dev/xoloop/live/GreetingTest.java', content: testSource() },
            ],
          }),
        };
      }
      if (payload.mode === 'build' && payload.role === 'implementation-builder') {
        return {
          text: JSON.stringify({
            operations: [
              { op: 'create_file', path: 'src/main/java/dev/xoloop/live/Greeting.java', content: codeSource() },
            ],
          }),
        };
      }
      if (payload.mode === 'audit' && payload.role === 'auditor') {
        return { text: JSON.stringify({ findings: [] }) };
      }
      if (payload.mode === 'audit' && payload.role === 'fixer') {
        return {
          text: JSON.stringify({
            changeSet: [
              { kind: 'replace_once', path: 'src/main/java/dev/xoloop/live/BadDecision.java', match: 'public BadDecision(boolean allowed, long retryAfterMillis)', replace: 'private BadDecision(boolean allowed, long retryAfterMillis)' },
            ],
          }),
        };
      }
      return {
        text: JSON.stringify({
          hypothesisId: 'live-agent-java',
          summary: `${payload.mode}/${payload.role}`,
          why: 'records live-agentic provider invocation',
          targetFiles: ['src/main/java/dev/xoloop/live/Greeting.java'],
          expectedImpact: { speed: '', simplicity: 'same', resilience: 'same' },
          validationNotes: ['provider called'],
          changeSet: [],
        }),
      };
    },
  });

  const build = await runBuildPipeline({
    repoRoot: root,
    adapterPath: path.join(root, 'overnight.yaml'),
    featurePath: 'feature.greeting.yaml',
    outputDir: path.join(root, 'reports', 'features'),
    liveAgentProvider: provider,
    maxRepairTurns: 0,
  });
  assert.equal(build.status, 'awaiting_approval', build.error || JSON.stringify(build));
  assert.equal(build.delta.ok, true);

  const autoresearch = await provider.call({
    mode: 'autoresearch',
    role: 'proposer',
    language: 'java',
    prompt: { systemPrompt: 'Return JSON only.', userPrompt: 'Propose a Java improvement.' },
  });
  assert.equal(autoresearch.liveAgentic, true);

  const audit = await runAuditFixLoop({
    target: { cwd: root, files: ['src/main/java/dev/xoloop/live/BadDecision.java'], language: 'java' },
    liveAgentProvider: provider,
    maxRounds: 1,
  });
  assert.equal(audit.reason, 'proposal-only-mode');

  await makeProposalLoader(provider, 'polish')({
    requestKind: 'proposal',
    language: 'java',
    prompt: { systemPrompt: 'Return JSON only.', userPrompt: 'Polish Java.' },
  });
  await makeProposalLoader(provider, 'overnight')({
    requestKind: 'proposal',
    language: 'java',
    prompt: { systemPrompt: 'Return JSON only.', userPrompt: 'Run overnight Java proposal.' },
  });

  const evidence = readLiveAgentEvidence(evidencePath);
  const modes = new Set(evidence.map((entry) => `${entry.language}/${entry.mode}`));
  assert.deepEqual(
    ['java/build', 'java/autoresearch', 'java/audit', 'java/polish', 'java/overnight'].every((mode) => modes.has(mode)),
    true,
  );

  const completeness = summarizeCompleteness({ liveAgenticEvidence: evidence });
  assert.equal(completeness.byLanguage.java.liveAgenticFull, 0);
  assert.equal(completeness.byLanguage.java.liveAgenticComplete, false);
  assert.equal(completeness.liveAgenticComplete, false);

  const testCompleteness = summarizeCompleteness({ liveAgenticEvidence: evidence, allowTestEvidence: true });
  assert.equal(testCompleteness.byLanguage.java.liveAgenticFull, 5);
  assert.equal(testCompleteness.byLanguage.java.liveAgenticComplete, true);
  assert.equal(testCompleteness.liveAgenticComplete, false);
});

test('production live-agentic evidence is distinct from deterministic test-provider evidence', () => {
  const evidence = [
    { ok: true, evidenceKind: 'production-live', language: 'java', mode: 'build' },
    { ok: true, evidenceKind: 'test-provider', language: 'java', mode: 'audit' },
  ];
  const summary = summarizeCompleteness({ liveAgenticEvidence: evidence });

  assert.equal(summary.byLanguage.java.liveAgenticFull, 1);
  assert.match(
    summary.liveAgenticIncomplete.map((entry) => `${entry.language}/${entry.mode}`).join('\n'),
    /java\/audit/,
  );
});

test('live-agentic provider evidence covers every supported language and live mode', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-live-all-'));
  const evidencePath = path.join(root, '.xoloop', 'live-agentic.jsonl');
  const provider = createLiveAgentProvider({
    provider: 'subagent-test-provider',
    evidencePath,
    handler: async (payload) => ({
      text: JSON.stringify({
        hypothesisId: `${payload.language}-${payload.mode}`,
        summary: `${payload.language}/${payload.mode}/${payload.role}`,
        why: 'records all-language live-agentic provider coverage',
        targetFiles: [],
        expectedImpact: { speed: '', simplicity: '', resilience: '' },
        validationNotes: ['provider called'],
        changeSet: [],
      }),
    }),
  });

  for (const language of SUPPORTED_LANGUAGES) {
    for (const mode of LIVE_AGENTIC_MODES) {
      if (mode === 'polish' || mode === 'overnight') {
        await makeProposalLoader(provider, mode)({
          requestKind: 'proposal',
          surface: { languageHints: [language] },
          prompt: {
            systemPrompt: 'Return JSON only.',
            userPrompt: `Exercise ${language}/${mode}.`,
          },
        });
      } else if (mode === 'autoresearch') {
        await loadModelProposal({
          cwd: root,
          language,
          liveAgentProvider: provider,
          prompt: {
            systemPrompt: 'Return JSON only.',
            userPrompt: `Exercise ${language}/${mode}.`,
          },
        });
      } else if (mode === 'audit') {
        await runAuditFixLoop({
          target: { cwd: root, files: [], language },
          liveAgentProvider: provider,
          enableStaticAudit: false,
          maxRounds: 1,
        });
      } else {
        await provider.call({
          mode,
          role: mode === 'audit' ? 'auditor' : 'proposer',
          language,
          prompt: {
            systemPrompt: 'Return JSON only.',
            userPrompt: `Exercise ${language}/${mode}.`,
          },
        });
      }
    }
  }

  const evidence = readLiveAgentEvidence(evidencePath);
  const covered = new Set(evidence.map((entry) => `${entry.language}/${entry.mode}`));
  for (const language of SUPPORTED_LANGUAGES) {
    for (const mode of LIVE_AGENTIC_MODES) {
      assert.equal(covered.has(`${language}/${mode}`), true, `${language}/${mode} missing provider evidence`);
    }
  }

  const testCompleteness = summarizeCompleteness({ liveAgenticEvidence: evidence, allowTestEvidence: true });
  assert.equal(testCompleteness.liveAgenticComplete, true);
  assert.equal(testCompleteness.liveAgenticScore.fullCells, SUPPORTED_LANGUAGES.length * LIVE_AGENTIC_MODES.length);

  const productionCompleteness = summarizeCompleteness({ liveAgenticEvidence: evidence });
  assert.equal(productionCompleteness.liveAgenticComplete, false);
  assert.equal(productionCompleteness.liveAgenticScore.fullCells, 0);
});

test('production-live evidence can satisfy every supported language and live mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-prod-live-'));
  const evidencePath = path.join(root, 'live-agentic.jsonl');
  const evidence = [];
  for (const language of SUPPORTED_LANGUAGES) {
    for (const mode of LIVE_AGENTIC_MODES) {
      const entry = {
        ok: true,
        evidenceKind: 'production-live',
        language,
        mode,
      };
      evidence.push(entry);
      fs.appendFileSync(evidencePath, `${JSON.stringify(entry)}\n`);
    }
  }

  const summary = summarizeCompleteness({ liveAgenticEvidence: evidence });

  assert.equal(summary.liveAgenticComplete, true);
  assert.equal(summary.liveAgenticScore.fullCells, SUPPORTED_LANGUAGES.length * LIVE_AGENTIC_MODES.length);
  assert.equal(summary.liveAgenticIncomplete.length, 0);

  const cli = spawnSync(process.execPath, [
    'plugins/xoloop/bin/xoloop-completeness.cjs',
    '--require-live-agentic',
    '--live-agentic-evidence',
    evidencePath,
  ], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /Live-agentic complete: yes/);

  const testOnlyPath = path.join(root, 'test-only-live-agentic.jsonl');
  fs.writeFileSync(testOnlyPath, evidence.map((entry) => JSON.stringify({
    ...entry,
    evidenceKind: 'test-provider',
  })).join('\n') + '\n');
  const rejected = spawnSync(process.execPath, [
    'plugins/xoloop/bin/xoloop-completeness.cjs',
    '--require-live-agentic',
    '--live-agentic-evidence',
    testOnlyPath,
  ], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.match(rejected.stdout, /Live-agentic complete: no/);
});

test('language-less production-live evidence cannot satisfy per-language live gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-langless-live-'));
  const evidencePath = path.join(root, 'live-agentic.jsonl');
  for (const mode of LIVE_AGENTIC_MODES) {
    fs.appendFileSync(evidencePath, `${JSON.stringify({
      ok: true,
      evidenceKind: 'production-live',
      mode,
    })}\n`);
  }

  const cli = spawnSync(process.execPath, [
    'plugins/xoloop/bin/xoloop-completeness.cjs',
    '--require-live-agentic',
    '--live-agentic-evidence',
    evidencePath,
  ], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });

  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /Live-agentic score: 0\/60/);
});
