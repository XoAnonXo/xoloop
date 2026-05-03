'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildOptimizationPrompt,
  detectSourceLanguage,
  extractTargetPaths,
} = require('../plugins/xoloop/lib/improve_runner.cjs');

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-improve-targets-'));
}

function touch(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('improve target extraction finds source files for Python, Rust, Go, and Ruby benchmark commands', () => {
  const repo = makeRepo();
  try {
    touch(path.join(repo, 'pkg/tool.py'), 'def run(): pass\n');
    touch(path.join(repo, 'src/lib.rs'), 'pub fn run() {}\n');
    touch(path.join(repo, 'cmd/tool/main.go'), 'package main\n');
    touch(path.join(repo, 'lib/tool.rb'), 'def run; end\n');

    const benchmark = {
      cases: [
        { entry_point: { command: 'python3 pkg/tool.py' } },
        { entry_point: { command: 'cargo run --manifest-path Cargo.toml -- src/lib.rs' } },
        { entry_point: { command: 'go test ./... ./cmd/tool/main.go' } },
        { entry_point: { command: "ruby -e \"require 'tool'\"" } },
      ],
    };

    const relTargets = extractTargetPaths(benchmark, repo)
      .map((target) => path.relative(repo, target).replace(/\\/g, '/'))
      .sort();

    assert.deepEqual(relTargets, ['cmd/tool/main.go', 'lib/tool.rb', 'pkg/tool.py', 'src/lib.rs']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('improve target extraction resolves Python module entry points', () => {
  const repo = makeRepo();
  try {
    touch(path.join(repo, 'pkg/runner.py'), 'def main(): pass\n');
    touch(path.join(repo, 'pkg/app/__init__.py'), 'def main(): pass\n');

    const benchmark = {
      cases: [
        { entry_point: { command: 'python -m pkg.runner' } },
        { entry_point: { command: 'python3 -m pkg.app' } },
      ],
    };

    const relTargets = extractTargetPaths(benchmark, repo)
      .map((target) => path.relative(repo, target).replace(/\\/g, '/'))
      .sort();

    assert.deepEqual(relTargets, ['pkg/app/__init__.py', 'pkg/runner.py']);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('optimization prompt uses source language fences instead of forcing javascript', () => {
  const prompt = buildOptimizationPrompt({
    round: 1,
    hotspots: [],
    sourceFiles: [
      { path: 'pkg/tool.py', content: 'def run(): pass' },
      { path: 'src/lib.rs', content: 'pub fn run() {}' },
      { path: 'cmd/tool/main.go', content: 'package main' },
      { path: 'lib/tool.rb', content: 'def run; end' },
    ],
    benchmark: { benchmark: 'demo', cases: [] },
    priorAttempts: [],
  });

  assert.equal(detectSourceLanguage('pkg/tool.py'), 'python');
  assert.match(prompt.userPrompt, /```python\n/);
  assert.match(prompt.userPrompt, /```rust\n/);
  assert.match(prompt.userPrompt, /```go\n/);
  assert.match(prompt.userPrompt, /```ruby\n/);
});
