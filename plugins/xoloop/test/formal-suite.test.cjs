'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createGoal,
  runGoalVerify,
  scanFormalRepo,
} = require('../lib/goal_verify_runner.cjs');
const { writeGoalManifest } = require('../lib/goal_manifest.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-formal-suite-'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeScript(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, 'utf8');
}

function writeFormalGoal(cwd, options = {}) {
  const goalId = options.goalId || 'formal';
  const goalDir = path.join(cwd, '.xoloop', 'goals', goalId);
  for (const item of options.cases || []) {
    writeJson(path.join(goalDir, 'cases', `${item.id}.json`), item);
  }
  const goalPath = path.join(goalDir, 'goal.yaml');
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: goalId,
    objective: 'Verify formal/static analyzer evidence.',
    interface: {
      type: 'formal',
      command: 'formal/static verification harness',
      stdin: 'none',
      stdout: 'text',
      timeout_ms: 120000,
    },
    artifacts: {
      paths: options.artifacts || [],
    },
    verify: {
      kind: 'formal-suite',
      cases: 'cases/*.json',
      properties: options.properties || [
        'case_present',
        'tool_coverage',
        'analyzer_success',
        'counterexample_capture',
        'type_check',
        'lint',
        'property_fuzz',
        'security_analysis',
      ],
      required_categories: options.requiredCategories || ['type_check', 'lint', 'property_fuzz', 'security_analysis'],
      block_on_gaps: true,
    },
    metrics: {
      repeat: 1,
      targets: [
        { name: 'wall_time_ms', direction: 'minimize', threshold: 0.05 },
      ],
    },
  });
  return goalPath;
}

test('formal scan detects type checkers, linters, model/proof files, fuzz, symbolic, and security tools', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), {
    scripts: {
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
      fuzz: 'node property.test.cjs',
      security: 'semgrep --config auto .',
    },
    devDependencies: {
      typescript: '^5.0.0',
      eslint: '^9.0.0',
      'fast-check': '^4.0.0',
    },
  });
  fs.writeFileSync(path.join(cwd, 'tsconfig.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(cwd, '.semgrep.yml'), 'rules: []\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'Spec.tla'), '---- MODULE Spec ----\n====\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'Proof.lean'), 'theorem t : True := True.intro\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'symbolic.c'), 'void f(){ __CPROVER_assert(1, "ok"); }\n', 'utf8');

  const scan = scanFormalRepo(cwd);

  assert.ok(scan.checks.some((check) => check.category === 'type_check'));
  assert.ok(scan.checks.some((check) => check.category === 'lint'));
  assert.ok(scan.checks.some((check) => check.category === 'security_analysis'));
  assert.ok(scan.categories.includes('model_check'));
  assert.ok(scan.categories.includes('theorem_proof'));
  assert.ok(scan.categories.includes('symbolic_execution'));
  assert.ok(scan.categories.includes('property_fuzz'));
  assert.ok(scan.language_presets.some((preset) => preset.language === 'typescript'));
  assert.ok(scan.tool_install_guidance.some((item) => item.tool === 'semgrep'));
  assert.ok(scan.formal_files.includes('Spec.tla'));
  assert.ok(scan.formal_files.includes('Proof.lean'));
});

test('formal scan exposes language presets for TS, Python, Rust, Go, Java, and C/C++', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), { devDependencies: { typescript: '^5.0.0' } });
  fs.writeFileSync(path.join(cwd, 'tsconfig.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'pyproject.toml'), '[tool.pytest.ini_options]\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.0.0"\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'go.mod'), 'module demo\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'pom.xml'), '<project></project>\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.20)\n', 'utf8');

  const scan = scanFormalRepo(cwd);
  const languages = scan.language_presets.map((preset) => preset.language).sort();

  assert.deepEqual(languages, ['c_cpp', 'go', 'java', 'python', 'rust', 'typescript']);
  assert.ok(scan.supported_language_presets.typescript.commands.some((command) => command.category === 'property_fuzz'));
});

test('formal-suite create writes cases, reports, proof, model, corpus, and security assets', () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'package.json'), {
    scripts: {
      typecheck: 'node typecheck.cjs',
      lint: 'eslint .',
    },
  });

  const created = createGoal({ cwd, kind: 'formal-suite', goalId: 'formal-suite', force: true });

  assert.equal(created.goal.verify.kind, 'formal-suite');
  assert.equal(created.goal.interface.type, 'formal');
  for (const dir of ['cases', 'actual', 'diffs', 'traces', 'reports', 'proofs', 'models', 'corpus', 'security', 'normalized', 'coverage', 'templates', 'presets', 'adapters', 'install', 'ci', 'replay', 'live-fixtures']) {
    assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'formal-suite', dir)), true);
  }
  assert.ok(fs.readdirSync(path.join(cwd, '.xoloop', 'goals', 'formal-suite', 'cases')).length >= 2);
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'formal-suite', 'templates', 'typescript-fast-check.cjs')));
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'formal-suite', 'presets', 'typescript.json')));
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'formal-suite', 'adapters', 'formal-tool-adapters.json')));
  assert.ok(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'formal-suite', 'install', 'tool-install-guidance.json')));
});

test('formal-suite reaches PASS_EVIDENCED for passing type, lint, property, and security analyzers', async () => {
  const cwd = tmpDir();
  for (const name of ['typecheck', 'lint', 'property', 'security']) {
    writeScript(path.join(cwd, `${name}.cjs`), 'console.log("ok");\n');
  }
  const goalPath = writeFormalGoal(cwd, {
    cases: [
      { id: 'typecheck', category: 'type_check', tool: 'tsc', command: 'node typecheck.cjs', expected_exit_code: 0 },
      { id: 'lint', category: 'lint', tool: 'eslint', command: 'node lint.cjs', expected_exit_code: 0 },
      { id: 'property', category: 'property_fuzz', tool: 'fast-check', command: 'node property.cjs', expected_exit_code: 0 },
      { id: 'security', category: 'security_analysis', tool: 'semgrep', command: 'node security.cjs', expected_exit_code: 0, forbid_stdout_patterns: ['CRITICAL', 'HIGH'] },
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.equal(card.summary.failed, 0);
  assert.deepEqual(card.missing_obligations, []);
  assert.equal(card.summary.by_id.type_check.passed, 1);
  assert.equal(card.summary.by_id.security_analysis.passed, 1);
});

test('formal-suite fails with replayable counterexample when a type checker fails', async () => {
  const cwd = tmpDir();
  writeScript(path.join(cwd, 'typecheck.cjs'), 'console.error("Type error"); process.exit(2);\n');
  const goalPath = writeFormalGoal(cwd, {
    properties: ['case_present', 'tool_coverage', 'analyzer_success', 'counterexample_capture', 'type_check'],
    requiredCategories: ['type_check'],
    cases: [
      { id: 'typecheck', category: 'type_check', tool: 'tsc', command: 'node typecheck.cjs', expected_exit_code: 0 },
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'type_check');
  assert.equal(fs.existsSync(card.counterexample.diff_path), true);
  assert.match(card.replay, /--case typecheck/);
});

test('formal-suite treats security findings on stdout as analyzer counterexamples', async () => {
  const cwd = tmpDir();
  writeScript(path.join(cwd, 'security.cjs'), 'console.log("CRITICAL vulnerability CVE-TEST");\n');
  const goalPath = writeFormalGoal(cwd, {
    properties: ['case_present', 'tool_coverage', 'analyzer_success', 'counterexample_capture', 'security_analysis'],
    requiredCategories: ['security_analysis'],
    cases: [
      {
        id: 'security',
        category: 'security_analysis',
        tool: 'semgrep',
        command: 'node security.cjs',
        expected_exit_code: 0,
        forbid_stdout_patterns: ['CRITICAL', 'CVE-'],
      },
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'severity_gate');
  assert.equal(card.summary.by_id.security_analysis.failed, 1);
  assert.ok(card.counterexample.findings > 0);
});

test('formal-suite normalizes SARIF reports and enforces severity gates', async () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'semgrep.sarif'), {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'semgrep', rules: [{ id: 'no-secret', defaultConfiguration: { level: 'error' } }] } },
      results: [{
        ruleId: 'no-secret',
        level: 'error',
        message: { text: 'hard-coded secret' },
        locations: [{ physicalLocation: { artifactLocation: { uri: 'src/app.ts' }, region: { startLine: 7, startColumn: 3 } } }],
      }],
    }],
  });
  const goalPath = writeFormalGoal(cwd, {
    properties: ['case_present', 'tool_coverage', 'analyzer_success', 'normalized_reports', 'severity_gate', 'counterexample_capture', 'security_analysis'],
    requiredCategories: ['security_analysis'],
    cases: [
      {
        id: 'sarif',
        category: 'security_analysis',
        tool: 'semgrep',
        command: 'node -e "process.exit(0)"',
        expected_exit_code: 0,
        report_files: ['semgrep.sarif'],
        severity_threshold: 'high',
      },
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.counterexample.obligation, 'severity_gate');
  const normalized = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'formal', 'normalized', 'sarif.json'), 'utf8'));
  assert.equal(normalized.findings[0].id, 'no-secret');
  assert.equal(normalized.findings[0].file, 'src/app.ts');
});

test('formal-suite parses JUnit, generic JSON, and plain analyzer output', async () => {
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, 'lint-junit.xml'), '<testsuite><testcase classname="lint" name="clean"></testcase></testsuite>\n', 'utf8');
  writeJson(path.join(cwd, 'security.json'), {
    findings: [
      { id: 'low-risk', severity: 'low', message: 'low severity advisory', file: 'src/app.ts', line: 3 },
    ],
  });
  writeScript(path.join(cwd, 'plain.cjs'), 'console.log("fuzz.js:4: warning generated sample was accepted");\n');
  const goalPath = writeFormalGoal(cwd, {
    properties: ['case_present', 'tool_coverage', 'analyzer_success', 'normalized_reports', 'severity_gate', 'counterexample_extraction', 'counterexample_capture', 'lint', 'security_analysis', 'property_fuzz'],
    requiredCategories: ['lint', 'security_analysis', 'property_fuzz'],
    cases: [
      {
        id: 'junit',
        category: 'lint',
        tool: 'eslint',
        command: 'node -e "process.exit(0)"',
        report_files: ['lint-junit.xml'],
        report_format: 'junit',
      },
      {
        id: 'json',
        category: 'security_analysis',
        tool: 'semgrep',
        command: 'node -e "process.exit(0)"',
        report_files: ['security.json'],
        report_format: 'json',
        severity_threshold: 'high',
      },
      {
        id: 'plain',
        category: 'property_fuzz',
        tool: 'fast-check',
        command: 'node plain.cjs',
        report_format: 'plain',
      },
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  const normalizedJson = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'formal', 'normalized', 'json.json'), 'utf8'));
  assert.equal(normalizedJson.findings[0].id, 'low-risk');
  const normalizedPlain = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'formal', 'normalized', 'plain.json'), 'utf8'));
  assert.equal(normalizedPlain.findings[0].file, 'fuzz.js');
});

test('formal-suite uses tool-specific parsers and publishes replay plus CI reports', async () => {
  const cwd = tmpDir();
  writeJson(path.join(cwd, 'semgrep.json'), {
    results: [{
      check_id: 'rules.secret',
      path: 'src/app.ts',
      start: { line: 2, col: 5 },
      end: { line: 2, col: 12 },
      extra: { severity: 'WARNING', message: 'possible secret', metadata: { function: 'loadSecret' } },
    }],
  });
  fs.writeFileSync(path.join(cwd, 'cargo.jsonl'), `${JSON.stringify({
    reason: 'compiler-message',
    message: {
      level: 'error',
      message: 'mismatched types',
      code: { code: 'E0308' },
      spans: [{ is_primary: true, file_name: 'src/lib.rs', line_start: 12, column_start: 7, line_end: 12, column_end: 11, label: 'build_value' }],
    },
  })}\n`, 'utf8');
  writeJson(path.join(cwd, 'gosec.json'), {
    Issues: [{ rule_id: 'G101', severity: 'HIGH', details: 'hardcoded credential', file: 'main.go', line: '10', column: '3', function: 'main' }],
  });
  writeJson(path.join(cwd, 'cbmc.json'), {
    result: [{ property: 'overflow.assertion.1', status: 'FAILURE', sourceLocation: { file: 'overflow.c', line: 8, function: 'add' }, trace: [{ stepType: 'assignment', lhs: 'x', value: '2147483648' }] }],
  });
  writeScript(path.join(cwd, 'pyright.cjs'), 'console.log(JSON.stringify({ generalDiagnostics: [{ file: "src/app.py", severity: "error", message: "Type mismatch", rule: "reportGeneralTypeIssues", range: { start: { line: 3, character: 2 }, end: { line: 3, character: 8 } } }] }));\n');
  writeScript(path.join(cwd, 'klee.cjs'), 'console.log("KLEE: ERROR: src/math.c:8: ASSERTION FAIL: x > 0");\n');
  writeScript(path.join(cwd, 'tlc.cjs'), 'console.log("Error: Invariant TypeOK is violated.\\nState 1: <Initial predicate>\\n/\\\\ x = 1");\n');
  writeScript(path.join(cwd, 'coq.cjs'), 'console.error("File \\"./Proof.v\\", line 3, characters 5-9:\\nError: The reference nope was not found.");\n');
  writeScript(path.join(cwd, 'lean.cjs'), 'console.error("Proof.lean:4:2: error: failed to synthesize instance");\n');
  const goalPath = writeFormalGoal(cwd, {
    properties: [
      'case_present',
      'tool_coverage',
      'analyzer_success',
      'normalized_reports',
      'tool_specific_parser',
      'counterexample_extraction',
      'counterexample_replay',
      'counterexample_capture',
      'ci_report_publishing',
      'security_analysis',
      'type_check',
      'symbolic_execution',
      'model_check',
      'theorem_proof',
    ],
    requiredCategories: ['security_analysis', 'type_check', 'symbolic_execution', 'model_check', 'theorem_proof'],
    cases: [
      { id: 'semgrep', category: 'security_analysis', tool: 'semgrep', command: 'node -e "process.exit(0)"', report_files: ['semgrep.json'], report_format: 'json', severity_threshold: 'critical' },
      { id: 'pyright', category: 'type_check', tool: 'pyright', command: 'node pyright.cjs', report_format: 'json' },
      { id: 'cargo', category: 'type_check', tool: 'cargo check', command: 'node -e "process.exit(0)"', report_files: ['cargo.jsonl'], report_format: 'jsonl' },
      { id: 'gosec', category: 'security_analysis', tool: 'gosec', command: 'node -e "process.exit(0)"', report_files: ['gosec.json'], report_format: 'json', severity_threshold: 'critical' },
      { id: 'cbmc', category: 'symbolic_execution', tool: 'cbmc', command: 'node -e "process.exit(0)"', report_files: ['cbmc.json'], report_format: 'json' },
      { id: 'klee', category: 'symbolic_execution', tool: 'klee', command: 'node klee.cjs' },
      { id: 'tlc', category: 'model_check', tool: 'tlc', command: 'node tlc.cjs' },
      { id: 'coq', category: 'theorem_proof', tool: 'coq', command: 'node coq.cjs' },
      { id: 'lean', category: 'theorem_proof', tool: 'lean', command: 'node lean.cjs' },
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.equal(card.summary.by_id.tool_specific_parser.failed || 0, 0);
  assert.equal(card.summary.by_id.tool_specific_parser.passed >= 9, true);
  assert.equal(card.summary.by_id.counterexample_replay.passed >= 9, true);
  const semgrep = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'formal', 'normalized', 'semgrep.json'), 'utf8'));
  assert.equal(semgrep.findings[0].function, 'loadSecret');
  const cargo = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'formal', 'normalized', 'cargo.json'), 'utf8'));
  assert.equal(cargo.findings[0].id, 'E0308');
  const cbmcReplay = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'formal', 'replay', 'cbmc-replay.json'), 'utf8'));
  assert.equal(cbmcReplay.counterexample_count, 1);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'formal', 'ci', 'formal-junit.xml')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'formal', 'ci', 'formal-findings.sarif')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'formal', 'ci', 'formal-github-step-summary.md')), true);
});

test('formal-suite tracks function and module coverage, not only files', async () => {
  const cwd = tmpDir();
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'math.ts'), 'export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }\n', 'utf8');
  writeScript(path.join(cwd, 'typecheck.cjs'), 'console.log("ok");\n');
  const goalPath = writeFormalGoal(cwd, {
    properties: ['case_present', 'tool_coverage', 'analyzer_success', 'formal_coverage_map', 'function_module_coverage', 'type_check'],
    requiredCategories: ['type_check'],
    cases: [
      {
        id: 'symbols',
        category: 'type_check',
        tool: 'tsc',
        command: 'node typecheck.cjs',
        source_files: ['src/math.ts'],
        covered_files: ['src/math.ts'],
        covered_functions: ['add'],
        covered_modules: ['src.math'],
        coverage: {
          required_files: ['src/math.ts'],
          required_functions: ['add'],
          required_modules: ['src.math'],
        },
      },
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_EVIDENCED');
  assert.equal(card.summary.by_id.function_module_coverage.passed, 1);
  const coverage = JSON.parse(fs.readFileSync(path.join(cwd, '.xoloop', 'goals', 'formal', 'coverage', 'symbols.json'), 'utf8'));
  assert.ok(coverage.discovered_functions.includes('add'));
  assert.ok(coverage.discovered_functions.includes('sub'));
  assert.deepEqual(coverage.missing_functions, []);
});

test('formal-suite hashes proof/model artifacts, writes coverage maps, and extracts model counterexamples', async () => {
  const cwd = tmpDir();
  fs.writeFileSync(path.join(cwd, 'Spec.tla'), '---- MODULE Spec ----\n====\n', 'utf8');
  fs.writeFileSync(path.join(cwd, 'Proof.lean'), 'theorem t : True := True.intro\n', 'utf8');
  writeScript(path.join(cwd, 'model.cjs'), 'console.error("Counterexample seed=abc123 Spec.tla:2: invariant violation"); process.exit(1);\n');
  const goalPath = writeFormalGoal(cwd, {
    properties: ['case_present', 'tool_coverage', 'analyzer_success', 'normalized_reports', 'artifact_hashes', 'formal_coverage_map', 'counterexample_extraction', 'counterexample_capture', 'model_check'],
    requiredCategories: ['model_check'],
    cases: [
      {
        id: 'model',
        category: 'model_check',
        tool: 'tlc',
        command: 'node model.cjs',
        expected_exit_code: 0,
        model_files: ['Spec.tla'],
        proof_files: ['Proof.lean'],
        covered_files: ['Spec.tla'],
        coverage: { required_files: ['Spec.tla'] },
      },
    ],
  });

  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.verdict, 'FAIL');
  assert.equal(card.summary.by_id.artifact_hashes.passed, 1);
  assert.equal(card.summary.by_id.formal_coverage_map.passed, 1);
  assert.equal(card.summary.by_id.counterexample_extraction.passed, 1);
  const corpusPath = path.join(cwd, '.xoloop', 'goals', 'formal', 'corpus', 'model-counterexamples.json');
  assert.equal(fs.existsSync(corpusPath), true);
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  assert.equal(corpus.counterexamples[0].seed, 'abc123');
});

test('formal-suite generated smoke harness runs as PASS_WITH_GAPS, not FAIL', async () => {
  const cwd = tmpDir();
  const created = createGoal({ cwd, kind: 'formal-suite', goalId: 'formal-suite', force: true });

  const { card } = await runGoalVerify(created.goalPath, { cwd });

  assert.equal(card.verdict, 'PASS_WITH_GAPS');
  assert.equal(card.summary.failed, 0);
  assert.ok(card.missing_obligations.includes('lint'));
  assert.ok(card.missing_obligations.includes('model_check'));
  assert.ok(card.missing_obligations.includes('security_analysis'));
});
