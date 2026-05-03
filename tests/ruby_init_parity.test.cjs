'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  detectProjectType,
  generateAdapter,
} = require('../plugins/xoloop/lib/init_generator.cjs');
const {
  buildStarterAdapter,
} = require('../plugins/xoloop/lib/overnight_adapter.cjs');
const {
  runHostileRepoMatrix,
} = require('../plugins/xoloop/lib/hostile_repo_matrix.cjs');
const {
  summarizeCompleteness,
} = require('../plugins/xoloop/lib/completeness_checker.cjs');

function writeFile(root, rel, content) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function makeRubyRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-ruby-init-'));
  writeFile(root, 'Gemfile', 'source "https://rubygems.org"\ngem "rspec"\n');
  writeFile(root, 'lib/widget.rb', [
    'module Widget',
    '  def self.clamp_count(value)',
    '    value.negative? ? 0 : value',
    '  end',
    'end',
    '',
  ].join('\n'));
  writeFile(root, 'spec/widget_spec.rb', [
    'require_relative "../lib/widget"',
    'RSpec.describe Widget do',
    '  it "floors negatives" do',
    '    expect(described_class.clamp_count(-1)).to eq(0)',
    '  end',
    'end',
    '',
  ].join('\n'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=Codex', '-c', 'user.email=codex@example.com', 'commit', '-m', 'fixture'], {
    cwd: root,
    stdio: 'ignore',
  });
  return root;
}

test('legacy init generator detects Ruby repos', () => {
  const root = makeRubyRepo();
  try {
    const projectType = detectProjectType(root);
    const adapter = generateAdapter(root);

    assert.equal(projectType.type, 'ruby');
    assert.deepEqual(projectType.languageHints, ['ruby']);
    assert.equal(adapter.repo.setup, 'bundle install');
    assert.deepEqual(adapter.repo.baseline_validation, ['bundle exec rspec']);
    assert.deepEqual(adapter.surfaces[0].quick_validation, ['bundle exec rspec']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('starter adapter detects Ruby source, specs, and context manifests', () => {
  const root = makeRubyRepo();
  try {
    const adapter = buildStarterAdapter(root);
    const surface = adapter.surfaces[0];

    assert.equal(adapter.repo.setup, 'bundle install');
    assert.deepEqual(adapter.repo.baseline_validation, ['bundle exec rspec']);
    assert.ok(surface.language_hints.includes('ruby'));
    assert.ok(surface.paths.includes('lib/**'));
    assert.ok(surface.test_paths.includes('spec/**'));
    assert.ok(surface.context_patterns.includes('Gemfile'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hostile repo matrix includes Ruby by default', async () => {
  const report = await runHostileRepoMatrix();
  const ruby = report.results.find((entry) => entry.stackId === 'ruby');

  assert.ok(ruby);
  assert.ok(ruby.inferred.languageHints.includes('ruby'));
  assert.equal(ruby.inferred.setup, 'bundle install');
});

test('Ruby init is no longer an incomplete parity cell', () => {
  const summary = summarizeCompleteness();

  assert.equal(
    summary.incomplete.some((entry) => entry.language === 'ruby' && entry.mode === 'init'),
    false,
  );
});
