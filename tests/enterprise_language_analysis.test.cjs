'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  detectLanguage,
  scanExports,
  validateSimplifyProposal,
} = require('../plugins/xoloop/lib/xo_simplify_engine.cjs');
const {
  discoverSurfaceFiles,
  extractPublicSymbols,
} = require('../plugins/xoloop/lib/xo_docs_engine.cjs');
const { detectHotspots } = require('../plugins/xoloop/lib/hotspot_detector.cjs');
const {
  buildOptimizationPrompt,
  extractTargetPaths,
} = require('../plugins/xoloop/lib/improve_runner.cjs');
const {
  inferFuzzLanguage,
  buildNativeFuzzHarness,
} = require('../plugins/xoloop/lib/fuzz_engine.cjs');

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xoloop-enterprise-analysis-'));
}

function write(root, relativePath, content) {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
  return absolute;
}

test('simplify/docs detect public API for Java, Kotlin, C#, Swift, C, and C++', () => {
  const repo = makeRepo();
  try {
    const files = {
      'src/App.java': '/** Java API. */\npublic class App { public static int value() { return 1; } }\n',
      'src/App.kt': '/** Kotlin API. */\nclass App\nfun value(): Int = 1\n',
      'src/App.cs': '/// CSharp API.\npublic class App { public static int Value() => 1; }\n',
      'Sources/App.swift': '/// Swift API.\npublic struct App { public static func value() -> Int { 1 } }\n',
      'include/app.h': '/** C API. */\nint app_value(void);\n',
      'include/app.hpp': '/** Cpp API. */\nnamespace app { int value(); }\nclass App {};\n',
    };
    for (const [relativePath, content] of Object.entries(files)) write(repo, relativePath, content);

    assert.equal(detectLanguage(path.join(repo, 'src/App.java')), 'java');
    assert.equal(detectLanguage(path.join(repo, 'src/App.kt')), 'kotlin');
    assert.equal(detectLanguage(path.join(repo, 'src/App.cs')), 'csharp');
    assert.equal(detectLanguage(path.join(repo, 'Sources/App.swift')), 'swift');
    assert.equal(detectLanguage(path.join(repo, 'include/app.h')), 'c');
    assert.equal(detectLanguage(path.join(repo, 'include/app.hpp')), 'cpp');

    for (const relativePath of Object.keys(files)) {
      assert.ok(scanExports(path.join(repo, relativePath)).exports.size > 0, `${relativePath} should expose public symbols`);
    }
    assert.deepEqual(discoverSurfaceFiles(repo).sort(), Object.keys(files).sort());
    assert.ok(extractPublicSymbols(path.join(repo, 'src/App.java')).symbols.some((symbol) => symbol.name === 'App'));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('simplify blocks deletion of public symbols in new language families', () => {
  const repo = makeRepo();
  try {
    write(repo, 'src/App.cs', 'public class App { public static int Value() => 1; }\n');
    const result = validateSimplifyProposal({
      changeSet: [{
        kind: 'replace_once',
        path: 'src/App.cs',
        match: 'public class App { public static int Value() => 1; }',
        replace: '',
      }],
    }, repo);

    assert.equal(result.ok, false);
    assert.match(result.reason, /src\/App\.cs:App/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('improve and hotspot detection cover enterprise/system languages', () => {
  const repo = makeRepo();
  try {
    write(repo, 'src/App.java', 'import java.util.List;\nimport java.util.List;\npublic class App {}\n');
    write(repo, 'src/App.cs', 'using System;\nusing System;\npublic class App {}\n');
    write(repo, 'Sources/App.swift', 'import Foundation\nimport Foundation\npublic struct App {}\n');
    write(repo, 'include/app.hpp', '#include <vector>\n#include <vector>\nint app_value();\n');

    assert.ok(detectHotspots(fs.readFileSync(path.join(repo, 'src/App.java'), 'utf8'), { language: 'java' }).some((spot) => spot.module === 'java.util.List'));
    assert.ok(detectHotspots(fs.readFileSync(path.join(repo, 'src/App.cs'), 'utf8'), { language: 'csharp' }).some((spot) => spot.module === 'System'));
    assert.ok(detectHotspots(fs.readFileSync(path.join(repo, 'Sources/App.swift'), 'utf8'), { language: 'swift' }).some((spot) => spot.module === 'Foundation'));
    assert.ok(detectHotspots(fs.readFileSync(path.join(repo, 'include/app.hpp'), 'utf8'), { language: 'cpp' }).some((spot) => spot.module === 'vector'));

    const targets = extractTargetPaths({
      cases: [
        { entry_point: { command: 'mvn test src/App.java' } },
        { entry_point: { command: 'dotnet test App.csproj src/App.cs' } },
        { entry_point: { command: 'swift test Sources/App.swift' } },
        { entry_point: { command: 'ctest include/app.hpp' } },
      ],
    }, repo).map((target) => path.relative(repo, target).replace(/\\/g, '/')).sort();
    assert.deepEqual(targets, ['Sources/App.swift', 'include/app.hpp', 'src/App.cs', 'src/App.java']);

    const prompt = buildOptimizationPrompt({
      sourceFiles: [{ path: 'src/App.cs', content: 'public class App {}' }],
      hotspots: [],
      benchmark: { benchmark: 'demo', cases: [] },
      round: 1,
      priorAttempts: [],
    });
    assert.match(prompt.userPrompt, /```csharp/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('native fuzz harnesses exist for Java, Kotlin, C#, Swift, C, and C++', () => {
  const cases = [
    ['App.java', 'java', /JUnit|junit/i, ['mvn', 'test']],
    ['App.kt', 'kotlin', /kotlin\.test/, ['./gradlew', 'test']],
    ['App.cs', 'csharp', /Xunit|Fact/, ['dotnet', 'test']],
    ['App.swift', 'swift', /XCTest/, ['swift', 'test']],
    ['app.c', 'c', /assert/, ['ctest', '--output-on-failure']],
    ['app.cpp', 'cpp', /std::vector/, ['ctest', '--output-on-failure']],
  ];
  for (const [modulePath, language, contentRe, command] of cases) {
    assert.equal(inferFuzzLanguage(modulePath), language);
    const harness = buildNativeFuzzHarness(modulePath, { language, targetName: 'app' });
    assert.equal(harness.language, language);
    assert.match(harness.content, contentRe);
    assert.deepEqual(harness.command.argv, command);
  }
});
