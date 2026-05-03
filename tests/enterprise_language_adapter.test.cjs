'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { detectProjectType } = require('../plugins/xoloop/lib/init_generator.cjs');
const { buildStarterAdapter } = require('../plugins/xoloop/lib/overnight_adapter.cjs');
const { runHostileRepoMatrix } = require('../plugins/xoloop/lib/hostile_repo_matrix.cjs');

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-enterprise-lang-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, 'utf8');
  }
  spawnSync('git', ['init'], { cwd: root, encoding: 'utf8' });
  spawnSync('git', ['add', '.'], { cwd: root, encoding: 'utf8' });
  return root;
}

test('init generator detects JVM, .NET, Swift, and C/C++ project manifests', () => {
  const cases = [
    [{ 'pom.xml': '<project />\n' }, 'java', ['mvn test'], ['java']],
    [{ 'build.gradle.kts': 'plugins {}\n' }, 'kotlin', ['gradle test'], ['kotlin', 'java']],
    [{ 'App.csproj': '<Project />\n' }, 'csharp', ['dotnet build', 'dotnet test'], ['csharp']],
    [{ 'Package.swift': '// swift-tools-version: 6.0\n' }, 'swift', ['swift test'], ['swift']],
    [{ 'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\n' }, 'cpp', ['cmake --build build', 'ctest --test-dir build --output-on-failure'], ['c', 'cpp']],
  ];

  for (const [files, type, validation, languageHints] of cases) {
    const root = makeRepo(files);
    try {
      const projectType = detectProjectType(root);
      assert.equal(projectType.type, type);
      assert.deepEqual(projectType.validation, validation);
      assert.deepEqual(projectType.languageHints, languageHints);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('starter adapter detects requested enterprise/system language hints and validations', () => {
  const root = makeRepo({
    'pom.xml': '<project />\n',
    'build.gradle.kts': 'plugins {}\n',
    'App.csproj': '<Project />\n',
    'Package.swift': '// swift-tools-version: 6.0\n',
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\n',
    'src/main/java/App.java': 'public class App {}\n',
    'src/main/kotlin/App.kt': 'class App\n',
    'src/App.cs': 'public class App {}\n',
    'Sources/App/App.swift': 'public struct App {}\n',
    'include/app.h': 'int app_value(void);\n',
    'src/app.cpp': 'int app_value() { return 1; }\n',
  });
  try {
    const adapter = buildStarterAdapter(root);
    const hints = adapter.surfaces[0].language_hints;
    for (const language of ['java', 'kotlin', 'csharp', 'swift', 'c', 'cpp']) {
      assert.ok(hints.includes(language), `${language} should be detected`);
    }
    assert.ok(adapter.defaults.repo_scan_hint.detected_manifests.includes('pom.xml'));
    assert.ok(adapter.defaults.repo_scan_hint.detected_manifests.includes('build.gradle.kts'));
    assert.ok(adapter.defaults.repo_scan_hint.detected_manifests.includes('App.csproj'));
    assert.ok(adapter.defaults.repo_scan_hint.detected_manifests.includes('Package.swift'));
    assert.ok(adapter.defaults.repo_scan_hint.detected_manifests.includes('CMakeLists.txt'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hostile repo matrix includes JVM, .NET, Swift, and C/C++ fixtures', async () => {
  const report = await runHostileRepoMatrix({ stacks: ['java', 'kotlin', 'csharp', 'swift', 'c', 'cpp'] });

  assert.equal(report.stackCount, 6);
  for (const stackId of ['java', 'kotlin', 'csharp', 'swift', 'c', 'cpp']) {
    const result = report.results.find((entry) => entry.stackId === stackId);
    assert.ok(result, `${stackId} fixture should run`);
    assert.ok(result.inferred.languageHints.includes(stackId) || (stackId === 'cpp' && result.inferred.languageHints.includes('c')));
  }
});
