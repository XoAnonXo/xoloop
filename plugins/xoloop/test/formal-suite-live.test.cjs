'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runGoalVerify } = require('../lib/goal_verify_runner.cjs');
const { writeGoalManifest } = require('../lib/goal_manifest.cjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-formal-live-'));
}

function commandExists(name) {
  return String(process.env.PATH || '').split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, name)));
}

function writeFile(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, 'utf8');
}

function writeLiveGoal(cwd, cases) {
  const goalDir = path.join(cwd, '.xoloop', 'goals', 'formal-live');
  for (const item of cases) {
    writeFile(path.join(goalDir, 'cases', `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`);
  }
  const goalPath = path.join(goalDir, 'goal.yaml');
  writeGoalManifest(goalPath, {
    version: 0.1,
    goal_id: 'formal-live',
    objective: 'Exercise installed formal/static analyzers end to end.',
    interface: { type: 'formal', command: 'live formal/static analyzers', stdin: 'none', stdout: 'text', timeout_ms: 180000 },
    artifacts: { paths: [] },
    verify: {
      kind: 'formal-suite',
      cases: 'cases/*.json',
      properties: ['case_present', 'tool_coverage', 'analyzer_success', 'normalized_reports', 'tool_specific_parser', 'counterexample_replay', 'ci_report_publishing'],
      required_categories: [...new Set(cases.map((item) => item.category))],
      block_on_gaps: true,
    },
    metrics: { repeat: 1, targets: [{ name: 'wall_time_ms', direction: 'minimize', threshold: 0.05 }] },
  });
  return goalPath;
}

test('formal-suite live fixtures exercise installed analyzers end to end', { skip: process.env.XOLOOP_RUN_FORMAL_LIVE_E2E === '1' ? false : 'set XOLOOP_RUN_FORMAL_LIVE_E2E=1 to run live analyzer fixtures' }, async (t) => {
  const cwd = tmpDir();
  const cases = [];

  if (commandExists('semgrep')) {
    writeFile(path.join(cwd, 'semgrep.yml'), [
      'rules:',
      '  - id: live-eqeq',
      '    pattern: $X == $X',
      '    message: redundant self comparison',
      '    severity: WARNING',
      '    languages: [javascript]',
      '',
    ].join('\n'));
    writeFile(path.join(cwd, 'src', 'app.js'), 'if (user == user) console.log("same");\n');
    cases.push({ id: 'semgrep-live', category: 'security_analysis', tool: 'semgrep', command: 'semgrep --config semgrep.yml --json src || true', report_format: 'json', severity_threshold: 'critical' });
  }

  if (commandExists('mypy')) {
    writeFile(path.join(cwd, 'typed.py'), 'value: int = "nope"\n');
    cases.push({ id: 'mypy-live', category: 'type_check', tool: 'mypy', command: 'mypy typed.py --show-error-codes || true' });
  }

  if (commandExists('pyright')) {
    writeFile(path.join(cwd, 'pyright_case.py'), 'value: int = "nope"\n');
    cases.push({ id: 'pyright-live', category: 'type_check', tool: 'pyright', command: 'pyright --outputjson pyright_case.py || true', report_format: 'json' });
  }

  if (commandExists('cargo')) {
    writeFile(path.join(cwd, 'Cargo.toml'), '[package]\nname = "xoloop_formal_live"\nversion = "0.0.0"\nedition = "2021"\n');
    writeFile(path.join(cwd, 'src', 'lib.rs'), 'pub fn value() -> i32 { "nope" }\n');
    cases.push({ id: 'cargo-live', category: 'type_check', tool: 'cargo check', command: 'cargo check --message-format=json || true', report_format: 'jsonl' });
  }

  if (cases.length === 0) {
    t.skip('no supported live formal/static analyzer tools are installed');
    return;
  }

  const goalPath = writeLiveGoal(cwd, cases);
  const { card } = await runGoalVerify(goalPath, { cwd });

  assert.equal(card.summary.by_id.normalized_reports.passed >= cases.length, true);
  assert.equal(card.summary.by_id.tool_specific_parser.passed >= cases.length, true);
  assert.equal(fs.existsSync(path.join(cwd, '.xoloop', 'goals', 'formal-live', 'ci', 'formal-junit.xml')), true);
});
