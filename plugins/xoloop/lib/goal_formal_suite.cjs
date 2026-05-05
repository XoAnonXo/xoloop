'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { runCliCommand } = require('./goal_cli_runner.cjs');
const { expandSimpleJsonGlob, goalBaseDir } = require('./goal_manifest.cjs');
const { scanFormalRepo } = require('./goal_formal_scan.cjs');

const FORMAL_CATEGORIES = [
  'type_check',
  'lint',
  'model_check',
  'symbolic_execution',
  'theorem_proof',
  'property_fuzz',
  'security_analysis',
];

const DEFAULT_FORMAL_OBLIGATIONS = [
  'case_present',
  'tool_coverage',
  'language_presets',
  'generated_harness_templates',
  'tool_specific_parser',
  'live_tool_fixtures',
  'dependency_install_guidance',
  'analyzer_success',
  'normalized_reports',
  'severity_gate',
  'artifact_hashes',
  'formal_coverage_map',
  'function_module_coverage',
  'counterexample_extraction',
  'counterexample_replay',
  'counterexample_capture',
  'ci_report_publishing',
  ...FORMAL_CATEGORIES,
];

const SEVERITY_RANK = {
  none: 0,
  info: 1,
  note: 1,
  low: 2,
  warning: 2,
  medium: 3,
  moderate: 3,
  high: 4,
  error: 4,
  critical: 5,
  blocker: 5,
};

const PROPERTY_TEMPLATES = {
  'typescript-fast-check.cjs': [
    "'use strict';",
    "const fc = require('fast-check');",
    '',
    '// Replace target with the module/function being optimized.',
    'const target = (value) => value;',
    '',
    'fc.assert(fc.property(fc.jsonValue(), (value) => {',
    '  return JSON.stringify(target(value)) === JSON.stringify(target(value));',
    '}));',
    '',
  ].join('\n'),
  'python-hypothesis.py': [
    'from hypothesis import given, strategies as st',
    '',
    '# Replace target with the function being optimized.',
    'def target(value):',
    '    return value',
    '',
    '@given(st.recursive(st.none() | st.booleans() | st.integers() | st.text(), lambda children: st.lists(children) | st.dictionaries(st.text(), children)))',
    'def test_idempotent_shape(value):',
    '    assert target(value) == target(value)',
    '',
  ].join('\n'),
  'rust-proptest.rs': [
    'use proptest::prelude::*;',
    '',
    'proptest! {',
    '    #[test]',
    '    fn target_is_deterministic(value in any::<u64>()) {',
    '        let left = value;',
    '        let right = value;',
    '        prop_assert_eq!(left, right);',
    '    }',
    '}',
    '',
  ].join('\n'),
  'go-fuzz_test.go': [
    'package main',
    '',
    'import "testing"',
    '',
    'func FuzzTarget(f *testing.F) {',
    '    f.Add("seed")',
    '    f.Fuzz(func(t *testing.T, input string) {',
    '        if input != input {',
    '            t.Fatalf("unreachable")',
    '        }',
    '    })',
    '}',
    '',
  ].join('\n'),
  'java-jqwik.java': [
    'import net.jqwik.api.*;',
    '',
    'class TargetProperties {',
    '  @Property',
    '  boolean deterministic(@ForAll String input) {',
    '    return input.equals(input);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'c-cpp-libfuzzer.c': [
    '#include <stddef.h>',
    '#include <stdint.h>',
    '',
    'int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {',
    '  (void)data;',
    '  (void)size;',
    '  return 0;',
    '}',
    '',
  ].join('\n'),
};

const TOOL_ADAPTERS = {
  codeql: {
    aliases: ['codeql'],
    category: 'security_analysis',
    formats: ['sarif', 'json'],
    replay: 'Re-run CodeQL database analysis with the same query pack and SARIF output.',
    install: ['Install GitHub CodeQL CLI.', 'Run `codeql database create` and `codeql database analyze --format=sarif-latest`.'],
  },
  semgrep: {
    aliases: ['semgrep'],
    category: 'security_analysis',
    formats: ['json', 'sarif'],
    replay: 'Re-run Semgrep with the same config and `--json` or `--sarif` output.',
    install: ['python -m pip install semgrep', 'brew install semgrep'],
  },
  mypy: {
    aliases: ['mypy'],
    category: 'type_check',
    formats: ['plain'],
    replay: 'Re-run mypy with the same config and module/file target.',
    install: ['python -m pip install mypy'],
  },
  pyright: {
    aliases: ['pyright', 'basedpyright'],
    category: 'type_check',
    formats: ['json', 'plain'],
    replay: 'Re-run pyright with the same project config and `--outputjson` when possible.',
    install: ['npm install --save-dev pyright', 'python -m pip install pyright'],
  },
  cargo: {
    aliases: ['cargo', 'cargo check', 'cargo clippy', 'clippy', 'rustc'],
    category: 'type_check',
    formats: ['json', 'jsonl', 'plain'],
    replay: 'Re-run the same cargo command, ideally with `--message-format=json` for structured spans.',
    install: ['Install Rust with rustup.', 'Run `cargo check`, `cargo clippy`, or `cargo test`.'],
  },
  gosec: {
    aliases: ['gosec'],
    category: 'security_analysis',
    formats: ['json', 'plain'],
    replay: 'Re-run gosec with the same package pattern and `-fmt=json` output.',
    install: ['go install github.com/securego/gosec/v2/cmd/gosec@latest'],
  },
  cbmc: {
    aliases: ['cbmc'],
    category: 'symbolic_execution',
    formats: ['json', 'plain'],
    replay: 'Re-run CBMC with the same harness and `--json-ui` for structured traces.',
    install: ['brew install cbmc', 'Install CBMC from the upstream release packages.'],
  },
  klee: {
    aliases: ['klee'],
    category: 'symbolic_execution',
    formats: ['plain'],
    replay: 'Re-run KLEE against the same LLVM bitcode and inspect the emitted .ktest input.',
    install: ['Install KLEE with LLVM support and compile the harness to bitcode.'],
  },
  tlc: {
    aliases: ['tlc', 'tla+', 'apalache', 'alloy', 'spin'],
    category: 'model_check',
    formats: ['plain', 'json'],
    replay: 'Re-run the model checker with the same spec/config and seed/depth options.',
    install: ['Install the TLA+ tools or the model checker used by the case.'],
  },
  coq: {
    aliases: ['coq', 'coqc', 'coqtop'],
    category: 'theorem_proof',
    formats: ['plain'],
    replay: 'Re-run coqc/dune against the proof file.',
    install: ['opam install coq'],
  },
  lean: {
    aliases: ['lean', 'lean4', 'lake'],
    category: 'theorem_proof',
    formats: ['plain'],
    replay: 'Re-run `lake build` or `lean <file>` against the proof file.',
    install: ['Install Lean with elan.'],
  },
};

function sanitizeId(id) {
  return String(id || 'case').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'case';
}

function asObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
}

function readTextMaybe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return '';
  }
}

function readJsonMaybe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function artifactPath(goalPath, dirName, testCase, suffix = '.json') {
  return path.join(goalBaseDir(goalPath), dirName, `${sanitizeId(testCase.id)}${suffix}`);
}

function normalizeCategory(value) {
  const text = String(value || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (text === 'type' || text === 'typechecker' || text === 'type_checking') return 'type_check';
  if (text === 'linter' || text === 'linting') return 'lint';
  if (text === 'model' || text === 'model_checker' || text === 'model_checking') return 'model_check';
  if (text === 'symbolic' || text === 'symbolic_exec') return 'symbolic_execution';
  if (text === 'proof' || text === 'theorem' || text === 'theorem_prover') return 'theorem_proof';
  if (text === 'fuzz' || text === 'property' || text === 'property_test') return 'property_fuzz';
  if (text === 'security' || text === 'security_analyzer') return 'security_analysis';
  return FORMAL_CATEGORIES.includes(text) ? text : 'analyzer_success';
}

function loadCaseFile(filePath) {
  const parsed = readJson(filePath);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`formal-suite case must be an object: ${filePath}`);
  }
  if (typeof parsed.id !== 'string' || parsed.id.trim() === '') {
    throw new Error(`formal-suite case must contain string id: ${filePath}`);
  }
  return {
    ...parsed,
    id: parsed.id.trim(),
    category: normalizeCategory(parsed.category || parsed.kind || parsed.type),
    tool: typeof parsed.tool === 'string' ? parsed.tool : '',
    command: typeof parsed.command === 'string' ? parsed.command : '',
    stdin: parsed.stdin == null ? '' : String(parsed.stdin),
    env: asObject(parsed.env, {}),
    expected_exit_code: Number.isInteger(parsed.expected_exit_code) ? parsed.expected_exit_code : 0,
    timeout_ms: Number.isFinite(parsed.timeout_ms) && parsed.timeout_ms > 0 ? Math.floor(parsed.timeout_ms) : 60000,
    allow_failure: parsed.allow_failure === true,
    expect_stdout_includes: Array.isArray(parsed.expect_stdout_includes) ? parsed.expect_stdout_includes.map(String) : [],
    expect_stderr_includes: Array.isArray(parsed.expect_stderr_includes) ? parsed.expect_stderr_includes.map(String) : [],
    forbid_stdout_patterns: Array.isArray(parsed.forbid_stdout_patterns) ? parsed.forbid_stdout_patterns.map(String) : [],
    forbid_stderr_patterns: Array.isArray(parsed.forbid_stderr_patterns) ? parsed.forbid_stderr_patterns.map(String) : [],
    report_files: Array.isArray(parsed.report_files) ? parsed.report_files.map(String) : [],
    report_format: typeof parsed.report_format === 'string' ? parsed.report_format.trim().toLowerCase() : '',
    source_files: Array.isArray(parsed.source_files) ? parsed.source_files.map(String) : [],
    covered_files: Array.isArray(parsed.covered_files) ? parsed.covered_files.map(String) : [],
    covered_functions: Array.isArray(parsed.covered_functions) ? parsed.covered_functions.map(String) : [],
    covered_modules: Array.isArray(parsed.covered_modules) ? parsed.covered_modules.map(String) : [],
    covered_symbols: Array.isArray(parsed.covered_symbols) ? parsed.covered_symbols.map(String) : [],
    proof_files: Array.isArray(parsed.proof_files) ? parsed.proof_files.map(String) : [],
    model_files: Array.isArray(parsed.model_files) ? parsed.model_files.map(String) : [],
    coverage: asObject(parsed.coverage, {}),
    severity_threshold: typeof parsed.severity_threshold === 'string' ? parsed.severity_threshold.trim() : '',
    security_severity_threshold: typeof parsed.security_severity_threshold === 'string' ? parsed.security_severity_threshold.trim() : '',
    language: typeof parsed.language === 'string' ? parsed.language.trim() : '',
    preset: typeof parsed.preset === 'string' ? parsed.preset.trim() : '',
    metadata: asObject(parsed.metadata, {}),
  };
}

function addPass(state, id, testCase, extra = {}) {
  state.verifications.push({ id, status: 'pass', case_id: testCase.id, ...extra });
}

function addGap(state, id, testCase, message, extra = {}) {
  state.verifications.push({ id, status: 'gap', case_id: testCase.id, message, ...extra });
}

function addFailure(state, id, testCase, message, extra = {}) {
  state.verifications.push({ id, status: 'fail', case_id: testCase.id, message, ...extra });
  if (!state.counterexample) {
    state.counterexample = {
      case_id: testCase.id,
      obligation: id,
      message,
      ...extra,
    };
  }
}

function commandTail(result) {
  return {
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    stdout_tail: String(result.stdout || '').slice(-4000),
    stderr_tail: String(result.stderr || '').slice(-4000),
    metrics: result.metrics || {},
  };
}

function includesAll(text, needles) {
  return needles.every((needle) => String(text || '').includes(needle));
}

function regexHits(text, patterns) {
  const hits = [];
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'i').test(String(text || ''))) hits.push(pattern);
    } catch (_err) {
      if (String(text || '').includes(pattern)) hits.push(pattern);
    }
  }
  return hits;
}

function normalizeSeverity(value, fallback = 'info') {
  const raw = String(value || fallback || 'info').trim().toLowerCase();
  if (raw === 'warn') return 'warning';
  if (raw === 'fatal') return 'critical';
  if (raw === 'err') return 'error';
  if (SEVERITY_RANK[raw] !== undefined) return raw;
  return fallback;
}

function severityRank(value) {
  return SEVERITY_RANK[normalizeSeverity(value)] || 0;
}

function normalizeToolName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\+\+/g, 'pp')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function adapterForTool(tool, category = '') {
  const normalized = normalizeToolName(tool);
  for (const [id, adapter] of Object.entries(TOOL_ADAPTERS)) {
    if (id === normalized || adapter.aliases.some((alias) => normalized.includes(normalizeToolName(alias)))) {
      return { id, ...adapter };
    }
  }
  return null;
}

function inferModuleFromFile(file) {
  const rel = String(file || '').replace(/\\/g, '/');
  if (!rel) return '';
  return rel.replace(/\.[^.]+$/, '').replace(/\/index$/, '').replace(/\//g, '.');
}

function parseJsonLines(raw) {
  const values = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      values.push(JSON.parse(line));
    } catch (_err) {
      return [];
    }
  }
  return values;
}

function normalizeFinding(input, defaults = {}) {
  const message = String(input.message || input.text || input.title || defaults.message || '').trim();
  const severity = normalizeSeverity(input.severity || input.level || defaults.severity || 'info');
  const file = input.file || input.path || input.uri || defaults.file || '';
  return {
    schema: 'xoloop.formal_finding.v0.1',
    id: String(input.id || input.rule_id || input.ruleId || input.check_id || defaults.id || '').trim() || undefined,
    category: normalizeCategory(input.category || defaults.category),
    tool: String(input.tool || defaults.tool || '').trim(),
    severity,
    rank: severityRank(severity),
    kind: String(input.kind || defaults.kind || '').trim() || undefined,
    message,
    file,
    line: Number.isFinite(input.line) ? input.line : (Number.isFinite(input.start_line) ? input.start_line : null),
    column: Number.isFinite(input.column) ? input.column : (Number.isFinite(input.start_column) ? input.start_column : null),
    end_line: Number.isFinite(input.end_line) ? input.end_line : null,
    end_column: Number.isFinite(input.end_column) ? input.end_column : null,
    module: String(input.module || defaults.module || inferModuleFromFile(file) || '').trim() || undefined,
    function: String(input.function || input.function_name || defaults.function || '').trim() || undefined,
    symbol: String(input.symbol || defaults.symbol || input.function || input.function_name || '').trim() || undefined,
    trace: input.trace || defaults.trace || undefined,
    replay: input.replay || defaults.replay || undefined,
    adapter: input.adapter || defaults.adapter || undefined,
    source: input.source || defaults.source || '',
    raw: input.raw,
  };
}

function parseSarifObject(sarif, defaults) {
  const findings = [];
  for (const run of asArray(sarif && sarif.runs)) {
    const rules = new Map();
    for (const rule of asArray(run.tool && run.tool.driver && run.tool.driver.rules)) {
      if (rule && rule.id) rules.set(rule.id, rule);
    }
    const tool = (run.tool && run.tool.driver && run.tool.driver.name) || defaults.tool;
    for (const result of asArray(run.results)) {
      const location = asArray(result.locations)[0] || {};
      const physical = location.physicalLocation || {};
      const artifact = physical.artifactLocation || {};
      const region = physical.region || {};
      const rule = rules.get(result.ruleId) || {};
      findings.push(normalizeFinding({
        id: result.ruleId,
        tool,
        severity: result.level || (rule.defaultConfiguration && rule.defaultConfiguration.level) || 'warning',
        message: (result.message && (result.message.text || result.message.markdown)) || rule.name || result.ruleId,
        file: artifact.uri || '',
        line: region.startLine,
        column: region.startColumn,
        raw: result,
      }, { ...defaults, source: defaults.source || 'sarif' }));
    }
  }
  return findings;
}

function xmlAttr(text, name) {
  const match = String(text || '').match(new RegExp(`${name}="([^"]*)"`));
  return match ? match[1] : '';
}

function parseJUnitText(text, defaults) {
  const findings = [];
  const testcaseRe = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
  let match;
  while ((match = testcaseRe.exec(String(text || ''))) !== null) {
    const attrs = match[1];
    const body = match[2];
    const issue = body.match(/<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>/);
    if (!issue) continue;
    findings.push(normalizeFinding({
      id: xmlAttr(attrs, 'name'),
      severity: issue[1] === 'error' ? 'error' : 'high',
      message: xmlAttr(issue[2], 'message') || issue[3].replace(/<[^>]+>/g, ' ').trim(),
      file: xmlAttr(attrs, 'file') || xmlAttr(attrs, 'classname'),
      line: Number(xmlAttr(attrs, 'line')),
      raw: issue[0],
    }, { ...defaults, source: defaults.source || 'junit' }));
  }
  return findings;
}

function genericJsonFinding(item, defaults) {
  const extra = asObject(item.extra, {});
  const start = asObject(item.start, {});
  const end = asObject(item.end, {});
  const loc = asObject(item.location || item.loc, {});
  return normalizeFinding({
    id: item.check_id || item.ruleId || item.rule_id || item.code || item.id,
    severity: item.severity || extra.severity || item.level || item.type,
    message: item.message || extra.message || item.description || item.title || item.reason,
    file: item.path || item.filename || item.file || item.uri || loc.file,
    line: Number(item.line || start.line || loc.line),
    column: Number(item.column || start.col || start.column || loc.column),
    end_line: Number(item.end_line || end.line || loc.endLine),
    end_column: Number(item.end_column || end.col || end.column || loc.endColumn),
    function: item.function || item.function_name || item.symbol || extra.function,
    module: item.module || extra.module,
    symbol: item.symbol || item.function || item.function_name,
    trace: item.trace || extra.trace,
    raw: item,
  }, defaults);
}

function parseSemgrepObject(value, defaults) {
  return asArray(value && value.results).map((result) => {
    const extra = asObject(result.extra, {});
    const metadata = asObject(extra.metadata, {});
    return normalizeFinding({
      id: result.check_id,
      severity: extra.severity || result.severity || 'warning',
      message: extra.message || result.message || result.check_id,
      file: result.path,
      line: Number(asObject(result.start).line),
      column: Number(asObject(result.start).col),
      end_line: Number(asObject(result.end).line),
      end_column: Number(asObject(result.end).col),
      function: metadata.function || metadata.symbol,
      symbol: metadata.symbol || metadata.function,
      raw: result,
    }, { ...defaults, tool: defaults.tool || 'semgrep', adapter: 'semgrep' });
  });
}

function parsePyrightObject(value, defaults) {
  return asArray(value && value.generalDiagnostics).map((diag) => {
    const range = asObject(diag.range, {});
    const start = asObject(range.start, {});
    const end = asObject(range.end, {});
    return normalizeFinding({
      id: diag.rule,
      severity: diag.severity,
      message: diag.message,
      file: diag.file,
      line: Number(start.line) + 1,
      column: Number(start.character) + 1,
      end_line: Number(end.line) + 1,
      end_column: Number(end.character) + 1,
      raw: diag,
    }, { ...defaults, tool: defaults.tool || 'pyright', adapter: 'pyright' });
  });
}

function parseCargoObject(value, defaults) {
  const message = value && value.reason === 'compiler-message' ? value.message : value;
  if (!message || typeof message !== 'object') return [];
  const spans = asArray(message.spans);
  const primary = spans.find((span) => span && span.is_primary) || spans[0] || {};
  return [normalizeFinding({
    id: asObject(message.code).code,
    severity: message.level,
    message: message.message,
    file: primary.file_name,
    line: Number(primary.line_start),
    column: Number(primary.column_start),
    end_line: Number(primary.line_end),
    end_column: Number(primary.column_end),
    function: primary.label,
    symbol: primary.label,
    raw: value,
  }, { ...defaults, tool: defaults.tool || 'cargo', adapter: 'cargo' })];
}

function parseGosecObject(value, defaults) {
  return asArray(value && (value.Issues || value.issues)).map((issue) => normalizeFinding({
    id: issue.rule_id || issue.rule || issue.cwe,
    severity: issue.severity,
    message: issue.details || issue.message || issue.rule_id,
    file: issue.file,
    line: Number(issue.line),
    column: Number(issue.column),
    function: issue.function,
    symbol: issue.function,
    raw: issue,
  }, { ...defaults, tool: defaults.tool || 'gosec', adapter: 'gosec', category: 'security_analysis' }));
}

function walkObjects(value, visitor) {
  if (!value || typeof value !== 'object') return;
  visitor(value);
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visitor);
    return;
  }
  for (const item of Object.values(value)) walkObjects(item, visitor);
}

function parseCbmcObject(value, defaults) {
  const findings = [];
  walkObjects(value, (item) => {
    const status = String(item.status || item.verdict || '').toUpperCase();
    if (!/(FAIL|FALSE|ERROR|UNKNOWN)/.test(status)) return;
    const loc = asObject(item.sourceLocation || item.source_location || item.location, {});
    findings.push(normalizeFinding({
      id: item.property || item.name || item.id,
      severity: status === 'UNKNOWN' ? 'warning' : 'high',
      kind: 'counterexample',
      message: item.description || item.messageText || item.message || `CBMC property ${item.property || item.id || ''} ${status}`.trim(),
      file: loc.file,
      line: Number(loc.line),
      column: Number(loc.column),
      function: loc.function || item.function,
      symbol: item.property,
      trace: item.trace,
      raw: item,
    }, { ...defaults, tool: defaults.tool || 'cbmc', adapter: 'cbmc', category: 'symbolic_execution' }));
  });
  return findings;
}

function parseCodeQlObject(value, defaults) {
  if (value && value.version && Array.isArray(value.runs)) return parseSarifObject(value, { ...defaults, adapter: 'codeql' });
  return [];
}

function parseToolJsonObject(value, adapter, defaults) {
  if (!adapter) return [];
  if (adapter.id === 'codeql') return parseCodeQlObject(value, defaults);
  if (adapter.id === 'semgrep') return parseSemgrepObject(value, defaults);
  if (adapter.id === 'pyright') return parsePyrightObject(value, defaults);
  if (adapter.id === 'cargo') return parseCargoObject(value, defaults);
  if (adapter.id === 'gosec') return parseGosecObject(value, defaults);
  if (adapter.id === 'cbmc') return parseCbmcObject(value, defaults);
  return [];
}

function parseJsonObject(value, defaults) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.map((item) => genericJsonFinding(asObject(item, { message: String(item) }), defaults));
  if (value.version && Array.isArray(value.runs)) return parseSarifObject(value, defaults);
  if (Array.isArray(value.findings)) return value.findings.map((item) => genericJsonFinding(asObject(item), defaults));
  if (Array.isArray(value.results)) return value.results.map((item) => genericJsonFinding(asObject(item), defaults));
  if (Array.isArray(value.errors)) return value.errors.map((item) => genericJsonFinding(asObject(item), { ...defaults, severity: 'error' }));
  if (value.vulnerabilities && typeof value.vulnerabilities === 'object') {
    return Object.entries(value.vulnerabilities).map(([id, vuln]) => genericJsonFinding({ id, ...asObject(vuln), message: asObject(vuln).title || id }, { ...defaults, category: 'security_analysis' }));
  }
  if (value.error || value.message) return [genericJsonFinding(value, defaults)];
  return [];
}

function parsePlainText(text, defaults) {
  const findings = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const located = trimmed.match(/^(.+?):(\d+)(?::(\d+))?:\s*(?:(critical|high|medium|low|error|warning|warn|info|note)\s*)?(.*)$/i);
    const counterexample = /(counterexample|assertion failed|assertion failure|crash|panic|falsifying example|minimal failing input|violation|overflow|out of bounds)/i.test(trimmed);
    const security = /(critical|high).*?(vulnerability|cve|injection|xss|rce|secret|token)/i.test(trimmed);
    if (located) {
      findings.push(normalizeFinding({
        severity: located[4] || (counterexample ? 'high' : 'warning'),
        kind: counterexample ? 'counterexample' : undefined,
        message: located[5] || trimmed,
        file: located[1],
        line: Number(located[2]),
        column: Number(located[3]),
        raw: line,
      }, defaults));
    } else if (counterexample || security || /\b(error|failed|critical|high)\b/i.test(trimmed)) {
      findings.push(normalizeFinding({
        severity: security ? 'critical' : (counterexample ? 'high' : 'error'),
        kind: counterexample ? 'counterexample' : undefined,
        message: trimmed,
        raw: line,
      }, defaults));
    }
  }
  return findings;
}

function parseMypyText(text, defaults) {
  const findings = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^(.+?):(\d+)(?::(\d+))?:\s*(error|note|warning):\s*(.*?)(?:\s+\[([^\]]+)])?$/i);
    if (!match) continue;
    findings.push(normalizeFinding({
      id: match[6],
      severity: match[4],
      message: match[5],
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      raw: line,
    }, { ...defaults, adapter: 'mypy' }));
  }
  return findings;
}

function parsePyrightText(text, defaults) {
  const findings = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(.+?):(\d+):(\d+)\s*-\s*(error|warning|information|info):\s*(.*?)(?:\s+\(([^)]+)\))?$/i);
    if (!match) continue;
    findings.push(normalizeFinding({
      id: match[6],
      severity: match[4] === 'information' ? 'info' : match[4],
      message: match[5],
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      raw: line,
    }, { ...defaults, adapter: 'pyright' }));
  }
  return findings;
}

function parseCargoText(text, defaults) {
  const findings = [];
  const lines = String(text || '').split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const header = line.match(/^(error|warning)(?:\[([^\]]+)])?:\s*(.*)$/i);
    if (header) {
      current = { severity: header[1], id: header[2], message: header[3] };
      continue;
    }
    const loc = line.match(/-->\s+(.+?):(\d+):(\d+)/);
    if (loc && current) {
      findings.push(normalizeFinding({
        id: current.id,
        severity: current.severity,
        message: current.message,
        file: loc[1].trim(),
        line: Number(loc[2]),
        column: Number(loc[3]),
        raw: `${current.message}\n${line}`,
      }, { ...defaults, adapter: 'cargo' }));
      current = null;
    }
  }
  return findings;
}

function parseGosecText(text, defaults) {
  const findings = [];
  const blocks = String(text || '').split(/\n\s*\n/);
  for (const block of blocks) {
    const rule = block.match(/\[(G\d+)]\s*(.*)/);
    const sev = block.match(/Severity:\s*(LOW|MEDIUM|HIGH)/i);
    const loc = block.match(/>\s*(.+?):(\d+)(?::(\d+))?/);
    if (!rule && !loc) continue;
    findings.push(normalizeFinding({
      id: rule && rule[1],
      severity: sev && sev[1],
      message: (rule && rule[2]) || block.trim(),
      file: loc && loc[1],
      line: loc ? Number(loc[2]) : null,
      column: loc ? Number(loc[3]) : null,
      raw: block,
    }, { ...defaults, adapter: 'gosec', category: 'security_analysis' }));
  }
  return findings;
}

function parseCbmcText(text, defaults) {
  const findings = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/(VERIFICATION FAILED|FAILURE|assertion|violated)/i.test(line)) continue;
    const loc = line.match(/([^:\s]+\.(?:c|cc|cpp|h|hpp)):(\d+)(?::(\d+))?/i);
    findings.push(normalizeFinding({
      severity: 'high',
      kind: 'counterexample',
      message: line.trim(),
      file: loc && loc[1],
      line: loc ? Number(loc[2]) : null,
      column: loc ? Number(loc[3]) : null,
      raw: line,
    }, { ...defaults, adapter: 'cbmc', category: 'symbolic_execution' }));
  }
  return findings;
}

function parseKleeText(text, defaults) {
  const findings = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/KLEE:\s*ERROR:\s*(.+?):(\d+)(?::(\d+))?:\s*(.*)$/i);
    if (!match) continue;
    findings.push(normalizeFinding({
      severity: 'high',
      kind: 'counterexample',
      message: match[4],
      file: match[1],
      line: Number(match[2]),
      column: Number(match[3]),
      raw: line,
    }, { ...defaults, adapter: 'klee', category: 'symbolic_execution' }));
  }
  return findings;
}

function parseTlcText(text, defaults) {
  const raw = String(text || '');
  if (!/(Invariant .*violated|Temporal properties were violated|Error:.*violated|Counterexample)/i.test(raw)) return [];
  const invariant = (raw.match(/Invariant\s+([A-Za-z0-9_.-]+)/i) || [])[1] || (raw.match(/property\s+([A-Za-z0-9_.-]+)/i) || [])[1] || '';
  const states = raw.split(/\r?\n/).filter((line) => /^\s*State\s+\d+:/i.test(line) || /^\s*\/\\/.test(line)).slice(0, 80);
  return [normalizeFinding({
    id: invariant,
    severity: 'high',
    kind: 'counterexample',
    message: invariant ? `TLC invariant violated: ${invariant}` : raw.split(/\r?\n/).find(Boolean),
    trace: states,
    raw,
  }, { ...defaults, adapter: 'tlc', category: 'model_check' })];
}

function parseCoqLeanText(text, adapterId, defaults) {
  const findings = [];
  const raw = String(text || '');
  const coqRe = /File\s+"([^"]+)",\s+line\s+(\d+),\s+characters\s+(\d+)-(\d+):\s*(?:\r?\n)?(Error|Warning):\s*([\s\S]*?)(?=\nFile\s+"|$)/g;
  let match;
  while ((match = coqRe.exec(raw)) !== null) {
    findings.push(normalizeFinding({
      severity: match[5].toLowerCase(),
      message: match[6].trim(),
      file: match[1].replace(/^\.\//, ''),
      line: Number(match[2]),
      column: Number(match[3]) + 1,
      end_column: Number(match[4]) + 1,
      raw: match[0],
    }, { ...defaults, adapter: adapterId, category: 'theorem_proof' }));
  }
  if (findings.length > 0) return findings;
  for (const line of raw.split(/\r?\n/)) {
    const lean = line.match(/^(.+?\.(?:lean|v)):(\d+):(\d+):\s*(error|warning|info):\s*(.*)$/i);
    if (!lean) continue;
    findings.push(normalizeFinding({
      severity: lean[4],
      message: lean[5],
      file: lean[1],
      line: Number(lean[2]),
      column: Number(lean[3]),
      raw: line,
    }, { ...defaults, adapter: adapterId, category: 'theorem_proof' }));
  }
  return findings;
}

function parseToolPlainText(text, adapter, defaults) {
  if (!adapter) return [];
  if (adapter.id === 'mypy') return parseMypyText(text, defaults);
  if (adapter.id === 'pyright') return parsePyrightText(text, defaults);
  if (adapter.id === 'cargo') return parseCargoText(text, defaults);
  if (adapter.id === 'gosec') return parseGosecText(text, defaults);
  if (adapter.id === 'cbmc') return parseCbmcText(text, defaults);
  if (adapter.id === 'klee') return parseKleeText(text, defaults);
  if (adapter.id === 'tlc') return parseTlcText(text, defaults);
  if (adapter.id === 'coq' || adapter.id === 'lean') return parseCoqLeanText(text, adapter.id, defaults);
  return [];
}

function parseAnalyzerText(text, format, defaults) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  const adapter = adapterForTool(defaults.tool, defaults.category);
  const adapterDefaults = { ...defaults, adapter: adapter && !adapter.inferred ? adapter.id : undefined };
  const json = format === 'json' || format === 'sarif' || /^[\s\n\r]*[{\[]/.test(raw) ? (() => {
    try { return JSON.parse(raw); } catch (_err) { return null; }
  })() : null;
  if (json) {
    const specific = parseToolJsonObject(json, adapter, { ...adapterDefaults, source: defaults.source || format || 'json' });
    return specific.length > 0 ? specific : parseJsonObject(json, { ...defaults, source: defaults.source || format || 'json' });
  }
  const jsonLines = format === 'jsonl' || format === 'json' || /^[\s\n\r]*\{/.test(raw) ? parseJsonLines(raw) : [];
  if (jsonLines.length > 0) {
    const specific = jsonLines.flatMap((value) => parseToolJsonObject(value, adapter, { ...adapterDefaults, source: defaults.source || 'jsonl' }));
    return specific.length > 0
      ? specific
      : jsonLines.flatMap((value) => parseJsonObject(value, { ...defaults, source: defaults.source || 'jsonl' }));
  }
  if (format === 'junit' || format === 'xml' || /<testsuite|<testcase/.test(raw)) return parseJUnitText(raw, { ...defaults, source: defaults.source || 'junit' });
  const specific = parseToolPlainText(raw, adapter, { ...adapterDefaults, source: defaults.source || 'plain' });
  return specific.length > 0 ? specific : parsePlainText(raw, { ...defaults, source: defaults.source || 'plain' });
}

function parseReportFile(report, testCase) {
  const text = readTextMaybe(report.absolute);
  const ext = path.extname(report.source).toLowerCase();
  const format = testCase.report_format || (ext === '.sarif' ? 'sarif' : (ext === '.xml' ? 'junit' : (ext === '.jsonl' ? 'jsonl' : (ext === '.json' ? 'json' : 'plain'))));
  return parseAnalyzerText(text, format, {
    category: testCase.category,
    tool: testCase.tool,
    source: report.source,
  });
}

function collectReportFiles(cwd, goalPath, testCase) {
  const reports = [];
  for (const rel of testCase.report_files) {
    const absolute = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const dest = artifactPath(goalPath, 'reports', { id: `${testCase.id}-${path.basename(rel)}` });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(absolute, dest);
    reports.push({ source: rel, absolute, report_path: dest, bytes: fs.statSync(dest).size });
  }
  return reports;
}

function normalizeReports(result, reports, testCase) {
  const findings = [
    ...parseAnalyzerText(result.stdout, testCase.report_format, { category: testCase.category, tool: testCase.tool, source: 'stdout' }),
    ...parseAnalyzerText(result.stderr, 'plain', { category: testCase.category, tool: testCase.tool, source: 'stderr' }),
  ];
  for (const report of reports) findings.push(...parseReportFile(report, testCase));
  const unique = [];
  const seen = new Set();
  for (const finding of findings) {
    const key = [finding.category, finding.tool, finding.id, finding.file, finding.line, finding.message].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(finding);
  }
  return {
    schema: 'xoloop.formal_report.v0.1',
    case_id: testCase.id,
    category: testCase.category,
    tool: testCase.tool,
    findings: unique,
  };
}

function severityThreshold(goal, testCase) {
  const global = goal.verify.severity_threshold || '';
  const securityGlobal = goal.verify.security_severity_threshold || 'high';
  if (testCase.security_severity_threshold) return normalizeSeverity(testCase.security_severity_threshold);
  if (testCase.severity_threshold) return normalizeSeverity(testCase.severity_threshold);
  if (testCase.category === 'security_analysis') return normalizeSeverity(securityGlobal);
  return global ? normalizeSeverity(global) : '';
}

function blockingFindings(goal, testCase, normalized) {
  const threshold = severityThreshold(goal, testCase);
  if (!threshold) return [];
  const rank = severityRank(threshold);
  return normalized.findings.filter((finding) => severityRank(finding.severity) >= rank);
}

function extractCounterexamples(result, normalized, testCase) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const seed = extractSeed(text);
  const categories = new Set(['model_check', 'symbolic_execution', 'property_fuzz']);
  return normalized.findings.filter((finding) => {
    const haystack = `${finding.kind || ''} ${finding.message || ''}`.toLowerCase();
    return haystack.includes('counterexample') ||
      haystack.includes('crash') ||
      haystack.includes('falsifying') ||
      haystack.includes('assertion') ||
      haystack.includes('violation') ||
      (categories.has(testCase.category) && severityRank(finding.severity) >= severityRank('high'));
  }).map((finding) => ({
    category: testCase.category,
    tool: testCase.tool,
    fingerprint: findingFingerprint(testCase, finding),
    finding,
    seed,
    minimized: {
      message: finding.message,
      file: finding.file || '',
      line: finding.line,
      window: minimalTextWindow(text, finding),
    },
    replay_command: testCase.command,
  }));
}

function hashDeclaredArtifacts(cwd, goalPath, testCase) {
  const files = [
    ...testCase.proof_files.map((file) => ({ kind: 'proof', file })),
    ...testCase.model_files.map((file) => ({ kind: 'model', file })),
  ];
  const hashes = [];
  for (const entry of files) {
    const absolute = path.isAbsolute(entry.file) ? entry.file : path.resolve(cwd, entry.file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    hashes.push({
      kind: entry.kind,
      file: entry.file,
      sha256: sha256File(absolute),
      bytes: fs.statSync(absolute).size,
    });
  }
  const hashPath = writeJson(artifactPath(goalPath, 'proofs', testCase, '-artifact-hashes.json'), {
    schema: 'xoloop.formal_artifact_hashes.v0.1',
    case_id: testCase.id,
    hashes,
  });
  return { hashes, hashPath };
}

function normalizeCoverageName(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function extractSourceSymbols(cwd, rel) {
  const absolute = path.isAbsolute(rel) ? rel : path.resolve(cwd, rel);
  const text = readTextMaybe(absolute);
  if (!text) return { file: rel, module: inferModuleFromFile(rel), functions: [] };
  const functions = new Set();
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^=]*?\)?\s*=>/g,
    /^\s*def\s+([A-Za-z_]\w*)\s*\(/gm,
    /^\s*class\s+([A-Za-z_]\w*)\b/gm,
    /\bfn\s+([A-Za-z_]\w*)\s*[<(]/g,
    /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/g,
    /\b(?:public|private|protected|static|\s)+[A-Za-z_][\w<>\[\],\s]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) functions.add(match[1]);
  }
  const packageMatch = text.match(/^\s*(?:package|module|namespace)\s+([A-Za-z0-9_.:-]+)/m);
  return {
    file: path.isAbsolute(rel) ? path.relative(cwd, rel).replace(/\\/g, '/') : rel,
    module: packageMatch ? packageMatch[1] : inferModuleFromFile(rel),
    functions: [...functions].sort(),
  };
}

function coverageMap(cwd, goalPath, goal, testCase, normalized, artifactHashes) {
  const sourceSymbols = testCase.source_files.map((file) => extractSourceSymbols(cwd, file));
  const files = new Set([
    ...testCase.covered_files,
    ...testCase.source_files,
    ...testCase.proof_files,
    ...testCase.model_files,
    ...artifactHashes.map((item) => item.file),
    ...normalized.findings.map((finding) => finding.file).filter(Boolean),
  ].map((file) => path.isAbsolute(file) ? path.relative(cwd, file).replace(/\\/g, '/') : file));
  const discoveredFunctions = new Set();
  const discoveredModules = new Set();
  for (const item of sourceSymbols) {
    if (item.module) discoveredModules.add(item.module);
    for (const fn of item.functions) {
      discoveredFunctions.add(fn);
      if (item.module) discoveredFunctions.add(`${item.module}::${fn}`);
    }
  }
  const coveredFunctions = new Set([
    ...testCase.covered_functions,
    ...testCase.covered_symbols,
    ...normalized.findings.map((finding) => finding.function || finding.symbol).filter(Boolean),
  ].map(normalizeCoverageName).filter(Boolean));
  const coveredModules = new Set([
    ...testCase.covered_modules,
    ...normalized.findings.map((finding) => finding.module).filter(Boolean),
  ].map(normalizeCoverageName).filter(Boolean));
  const required = [
    ...asArray(goal.verify.coverage && goal.verify.coverage.required_files).map(String),
    ...asArray(goal.verify.coverage && goal.verify.coverage.required).map(String),
    ...asArray(testCase.coverage.required_files).map(String),
    ...asArray(testCase.coverage.required).map(String),
  ];
  const requiredFunctions = [
    ...asArray(goal.verify.coverage && goal.verify.coverage.required_functions).map(String),
    ...asArray(goal.verify.coverage && goal.verify.coverage.required_symbols).map(String),
    ...asArray(testCase.coverage.required_functions).map(String),
    ...asArray(testCase.coverage.required_symbols).map(String),
  ].map(normalizeCoverageName).filter(Boolean);
  const requiredModules = [
    ...asArray(goal.verify.coverage && goal.verify.coverage.required_modules).map(String),
    ...asArray(testCase.coverage.required_modules).map(String),
  ].map(normalizeCoverageName).filter(Boolean);
  const covered = [...files].filter(Boolean).sort();
  const missing = required.filter((file) => !files.has(file));
  const missingFunctions = requiredFunctions.filter((name) => !coveredFunctions.has(name));
  const missingModules = requiredModules.filter((name) => !coveredModules.has(name));
  const coveragePath = writeJson(artifactPath(goalPath, 'coverage', testCase), {
    schema: 'xoloop.formal_coverage_map.v0.1',
    case_id: testCase.id,
    category: testCase.category,
    tool: testCase.tool,
    covered_files: covered,
    required_files: required,
    discovered_functions: [...discoveredFunctions].sort(),
    discovered_modules: [...discoveredModules].sort(),
    covered_functions: [...coveredFunctions].sort(),
    covered_modules: [...coveredModules].sort(),
    required_functions: requiredFunctions,
    required_modules: requiredModules,
    missing,
    missing_functions: missingFunctions,
    missing_modules: missingModules,
  });
  return {
    covered,
    required,
    missing,
    discoveredFunctions: [...discoveredFunctions].sort(),
    discoveredModules: [...discoveredModules].sort(),
    coveredFunctions: [...coveredFunctions].sort(),
    coveredModules: [...coveredModules].sort(),
    requiredFunctions,
    requiredModules,
    missingFunctions,
    missingModules,
    coveragePath,
  };
}

function formalStaticAssets(goalPath) {
  const base = goalBaseDir(goalPath);
  const templatesDir = path.join(base, 'templates');
  const presetsDir = path.join(base, 'presets');
  const adaptersPath = path.join(base, 'adapters', 'formal-tool-adapters.json');
  const installPath = path.join(base, 'install', 'tool-install-guidance.json');
  const liveFixturesPath = path.join(base, 'live-fixtures', 'README.md');
  const templates = fs.existsSync(templatesDir) ? fs.readdirSync(templatesDir).filter((name) => fs.statSync(path.join(templatesDir, name)).isFile()) : [];
  const presets = fs.existsSync(presetsDir) ? fs.readdirSync(presetsDir).filter((name) => fs.statSync(path.join(presetsDir, name)).isFile()) : [];
  return {
    templates,
    presets,
    adaptersPath,
    installPath,
    liveFixturesPath,
    adapters: fs.existsSync(adaptersPath),
    install: fs.existsSync(installPath),
    liveFixtures: fs.existsSync(liveFixturesPath),
  };
}

function writeFailureDiff(goalPath, testCase, obligation, payload) {
  return writeJson(artifactPath(goalPath, 'diffs', testCase, `-${sanitizeId(obligation)}.json`), payload);
}

function findingFingerprint(testCase, finding) {
  return crypto.createHash('sha256').update(JSON.stringify({
    case_id: testCase.id,
    category: testCase.category,
    tool: testCase.tool,
    id: finding.id || '',
    file: finding.file || '',
    line: finding.line || '',
    message: finding.message || '',
  })).digest('hex').slice(0, 16);
}

function minimalTextWindow(text, finding) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length === 0) return [];
  const needle = String((finding && (finding.file || finding.message || finding.id)) || '').slice(0, 80);
  let index = needle ? lines.findIndex((line) => line.includes(needle)) : -1;
  if (index < 0 && finding && Number.isFinite(finding.line)) index = Math.max(0, finding.line - 1);
  if (index < 0) index = lines.findIndex((line) => /(counterexample|crash|assertion|violated|error|failed)/i.test(line));
  if (index < 0) index = 0;
  const start = Math.max(0, index - 3);
  const end = Math.min(lines.length, index + 4);
  return lines.slice(start, end).map((line, offset) => ({ line: start + offset + 1, text: line }));
}

function extractSeed(text) {
  return (String(text || '').match(/\b(?:seed|random_seed|rng seed)\s*[:=]\s*([A-Za-z0-9_.:-]+)/i) || [])[1] || '';
}

function buildReplayArtifact(goalPath, testCase, result, normalized, counterexamples) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  const adapter = adapterForTool(testCase.tool, testCase.category);
  return writeJson(artifactPath(goalPath, 'replay', testCase, '-replay.json'), {
    schema: 'xoloop.formal_replay.v0.1',
    case_id: testCase.id,
    category: testCase.category,
    tool: testCase.tool,
    command: testCase.command,
    seed: extractSeed(text),
    adapter: adapter && !adapter.inferred ? adapter.id : '',
    replay_hint: adapter ? adapter.replay : 'Re-run the same analyzer command and inspect the trace/diff artifacts.',
    findings: normalized.findings.map((finding) => ({
      fingerprint: findingFingerprint(testCase, finding),
      id: finding.id || '',
      severity: finding.severity,
      kind: finding.kind || '',
      file: finding.file || '',
      line: finding.line,
      column: finding.column,
      module: finding.module || '',
      function: finding.function || '',
      symbol: finding.symbol || '',
      message: finding.message,
      minimal_window: minimalTextWindow(text, finding),
    })),
    counterexample_count: counterexamples.length,
  });
}

async function verifyOneCase(goal, goalPath, testCase, cwd) {
  const state = { verifications: [], metrics: [], counterexample: null };
  addPass(state, 'case_present', testCase);
  if (!testCase.command) {
    addGap(state, testCase.category, testCase, 'formal/static case has no command');
    addGap(state, 'analyzer_success', testCase, 'formal/static case has no command');
    addGap(state, 'normalized_reports', testCase, 'formal/static case has no command');
    addGap(state, 'severity_gate', testCase, 'formal/static case has no command');
    addGap(state, 'artifact_hashes', testCase, 'no proof/model artifacts declared');
    addGap(state, 'formal_coverage_map', testCase, 'formal/static case has no command');
    addGap(state, 'function_module_coverage', testCase, 'formal/static case has no command');
    addGap(state, 'tool_specific_parser', testCase, 'formal/static case has no command');
    addPass(state, 'counterexample_extraction', testCase, { counterexamples: 0 });
    addGap(state, 'counterexample_replay', testCase, 'formal/static case has no command');
    addPass(state, 'counterexample_capture', testCase, { trace_path: artifactPath(goalPath, 'traces', testCase) });
    writeJson(artifactPath(goalPath, 'traces', testCase), { case: testCase, skipped: true });
    return state;
  }
  const result = await runCliCommand(testCase.command, testCase.stdin, {
    cwd,
    env: testCase.env,
    timeoutMs: testCase.timeout_ms,
    maxBuffer: 32 * 1024 * 1024,
  });
  state.metrics.push(result.metrics || {});
  const reports = collectReportFiles(cwd, goalPath, testCase);
  const normalized = normalizeReports(result, reports, testCase);
  const normalizedPath = writeJson(artifactPath(goalPath, 'normalized', testCase), normalized);
  const counterexamples = extractCounterexamples(result, normalized, testCase);
  const replayPath = buildReplayArtifact(goalPath, testCase, result, normalized, counterexamples);
  const counterexamplePath = counterexamples.length > 0
    ? writeJson(artifactPath(goalPath, 'corpus', testCase, '-counterexamples.json'), {
        schema: 'xoloop.formal_counterexamples.v0.1',
        case_id: testCase.id,
        counterexamples,
      })
    : '';
  const artifactInfo = hashDeclaredArtifacts(cwd, goalPath, testCase);
  const coverage = coverageMap(cwd, goalPath, goal, testCase, normalized, artifactInfo.hashes);
  const severityFailures = blockingFindings(goal, testCase, normalized);
  const tracePath = writeJson(artifactPath(goalPath, 'traces', testCase), {
    case: testCase,
    command: testCase.command,
    result: commandTail(result),
    reports,
    normalized_path: normalizedPath,
    replay_path: replayPath,
    counterexample_path: counterexamplePath,
    artifact_hashes: artifactInfo.hashes,
    coverage_path: coverage.coveragePath,
  });
  writeJson(artifactPath(goalPath, 'actual', testCase), {
    category: testCase.category,
    tool: testCase.tool,
    result: commandTail(result),
    reports,
    normalized_path: normalizedPath,
    finding_count: normalized.findings.length,
    counterexamples: counterexamples.length,
    replay_path: replayPath,
    coverage_path: coverage.coveragePath,
  });
  addPass(state, 'normalized_reports', testCase, { normalized_path: normalizedPath, findings: normalized.findings.length });
  const adapter = adapterForTool(testCase.tool, testCase.category);
  if (adapter && !adapter.inferred) addPass(state, 'tool_specific_parser', testCase, { adapter: adapter.id, formats: adapter.formats });
  else addGap(state, 'tool_specific_parser', testCase, 'no tool-specific parser matched this formal/static case');
  if (counterexamples.length > 0) addPass(state, 'counterexample_extraction', testCase, { counterexamples: counterexamples.length, counterexample_path: counterexamplePath });
  else addPass(state, 'counterexample_extraction', testCase, { counterexamples: 0 });
  addPass(state, 'counterexample_replay', testCase, { replay_path: replayPath, counterexamples: counterexamples.length });
  if (artifactInfo.hashes.length > 0) addPass(state, 'artifact_hashes', testCase, { hash_path: artifactInfo.hashPath, hashes: artifactInfo.hashes.length });
  else addGap(state, 'artifact_hashes', testCase, 'no proof/model artifacts declared');
  if (coverage.missing.length > 0 || coverage.missingFunctions.length > 0 || coverage.missingModules.length > 0) {
    addFailure(state, 'formal_coverage_map', testCase, 'declared formal coverage is missing required files', {
      coverage_path: coverage.coveragePath,
      missing_coverage: coverage.missing,
      missing_functions: coverage.missingFunctions,
      missing_modules: coverage.missingModules,
    });
  } else if (coverage.covered.length > 0) {
    addPass(state, 'formal_coverage_map', testCase, { coverage_path: coverage.coveragePath, covered_files: coverage.covered.length });
  } else {
    addGap(state, 'formal_coverage_map', testCase, 'no source/proof/model/report coverage evidence declared');
  }
  if (coverage.missingFunctions.length > 0 || coverage.missingModules.length > 0) {
    addFailure(state, 'function_module_coverage', testCase, 'declared function/module formal coverage is missing symbols', {
      coverage_path: coverage.coveragePath,
      missing_functions: coverage.missingFunctions,
      missing_modules: coverage.missingModules,
    });
  } else if (coverage.coveredFunctions.length > 0 || coverage.coveredModules.length > 0 || coverage.discoveredFunctions.length > 0 || coverage.discoveredModules.length > 0) {
    addPass(state, 'function_module_coverage', testCase, {
      coverage_path: coverage.coveragePath,
      covered_functions: coverage.coveredFunctions.length,
      covered_modules: coverage.coveredModules.length,
      discovered_functions: coverage.discoveredFunctions.length,
      discovered_modules: coverage.discoveredModules.length,
    });
  } else {
    addGap(state, 'function_module_coverage', testCase, 'no function/module-level coverage evidence declared or discovered');
  }
  addPass(state, 'counterexample_capture', testCase, { trace_path: tracePath, reports });
  const stdoutMissing = testCase.expect_stdout_includes.length > 0 && !includesAll(result.stdout, testCase.expect_stdout_includes);
  const stderrMissing = testCase.expect_stderr_includes.length > 0 && !includesAll(result.stderr, testCase.expect_stderr_includes);
  const stdoutForbidden = regexHits(result.stdout, testCase.forbid_stdout_patterns);
  const stderrForbidden = regexHits(result.stderr, testCase.forbid_stderr_patterns);
  const exitOk = result.exitCode === testCase.expected_exit_code && !result.timedOut;
  const passed = exitOk && !stdoutMissing && !stderrMissing && stdoutForbidden.length === 0 && stderrForbidden.length === 0;
  if (severityFailures.length === 0) {
    addPass(state, 'severity_gate', testCase, { threshold: severityThreshold(goal, testCase) || 'none', findings: normalized.findings.length });
  } else if (testCase.allow_failure) {
    addGap(state, 'severity_gate', testCase, 'severity gate failed but case is advisory', { findings: severityFailures.length, normalized_path: normalizedPath });
  } else {
    const severityDiffPath = writeFailureDiff(goalPath, testCase, 'severity_gate', {
      threshold: severityThreshold(goal, testCase),
      findings: severityFailures,
      normalized_path: normalizedPath,
    });
    addFailure(state, 'severity_gate', testCase, 'formal/static analyzer findings exceeded severity gate', {
      diff_path: severityDiffPath,
      normalized_path: normalizedPath,
      findings: severityFailures.length,
    });
  }
  let categoryDiffPath = '';
  if (passed && severityFailures.length === 0) {
    addPass(state, testCase.category, testCase, { tool: testCase.tool, reports, normalized_path: normalizedPath });
  } else if (testCase.allow_failure) {
    addGap(state, testCase.category, testCase, 'formal/static analyzer failed or exceeded severity policy but case is advisory', { result: commandTail(result), normalized_path: normalizedPath });
  } else {
    categoryDiffPath = writeFailureDiff(goalPath, testCase, testCase.category, {
      category: testCase.category,
      tool: testCase.tool,
      command: testCase.command,
      expected_exit_code: testCase.expected_exit_code,
      result: commandTail(result),
      stdout_missing: stdoutMissing ? testCase.expect_stdout_includes : [],
      stderr_missing: stderrMissing ? testCase.expect_stderr_includes : [],
      stdout_forbidden: stdoutForbidden,
      stderr_forbidden: stderrForbidden,
      normalized_path: normalizedPath,
      findings: normalized.findings,
      severity_failures: severityFailures,
      counterexample_path: counterexamplePath,
      reports,
    });
    addFailure(state, testCase.category, testCase, 'formal/static analyzer found a counterexample or failed its policy', {
      diff_path: categoryDiffPath,
      trace_path: tracePath,
      category: testCase.category,
      tool: testCase.tool,
      command: testCase.command,
      stdout_forbidden: stdoutForbidden,
      stderr_forbidden: stderrForbidden,
      normalized_path: normalizedPath,
      counterexample_path: counterexamplePath,
      findings: normalized.findings.length,
      severity_failures: severityFailures.length,
      ...commandTail(result),
    });
  }
  if (passed) {
    addPass(state, 'analyzer_success', testCase, { category: testCase.category, tool: testCase.tool, exit_code: result.exitCode });
  } else if (testCase.allow_failure) {
    addGap(state, 'analyzer_success', testCase, 'formal/static analyzer failed but case is advisory', { result: commandTail(result), normalized_path: normalizedPath });
  } else {
    addFailure(state, 'analyzer_success', testCase, 'formal/static analyzer command failed', {
      diff_path: categoryDiffPath || tracePath,
      trace_path: tracePath,
      category: testCase.category,
      tool: testCase.tool,
      normalized_path: normalizedPath,
    });
  }
  return state;
}

function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readNormalizedFindings(verifications) {
  const findings = [];
  for (const verification of verifications) {
    if (!verification || verification.id !== 'normalized_reports' || !verification.normalized_path) continue;
    const normalized = readJsonMaybe(verification.normalized_path);
    if (normalized && Array.isArray(normalized.findings)) findings.push(...normalized.findings);
  }
  return findings;
}

function writeFormalCiReports(goalPath, goal, cases, verifications, counterexample) {
  const base = goalBaseDir(goalPath);
  const ciDir = path.join(base, 'ci');
  fs.mkdirSync(ciDir, { recursive: true });
  const summary = {
    schema: 'xoloop.formal_ci_summary.v0.1',
    goal_id: goal.goal_id,
    cases: cases.length,
    verifications: {
      total: verifications.length,
      pass: verifications.filter((item) => item.status === 'pass').length,
      fail: verifications.filter((item) => item.status === 'fail').length,
      gap: verifications.filter((item) => item.status === 'gap').length,
    },
    counterexample: counterexample || null,
    generated_at: new Date().toISOString(),
  };
  const summaryPath = writeJson(path.join(ciDir, 'formal-summary.json'), summary);
  const testcaseXml = verifications.map((verification) => {
    const name = `${verification.id}${verification.case_id ? `:${verification.case_id}` : ''}`;
    if (verification.status === 'fail') {
      return `  <testcase classname="xoloop.formal" name="${xmlEscape(name)}"><failure message="${xmlEscape(verification.message || 'formal verification failed')}">${xmlEscape(JSON.stringify(verification))}</failure></testcase>`;
    }
    if (verification.status === 'gap') {
      return `  <testcase classname="xoloop.formal" name="${xmlEscape(name)}"><skipped message="${xmlEscape(verification.message || 'formal verification gap')}"/></testcase>`;
    }
    return `  <testcase classname="xoloop.formal" name="${xmlEscape(name)}"/>`;
  }).join('\n');
  const junitPath = path.join(ciDir, 'formal-junit.xml');
  fs.writeFileSync(junitPath, [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuite name="xoloop-formal" tests="${verifications.length}" failures="${summary.verifications.fail}" skipped="${summary.verifications.gap}">`,
    testcaseXml,
    '</testsuite>',
    '',
  ].join('\n'), 'utf8');
  const findings = readNormalizedFindings(verifications);
  const sarifPath = path.join(ciDir, 'formal-findings.sarif');
  writeJson(sarifPath, {
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'xoloop formal-suite', informationUri: 'https://github.com/openai/codex' } },
      results: findings.map((finding) => ({
        ruleId: finding.id || `${finding.tool || 'formal'}:${finding.category || 'finding'}`,
        level: severityRank(finding.severity) >= severityRank('high') ? 'error' : (severityRank(finding.severity) >= severityRank('medium') ? 'warning' : 'note'),
        message: { text: finding.message || finding.id || 'formal analyzer finding' },
        locations: finding.file ? [{
          physicalLocation: {
            artifactLocation: { uri: finding.file },
            region: {
              startLine: finding.line || 1,
              startColumn: finding.column || 1,
            },
          },
        }] : [],
      })),
    }],
  });
  const githubSummaryPath = path.join(ciDir, 'formal-github-step-summary.md');
  fs.writeFileSync(githubSummaryPath, [
    '# XOLoop Formal Verify',
    '',
    `- Goal: \`${goal.goal_id}\``,
    `- Cases: ${cases.length}`,
    `- Passed: ${summary.verifications.pass}`,
    `- Failed: ${summary.verifications.fail}`,
    `- Gaps: ${summary.verifications.gap}`,
    `- Findings: ${findings.length}`,
    counterexample ? `- Counterexample: \`${counterexample.case_id || counterexample.obligation || 'unknown'}\`` : '- Counterexample: none',
    '',
  ].join('\n'), 'utf8');
  return {
    summary: summaryPath,
    junit: junitPath,
    sarif: sarifPath,
    github_step_summary: githubSummaryPath,
  };
}

function aggregateMetrics(samples) {
  const byName = {};
  for (const sample of samples) {
    if (!sample || typeof sample !== 'object') continue;
    for (const [key, value] of Object.entries(sample)) {
      if (!Number.isFinite(value)) continue;
      if (!byName[key]) byName[key] = [];
      byName[key].push(value);
    }
  }
  const out = {};
  for (const [key, values] of Object.entries(byName)) {
    const sorted = values.sort((a, b) => a - b);
    out[key] = sorted[Math.floor(sorted.length / 2)];
    out[`${key}_p95`] = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  }
  return out;
}

function requiredCategories(goal) {
  const declared = asArray(goal.verify.required_categories).map(normalizeCategory).filter((category) => FORMAL_CATEGORIES.includes(category));
  return declared.length > 0 ? [...new Set(declared)] : FORMAL_CATEGORIES.slice();
}

function addCoverageVerification(goal, cases, verifications) {
  const required = requiredCategories(goal);
  const categories = new Set(cases.map((testCase) => testCase.category));
  const missing = required.filter((category) => !categories.has(category));
  if (missing.length === 0) verifications.push({ id: 'tool_coverage', status: 'pass', required_categories: required });
  else verifications.push({ id: 'tool_coverage', status: 'gap', required_categories: required, missing, message: 'not all formal/static categories have runnable cases' });
  for (const category of required) {
    if (!categories.has(category)) {
      verifications.push({ id: category, status: 'gap', message: `no ${category.replace(/_/g, ' ')} case declared` });
    }
  }
}

function addStaticAssetVerifications(goal, goalPath, verifications) {
  const assets = formalStaticAssets(goalPath);
  if (assets.presets.length > 0 || Object.keys(asObject(goal.verify.language_presets, {})).length > 0) {
    verifications.push({ id: 'language_presets', status: 'pass', presets: assets.presets });
  } else {
    verifications.push({ id: 'language_presets', status: 'gap', message: 'no language-specific formal/static presets generated' });
  }
  if (assets.templates.length > 0) {
    verifications.push({ id: 'generated_harness_templates', status: 'pass', templates: assets.templates });
  } else {
    verifications.push({ id: 'generated_harness_templates', status: 'gap', message: 'no property/fuzz harness templates generated' });
  }
  if (assets.adapters) {
    verifications.push({ id: 'tool_specific_parser', status: 'pass', adapters_path: assets.adaptersPath });
  } else {
    verifications.push({ id: 'tool_specific_parser', status: 'gap', message: 'no tool-specific parser registry generated' });
  }
  if (assets.install) {
    verifications.push({ id: 'dependency_install_guidance', status: 'pass', install_path: assets.installPath });
  } else {
    verifications.push({ id: 'dependency_install_guidance', status: 'gap', message: 'no analyzer dependency install guidance generated' });
  }
  if (assets.liveFixtures) {
    verifications.push({ id: 'live_tool_fixtures', status: 'pass', live_fixtures_path: assets.liveFixturesPath });
  } else {
    verifications.push({ id: 'live_tool_fixtures', status: 'gap', message: 'no opt-in live tool fixture guidance generated' });
  }
}

async function runFormalSuiteVerification(goal, goalPath, options = {}) {
  const cwd = options.cwd || process.cwd();
  const caseFiles = expandSimpleJsonGlob(goalPath, goal.verify.cases, cwd);
  const cases = caseFiles.map(loadCaseFile);
  const selectedCases = options.caseId ? cases.filter((testCase) => testCase.id === options.caseId) : cases;
  if (selectedCases.length === 0) {
    return {
      status: 'fail',
      verifications: [{ id: 'case_selection', status: 'fail', message: `No cases matched ${options.caseId || goal.verify.cases}` }],
      metrics: {},
      counterexample: { obligation: 'case_selection', message: `No cases matched ${options.caseId || goal.verify.cases}` },
    };
  }
  const verifications = [];
  const metrics = [];
  let counterexample = null;
  addCoverageVerification(goal, cases, verifications);
  addStaticAssetVerifications(goal, goalPath, verifications);
  for (const testCase of selectedCases) {
    const result = await verifyOneCase(goal, goalPath, testCase, cwd);
    verifications.push(...result.verifications);
    metrics.push(...result.metrics);
    if (result.counterexample && !counterexample) counterexample = result.counterexample;
  }
  const ciReports = writeFormalCiReports(goalPath, goal, selectedCases, verifications, counterexample);
  verifications.push({ id: 'ci_report_publishing', status: 'pass', reports: ciReports });
  return {
    status: counterexample ? 'fail' : 'pass',
    verifications,
    metrics: aggregateMetrics(metrics),
    counterexample,
  };
}

function caseFromCheck(check) {
  return {
    id: sanitizeId(check.id || `${check.category}-${check.tool || 'tool'}`),
    category: check.category,
    tool: check.tool || check.category,
    command: check.command || '',
    expected_exit_code: 0,
    timeout_ms: check.category === 'model_check' || check.category === 'symbolic_execution' || check.category === 'theorem_proof' ? 120000 : 60000,
    report_files: [],
    metadata: {
      source: check.source || 'scan',
      inferred: check.inferred === true,
      confidence: check.confidence,
    },
  };
}

function writeFormalSuiteAssets(goalDir, options = {}) {
  for (const dir of ['cases', 'actual', 'diffs', 'traces', 'reports', 'proofs', 'models', 'corpus', 'security', 'normalized', 'coverage', 'templates', 'presets', 'adapters', 'install', 'ci', 'replay', 'live-fixtures']) {
    fs.mkdirSync(path.join(goalDir, dir), { recursive: true });
  }
  for (const [fileName, source] of Object.entries(PROPERTY_TEMPLATES)) {
    fs.writeFileSync(path.join(goalDir, 'templates', fileName), source, 'utf8');
  }
  writeJson(path.join(goalDir, 'adapters', 'formal-tool-adapters.json'), {
    schema: 'xoloop.formal_tool_adapters.v0.1',
    adapters: TOOL_ADAPTERS,
  });
  const supportedPresets = asObject(options.scan && options.scan.supported_language_presets, {});
  for (const [language, preset] of Object.entries(supportedPresets)) {
    writeJson(path.join(goalDir, 'presets', `${sanitizeId(language)}.json`), {
      language,
      ...preset,
    });
  }
  const installGuidance = asArray(options.scan && options.scan.tool_install_guidance);
  writeJson(path.join(goalDir, 'install', 'tool-install-guidance.json'), {
    schema: 'xoloop.formal_install_guidance.v0.1',
    guidance: installGuidance,
    supported_adapters: Object.entries(TOOL_ADAPTERS).map(([id, adapter]) => ({
      id,
      category: adapter.category,
      aliases: adapter.aliases,
      install: adapter.install,
    })),
  });
  fs.writeFileSync(path.join(goalDir, 'install', 'tool-install-guidance.md'), [
    '# Formal/static analyzer installation guidance',
    '',
    'Generated guidance is advisory. Prefer repo-native lockfiles and CI images when available.',
    '',
    ...Object.entries(TOOL_ADAPTERS).flatMap(([id, adapter]) => [
      `## ${id}`,
      '',
      ...adapter.install.map((line) => `- ${line}`),
      '',
    ]),
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(goalDir, 'live-fixtures', 'README.md'), [
    '# Opt-in live formal/static fixtures',
    '',
    'These fixtures are intended for CI jobs that have analyzer tools installed.',
    'Run `XOLOOP_RUN_FORMAL_LIVE_E2E=1 node --test plugins/xoloop/test/formal-suite-live.test.cjs` to exercise actual tools when present.',
    '',
    'Recommended live adapters: Semgrep/CodeQL for security, mypy/pyright/cargo/go test for type checks, CBMC/KLEE/TLC for counterexamples, and Coq/Lean for proof checks.',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(goalDir, 'ci', 'README.md'), [
    '# CI reports',
    '',
    'Each `xoloop-verify run` writes:',
    '',
    '- `formal-summary.json`',
    '- `formal-junit.xml`',
    '- `formal-findings.sarif`',
    '- `formal-github-step-summary.md`',
    '',
  ].join('\n'), 'utf8');
  const checks = asArray(options.scan && options.scan.checks);
  const cases = checks.length > 0 ? checks.map(caseFromCheck) : [{
    id: 'formal-smoke',
    category: 'type_check',
    tool: 'manual-placeholder',
    command: 'node -e "process.exit(0)"',
    expected_exit_code: 0,
    timeout_ms: 30000,
    metadata: {
      note: 'Replace with repo-native type checkers, linters, model checkers, symbolic execution, theorem provers, fuzz/property tests, and security analyzers.',
    },
  }];
  for (const item of cases) writeJson(path.join(goalDir, 'cases', `${sanitizeId(item.id)}.json`), item);
  fs.writeFileSync(path.join(goalDir, 'README.md'), [
    '# Formal/static verification goal',
    '',
    'Generated by `xoloop-verify create --kind formal-suite`.',
    '',
    'Cases wrap type checkers, linters, model checkers, symbolic execution,',
    'theorem provers, property/fuzz tools, and security analyzers. Passing',
    'commands become evidence; failing commands become replayable',
    'counterexamples with normalized reports, traces, coverage, corpus,',
    'artifact hashes, and diff artifacts.',
    '',
  ].join('\n'), 'utf8');
}

function buildFormalSuiteGoal(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const goalId = options.goalId || 'formal-suite';
  const scan = options.scan || scanFormalRepo(cwd);
  const required = FORMAL_CATEGORIES.slice();
  return {
    version: 0.1,
    goal_id: goalId,
    objective: 'Preserve formal/static correctness evidence while optimizing: types, lint, models, symbolic paths, proofs, fuzz/property behavior, and security analyzers.',
    interface: {
      type: 'formal',
      command: options.command || 'xoloop formal/static verification harness',
      stdin: 'none',
      stdout: 'text',
      timeout_ms: 120000,
    },
    artifacts: {
      paths: scan.artifact_paths || [],
    },
    verify: {
      kind: 'formal-suite',
      cases: 'cases/*.json',
      properties: DEFAULT_FORMAL_OBLIGATIONS,
      required_categories: required,
      language_presets: scan.language_presets || [],
      supported_language_presets: scan.supported_language_presets || {},
      tool_install_guidance: scan.tool_install_guidance || [],
      security_severity_threshold: 'high',
      coverage: {},
      scan,
      block_on_gaps: true,
    },
    metrics: {
      repeat: 1,
      targets: [
        { name: 'wall_time_ms', direction: 'minimize', threshold: 0.05 },
        { name: 'complexity_score', direction: 'minimize', threshold: 0.05 },
      ],
    },
    acceptance: {
      require_all_verifications: true,
      max_metric_regression: 0.02,
      accept_if_any_target_improves: true,
    },
  };
}

module.exports = {
  DEFAULT_FORMAL_OBLIGATIONS,
  FORMAL_CATEGORIES,
  buildFormalSuiteGoal,
  runFormalSuiteVerification,
  scanFormalRepo,
  writeFormalSuiteAssets,
};
