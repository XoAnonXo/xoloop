'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { buildSpecPrompt } = require('../plugins/xoloop/lib/build_pipeline.cjs');
const { buildStarterAdapter } = require('../plugins/xoloop/lib/overnight_adapter.cjs');
const { buildPolishSummary } = require('../plugins/xoloop/lib/polish_runner.cjs');
const { buildNativeFuzzHarness } = require('../plugins/xoloop/lib/fuzz_engine.cjs');
const { runBenchmarkSuite } = require('../plugins/xoloop/lib/benchmark_runner.cjs');
const { extractTargetPaths, buildOptimizationPrompt } = require('../plugins/xoloop/lib/improve_runner.cjs');
const { buildRubricPromptInstructions } = require('../plugins/xoloop/lib/autoresearch_rubric.cjs');
const { runAuditFixLoop } = require('../plugins/xoloop/lib/audit_runner.cjs');
const { extractPublicSymbols } = require('../plugins/xoloop/lib/xo_docs_engine.cjs');
const { scanExports, validateSimplifyProposal } = require('../plugins/xoloop/lib/xo_simplify_engine.cjs');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeSampleProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-all-modes-'));
  write(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2));
  write(path.join(root, 'src/calc.cjs'), "'use strict';\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n");
  write(path.join(root, 'src/calc.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');
  write(path.join(root, 'tool.py'), 'def add(a):\n    """Return input unchanged."""\n    return a\n');
  write(path.join(root, 'src/lib.rs'), 'pub fn add(value: &str) -> &str { value }\n');
  write(path.join(root, 'go.mod'), 'module example.com/xoloop_sample\n\ngo 1.20\n');
  write(path.join(root, 'main.go'), 'package main\n\nfunc Add(value string) string { return value }\n');
  write(path.join(root, 'Gemfile'), 'source "https://rubygems.org"\n');
  write(path.join(root, 'lib/tool.rb'), "# Return input unchanged.\ndef add(value)\n  value\nend\n");
  fs.mkdirSync(path.join(root, '.xoloop'), { recursive: true });
  write(path.join(root, '.xoloop/session.jsonl'), [
    JSON.stringify({ round: 1, mode: 'polish', outcome: 'keep', filesTouched: ['tool.py'], proposalSummary: 'tighten python helper' }),
    JSON.stringify({ round: 2, mode: 'fuzz', outcome: 'keep', filesTouched: ['main.go'], proposalSummary: 'add go fuzz coverage' }),
    '',
  ].join('\n'));
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8' });
  return root;
}

test('sample polyglot project exercises local adapters for all 11 XOLoop modes', async () => {
  const root = makeSampleProject();
  try {
    const evidence = {};

    // init
    const adapter = buildStarterAdapter(root);
    evidence.init = adapter.surfaces[0].language_hints;
    assert.ok(evidence.init.includes('python'));
    assert.ok(evidence.init.includes('ruby'));

    // build
    const feature = {
      feature: 'sample build',
      version: '1.0.0',
      acceptance: ['adds a native Python helper'],
      newSurface: {
        id: 'sample-build',
        title: 'Sample Build',
        paths: ['feature.py'],
        testPaths: ['tests/test_feature.py'],
        invariants: ['native pytest shape'],
      },
    };
    evidence.build = buildSpecPrompt(feature, adapter, null);
    assert.match(evidence.build, /Use pytest/);

    // simplify
    evidence.simplify = validateSimplifyProposal({ changeSet: [] }, root);
    assert.equal(evidence.simplify.ok, true);
    assert.ok(scanExports(path.join(root, 'src/lib.rs')).exports.has('add'));

    // polish
    evidence.polish = buildPolishSummary([{ landed: 1, failed: 0, testsAdded: 1, saturated: false }]);
    assert.equal(evidence.polish.landed, 1);

    // fuzz
    evidence.fuzz = [
      buildNativeFuzzHarness('src/calc.ts', { language: 'typescript', targetName: 'calc' }),
      buildNativeFuzzHarness('tool.py', { language: 'python', targetName: 'tool' }),
      buildNativeFuzzHarness('src/lib.rs', { language: 'rust', targetName: 'lib' }),
      buildNativeFuzzHarness('main.go', { language: 'go', targetName: 'main' }),
      buildNativeFuzzHarness('lib/tool.rb', { language: 'ruby', targetName: 'tool' }),
    ];
    assert.equal(evidence.fuzz.every(Boolean), true);

    // benchmark
    const benchmark = {
      benchmark: 'sample benchmark',
      cases: [{
        id: 'node-add',
        input: {},
        expected_output: { exact: 3 },
        entry_point: { command: "node -e \"const { add } = require('./src/calc.cjs'); console.log(JSON.stringify(add(1,2)))\"" },
        bounds: { wallTimeMs: 5000 },
      }],
    };
    evidence.benchmark = runBenchmarkSuite(benchmark, { cwd: root });
    assert.equal(Object.values(evidence.benchmark)[0].outputMatch.verdict, 'pass');

    // improve
    const improveBenchmark = { cases: [{ entry_point: { command: 'python3 tool.py' } }] };
    evidence.improve = extractTargetPaths(improveBenchmark, root);
    assert.equal(evidence.improve.length, 1);
    assert.match(buildOptimizationPrompt({
      sourceFiles: [{ path: 'tool.py', content: fs.readFileSync(path.join(root, 'tool.py'), 'utf8') }],
      hotspots: [],
      benchmark: improveBenchmark,
      round: 1,
      priorAttempts: [],
    }).userPrompt, /```python/);

    // autoresearch prompt/interface only; live subagent proof is tracked separately
    evidence.autoresearch = buildRubricPromptInstructions();
    assert.match(evidence.autoresearch, /AutoReason/);

    // audit loop wiring only; live subagent proof is tracked separately
    evidence.audit = await runAuditFixLoop({
      target: { cwd: root, files: ['tool.py'] },
      callAuditor: async () => ({ findings: [] }),
      callFixer: async () => ({ changeSet: [] }),
    });
    assert.equal(evidence.audit.converged, true);

    // docs
    evidence.docs = extractPublicSymbols(path.join(root, 'tool.py'));
    assert.equal(evidence.docs.symbols[0].existingDoc, 'Return input unchanged.');

    // overnight
    evidence.overnight = adapter.repo.final_validation;
    assert.ok(Array.isArray(evidence.overnight));
    assert.ok(evidence.overnight.length > 0);

    // finalize
    const finalize = spawnSync(process.execPath, [
      path.join(process.cwd(), 'plugins/xoloop/bin/xoloop-finalize.cjs'),
      '--dry-run',
      '--ledger',
      path.join(root, '.xoloop/session.jsonl'),
      '--repo-root',
      root,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(finalize.status, 0, finalize.stderr);
    evidence.finalize = JSON.parse(finalize.stdout);
    assert.equal(evidence.finalize.keptEntries, 2);
    assert.equal(evidence.finalize.groupCount, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
