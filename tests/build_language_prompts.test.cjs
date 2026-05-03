'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  inferBuildLanguage,
  buildLanguageBuildGuidance,
  buildLanguageTestCommand,
  buildSpecPrompt,
  buildImplementationPrompt,
} = require('../plugins/xoloop/lib/build_pipeline.cjs');

function featureFor(paths, testPaths) {
  return {
    feature: 'example feature',
    version: '1.0.0',
    acceptance: ['does the expected thing'],
    newSurface: {
      id: 'example',
      title: 'Example',
      paths,
      testPaths,
      invariants: ['deterministic'],
    },
  };
}

test('build language inference uses new surface paths before adapter hints', () => {
  assert.equal(inferBuildLanguage(featureFor(['src/example.py'], ['tests/test_example.py'])), 'python');
  assert.equal(inferBuildLanguage(featureFor(['src/lib.rs'], ['tests/example.rs'])), 'rust');
  assert.equal(inferBuildLanguage(featureFor(['example.go'], ['example_test.go'])), 'go');
  assert.equal(inferBuildLanguage(featureFor(['lib/example.rb'], ['spec/example_spec.rb'])), 'ruby');
  assert.equal(inferBuildLanguage(featureFor(['src/main/java/Example.java'], ['src/test/java/ExampleTest.java'])), 'java');
  assert.equal(inferBuildLanguage(featureFor(['src/main/kotlin/Example.kt'], ['src/test/kotlin/ExampleTest.kt'])), 'kotlin');
  assert.equal(inferBuildLanguage(featureFor(['src/Example.cs'], ['tests/ExampleTests.cs'])), 'csharp');
  assert.equal(inferBuildLanguage(featureFor(['Sources/Example/Example.swift'], ['Tests/ExampleTests/ExampleTests.swift'])), 'swift');
  assert.equal(inferBuildLanguage(featureFor(['src/example.c'], ['tests/test_example.c'])), 'c');
  assert.equal(inferBuildLanguage(featureFor(['src/example.cpp'], ['tests/example_test.cpp'])), 'cpp');
  assert.equal(
    inferBuildLanguage(featureFor([], []), { surface: { languageHints: ['ruby'] } }),
    'ruby',
  );
});

test('javascript build prompts keep existing CommonJS/node test contract', () => {
  const feature = featureFor(['src/example.cjs'], ['tests/example.test.cjs']);
  const specPrompt = buildSpecPrompt(feature, {}, null);
  const implPrompt = buildImplementationPrompt(feature, {}, "const test = require('node:test');", null);

  assert.match(specPrompt, /CommonJS \(\.cjs\) with node:test/);
  assert.match(specPrompt, /tests\/unit\/example\.test\.cjs/);
  assert.match(implPrompt, /```javascript/);
  assert.match(implPrompt, /src\/middleware\/example\.cjs/);
});

test('python build prompts use pytest instead of CommonJS/node test', () => {
  const feature = featureFor(['src/example.py'], ['tests/test_example.py']);
  const specPrompt = buildSpecPrompt(feature, {}, null);
  const implPrompt = buildImplementationPrompt(feature, {}, 'def test_example(): pass', null);

  assert.match(specPrompt, /Use pytest/);
  assert.match(specPrompt, /tests\/test_example\.py/);
  assert.doesNotMatch(specPrompt, /CommonJS|node:test/);
  assert.match(implPrompt, /```python/);
  assert.match(implPrompt, /src\/example\.py/);
});

test('rust build prompts use cargo test guidance', () => {
  const feature = featureFor(['src/lib.rs'], ['tests/example.rs']);
  const specPrompt = buildSpecPrompt(feature, {}, null);
  const implPrompt = buildImplementationPrompt(feature, {}, '#[test]\nfn example() {}', null);

  assert.match(specPrompt, /Use cargo test/);
  assert.match(specPrompt, /tests\/example\.rs/);
  assert.doesNotMatch(specPrompt, /CommonJS|node:test/);
  assert.match(implPrompt, /```rust/);
  assert.match(implPrompt, /src\/lib\.rs/);
});

test('go build prompts use native testing package guidance', () => {
  const feature = featureFor(['example.go'], ['example_test.go']);
  const specPrompt = buildSpecPrompt(feature, {}, null);
  const implPrompt = buildImplementationPrompt(feature, {}, 'func TestExample(t *testing.T) {}', null);

  assert.match(specPrompt, /Use Go testing/);
  assert.match(specPrompt, /example_test\.go/);
  assert.doesNotMatch(specPrompt, /CommonJS|node:test/);
  assert.match(implPrompt, /```go/);
  assert.match(implPrompt, /example\.go/);
});

test('ruby build prompts use RSpec or minitest guidance', () => {
  const feature = featureFor(['lib/example.rb'], ['spec/example_spec.rb']);
  const specPrompt = buildSpecPrompt(feature, {}, null);
  const implPrompt = buildImplementationPrompt(feature, {}, "RSpec.describe Example do\nend", null);

  assert.match(specPrompt, /Use RSpec/);
  assert.match(specPrompt, /spec\/example_spec\.rb/);
  assert.doesNotMatch(specPrompt, /CommonJS|node:test/);
  assert.match(implPrompt, /```ruby/);
  assert.match(implPrompt, /lib\/example\.rb/);
});

test('language guidance exists for every build target', () => {
  for (const language of ['javascript', 'typescript', 'python', 'rust', 'go', 'ruby', 'java', 'kotlin', 'csharp', 'swift', 'c', 'cpp']) {
    const guidance = buildLanguageBuildGuidance(language);
    assert.equal(guidance.language, language);
    assert.ok(guidance.testInstruction.length > 0);
    assert.ok(guidance.testPath.length > 0);
    assert.ok(guidance.implementationPath.length > 0);
  }
});

test('build mode chooses native red-green test commands for non-JS languages', () => {
  assert.deepEqual(
    buildLanguageTestCommand('python', ['tests/test_example.py']),
    { argv: ['python3', '-m', 'pytest', 'tests/test_example.py'] },
  );
  assert.deepEqual(buildLanguageTestCommand('rust', ['tests/example.rs']), { argv: ['cargo', 'test'] });
  assert.deepEqual(buildLanguageTestCommand('go', ['example_test.go']), { argv: ['go', 'test', './...'] });
  assert.deepEqual(
    buildLanguageTestCommand('ruby', ['spec/example_spec.rb']),
    { argv: ['bundle', 'exec', 'rspec', 'spec/example_spec.rb'] },
  );
  assert.equal(buildLanguageTestCommand('javascript', ['tests/example.test.cjs']), null);
});

test('new enterprise/system language build prompts use native test ecosystems', () => {
  const cases = [
    ['java', ['src/main/java/Example.java'], ['src/test/java/ExampleTest.java'], /JUnit|src\/test\/java/, { argv: ['mvn', 'test'] }],
    ['kotlin', ['src/main/kotlin/Example.kt'], ['src/test/kotlin/ExampleTest.kt'], /kotlin\.test|src\/test\/kotlin/, { argv: ['./gradlew', 'test'] }],
    ['csharp', ['src/Example.cs'], ['tests/ExampleTests.cs'], /\.NET|xUnit|NUnit|MSTest/, { argv: ['dotnet', 'test'] }],
    ['swift', ['Sources/Example/Example.swift'], ['Tests/ExampleTests/ExampleTests.swift'], /XCTest/, { argv: ['swift', 'test'] }],
    ['c', ['src/example.c'], ['tests/test_example.c'], /native C test style/, { argv: ['ctest', '--output-on-failure'] }],
    ['cpp', ['src/example.cpp'], ['tests/example_test.cpp'], /native C\+\+ test style/, { argv: ['ctest', '--output-on-failure'] }],
  ];
  for (const [language, paths, testPaths, expectedPrompt, expectedCommand] of cases) {
    const feature = featureFor(paths, testPaths);
    const specPrompt = buildSpecPrompt(feature, {}, null);
    const implPrompt = buildImplementationPrompt(feature, {}, 'test content', null);
    assert.equal(inferBuildLanguage(feature), language);
    assert.match(specPrompt, expectedPrompt);
    assert.match(implPrompt, new RegExp(`\`\`\`${buildLanguageBuildGuidance(language).fence}`));
    assert.deepEqual(buildLanguageTestCommand(language, testPaths), expectedCommand);
  }
});
