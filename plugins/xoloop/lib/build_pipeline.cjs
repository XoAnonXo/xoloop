/**
 * build_pipeline.cjs — Serialized TDD Pipeline for BUILD mode.
 *
 * Takes a feature.yaml and produces a complete implementation with tests via
 * a two-agent serialized TDD pipeline:
 *
 *   Agent A (Spec Writer): reads acceptance criteria + exemplar → outputs test file
 *   Engine: confirms ALL tests FAIL (red baseline — no implementation yet)
 *   Agent B (Builder): reads spec + failing tests + exemplar → outputs implementation
 *   Engine: confirms ALL tests PASS (green) via red→green delta validation
 *
 * The pipeline does NOT commit — it writes a review bundle JSON for the CLI
 * checkpoint to approve/reject.
 *
 * See ARCHITECTURE.md §6.5 "Serialized TDD Pipeline".
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { extractJsonObjectFromText, ensureDir, writeJsonAtomic, nowIso } = require('./baton_common.cjs');
const { loadFeature } = require('./feature_loader.cjs');
const { loadOvernightAdapter } = require('./overnight_adapter.cjs');
const { applyOperationSet, normalizeOperationSet } = require('./operation_ir.cjs');
const { validateRedGreenDelta, runTestsInDir } = require('./delta_validator.cjs');
const { callModel } = require('./model_router.cjs');
const { AdapterError } = require('./errors.cjs');

async function callBuildAgent({ liveAgentProvider, proposerConfig, role, language, systemPrompt, userPrompt, context }) {
  if (liveAgentProvider && typeof liveAgentProvider.call === 'function') {
    return liveAgentProvider.call({
      mode: 'build',
      role,
      language,
      requestKind: role,
      systemPrompt,
      userPrompt,
      context,
      schema: { type: 'json_object' },
    });
  }
  return callModel({
    ...proposerConfig,
    systemPrompt,
    userPrompt,
  });
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const LANGUAGE_BY_EXTENSION = new Map([
  ['.cjs', 'javascript'],
  ['.mjs', 'javascript'],
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.py', 'python'],
  ['.rs', 'rust'],
  ['.go', 'go'],
  ['.rb', 'ruby'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.cs', 'csharp'],
  ['.swift', 'swift'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cc', 'cpp'],
  ['.cpp', 'cpp'],
  ['.cxx', 'cpp'],
  ['.hpp', 'cpp'],
  ['.hh', 'cpp'],
]);

function collectBuildSurfacePaths(feature) {
  const surface = feature && feature.newSurface && typeof feature.newSurface === 'object'
    ? feature.newSurface
    : {};
  return [
    ...(Array.isArray(surface.paths) ? surface.paths : []),
    ...(Array.isArray(surface.testPaths) ? surface.testPaths : []),
  ].filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function inferBuildLanguage(feature, adapter = {}) {
  const surfacePaths = collectBuildSurfacePaths(feature);
  for (const surfacePath of surfacePaths) {
    const lower = surfacePath.toLowerCase();
    if (lower === 'cargo.toml' || lower.includes('/cargo.toml')) return 'rust';
    if (lower === 'gemfile' || lower.endsWith('.gemspec')) return 'ruby';
    if (lower === 'pom.xml' || lower.endsWith('/pom.xml')) return 'java';
    if (lower === 'build.gradle.kts' || lower.endsWith('/build.gradle.kts') || lower.endsWith('.kt')) return 'kotlin';
    if (lower === 'build.gradle' || lower.endsWith('/build.gradle') || lower === 'settings.gradle' || lower.endsWith('/settings.gradle')) return 'java';
    if (lower.endsWith('.csproj') || lower.endsWith('.sln')) return 'csharp';
    if (lower === 'package.swift' || lower.endsWith('/package.swift') || lower.endsWith('.xcodeproj') || lower.endsWith('.xcworkspace')) return 'swift';
    if (['cmakelists.txt', 'makefile', 'meson.build', 'build.bazel'].includes(path.basename(lower))) return 'cpp';
    const ext = path.extname(lower);
    if (LANGUAGE_BY_EXTENSION.has(ext)) return LANGUAGE_BY_EXTENSION.get(ext);
  }

  const adapterHints = adapter && adapter.surface && Array.isArray(adapter.surface.languageHints)
    ? adapter.surface.languageHints
    : [];
  for (const hint of adapterHints) {
    const normalized = typeof hint === 'string' ? hint.toLowerCase() : '';
    if (['javascript', 'typescript', 'python', 'rust', 'go', 'ruby', 'java', 'kotlin', 'csharp', 'swift', 'c', 'cpp'].includes(normalized)) {
      return normalized;
    }
  }

  return 'javascript';
}

function buildLanguageBuildGuidance(language) {
  switch (language) {
    case 'typescript':
      return {
        language: 'typescript',
        testInstruction: 'Use the repository TypeScript test style. Prefer .test.ts files and import/export syntax that matches the existing project.',
        testPath: 'tests/example.test.ts',
        testContent: "import { strict as assert } from 'node:assert';\n...",
        implementationPath: 'src/example.ts',
        implementationContent: 'export function example() {\\n  ...\\n}\\n',
        fence: 'typescript',
      };
    case 'python':
      return {
        language: 'python',
        testInstruction: 'Use pytest. Create tests/test_*.py files, import the target module, and use plain assert statements.',
        testPath: 'tests/test_example.py',
        testContent: 'from src.example import example\n\ndef test_example():\n    assert example() == "expected"\n',
        implementationPath: 'src/example.py',
        implementationContent: 'def example():\n    ...\n',
        fence: 'python',
      };
    case 'rust':
      return {
        language: 'rust',
        testInstruction: 'Use cargo test. Prefer integration tests under tests/*.rs, or #[test] module tests when the feature belongs inside a crate module.',
        testPath: 'tests/example.rs',
        testContent: 'use crate_name::example;\n\n#[test]\nfn example_works() {\n    assert_eq!(example(), "expected");\n}\n',
        implementationPath: 'src/lib.rs',
        implementationContent: 'pub fn example() -> String {\n    ...\n}\n',
        fence: 'rust',
      };
    case 'go':
      return {
        language: 'go',
        testInstruction: 'Use Go testing. Create *_test.go files with package-compatible imports and functions named TestXxx.',
        testPath: 'example_test.go',
        testContent: 'package example\n\nimport "testing"\n\nfunc TestExample(t *testing.T) {\n    if got := Example(); got != "expected" {\n        t.Fatalf("got %q", got)\n    }\n}\n',
        implementationPath: 'example.go',
        implementationContent: 'package example\n\nfunc Example() string {\n    ...\n}\n',
        fence: 'go',
      };
    case 'ruby':
      return {
        language: 'ruby',
        testInstruction: 'Use RSpec when the repo has spec/ paths; otherwise use minitest. Prefer spec/**/*_spec.rb for RSpec projects.',
        testPath: 'spec/example_spec.rb',
        testContent: "require 'example'\n\nRSpec.describe Example do\n  it 'works' do\n    expect(described_class.call).to eq('expected')\n  end\nend\n",
        implementationPath: 'lib/example.rb',
        implementationContent: 'class Example\n  def self.call\n    ...\n  end\nend\n',
        fence: 'ruby',
      };
    case 'java':
      return {
        language: 'java',
        testInstruction: 'Use the repository JVM test style. Prefer JUnit tests under src/test/java and implementation under src/main/java.',
        testPath: 'src/test/java/com/example/ExampleTest.java',
        testContent: 'import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;\n\nclass ExampleTest {\n  @Test void works() { assertEquals("expected", Example.value()); }\n}\n',
        implementationPath: 'src/main/java/com/example/Example.java',
        implementationContent: 'package com.example;\n\npublic final class Example {\n  public static String value() { ... }\n}\n',
        fence: 'java',
      };
    case 'kotlin':
      return {
        language: 'kotlin',
        testInstruction: 'Use the repository Kotlin/JVM test style. Prefer kotlin.test or JUnit tests under src/test/kotlin and implementation under src/main/kotlin.',
        testPath: 'src/test/kotlin/ExampleTest.kt',
        testContent: 'import kotlin.test.Test\nimport kotlin.test.assertEquals\n\nclass ExampleTest {\n  @Test fun works() { assertEquals("expected", example()) }\n}\n',
        implementationPath: 'src/main/kotlin/Example.kt',
        implementationContent: 'fun example(): String {\n  ...\n}\n',
        fence: 'kotlin',
      };
    case 'csharp':
      return {
        language: 'csharp',
        testInstruction: 'Use the repository .NET test style. Prefer xUnit/NUnit/MSTest tests in a test project and implementation in .cs files.',
        testPath: 'tests/Example.Tests/ExampleTests.cs',
        testContent: 'using Xunit;\n\npublic class ExampleTests {\n  [Fact] public void Works() { Assert.Equal("expected", Example.Value()); }\n}\n',
        implementationPath: 'src/Example/Example.cs',
        implementationContent: 'public static class Example {\n  public static string Value() => ...;\n}\n',
        fence: 'csharp',
      };
    case 'swift':
      return {
        language: 'swift',
        testInstruction: 'Use XCTest. Prefer Tests/<Target>Tests/*.swift for Swift Package projects or the existing Xcode test target layout.',
        testPath: 'Tests/ExampleTests/ExampleTests.swift',
        testContent: 'import XCTest\n@testable import Example\n\nfinal class ExampleTests: XCTestCase {\n  func testWorks() { XCTAssertEqual(Example.value(), "expected") }\n}\n',
        implementationPath: 'Sources/Example/Example.swift',
        implementationContent: 'public enum Example {\n  public static func value() -> String { ... }\n}\n',
        fence: 'swift',
      };
    case 'c':
      return {
        language: 'c',
        testInstruction: 'Use the repository native C test style. Prefer existing CMake/Make/Meson/Bazel test conventions and keep declarations in headers.',
        testPath: 'tests/test_example.c',
        testContent: '#include "example.h"\n#include <assert.h>\n\nint main(void) {\n  assert(example_value() == 42);\n  return 0;\n}\n',
        implementationPath: 'src/example.c',
        implementationContent: '#include "example.h"\n\nint example_value(void) {\n  ...\n}\n',
        fence: 'c',
      };
    case 'cpp':
      return {
        language: 'cpp',
        testInstruction: 'Use the repository native C++ test style. Prefer existing CMake/Make/Meson/Bazel test conventions and keep public declarations in headers.',
        testPath: 'tests/example_test.cpp',
        testContent: '#include "example.hpp"\n#include <cassert>\n\nint main() {\n  assert(example::value() == 42);\n}\n',
        implementationPath: 'src/example.cpp',
        implementationContent: '#include "example.hpp"\n\nnamespace example {\nint value() { ... }\n}\n',
        fence: 'cpp',
      };
    case 'javascript':
    default:
      return {
        language: 'javascript',
        testInstruction: 'Use CommonJS (.cjs) with node:test and node:assert/strict.',
        testPath: 'tests/unit/example.test.cjs',
        testContent: "const test = require('node:test');\n...",
        implementationPath: 'src/middleware/example.cjs',
        implementationContent: "'use strict';\n...",
        fence: 'javascript',
      };
  }
}

function buildLanguageTestCommand(language, testPaths = []) {
  const paths = Array.isArray(testPaths)
    ? testPaths.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  switch (language) {
    case 'python':
      return { argv: ['python3', '-m', 'pytest', ...paths] };
    case 'rust':
      return { argv: ['cargo', 'test'] };
    case 'go':
      return { argv: ['go', 'test', './...'] };
    case 'ruby': {
      const hasSpecPath = paths.some((entry) => entry.startsWith('spec/') || entry.includes('/spec/'));
      if (hasSpecPath) return { argv: ['bundle', 'exec', 'rspec', ...paths] };
      return { argv: ['bundle', 'exec', 'ruby', '-Itest', ...paths] };
    }
    case 'java':
      return { argv: ['mvn', 'test'] };
    case 'kotlin':
      return { argv: ['./gradlew', 'test'] };
    case 'csharp':
      return { argv: ['dotnet', 'test'] };
    case 'swift':
      return { argv: ['swift', 'test'] };
    case 'c':
    case 'cpp':
      return { argv: ['ctest', '--output-on-failure'] };
    case 'typescript':
    case 'javascript':
    default:
      return null;
  }
}

/**
 * Build the prompt for Agent A (Spec Writer).
 *
 * The spec writer reads the feature acceptance criteria and an optional
 * exemplar file, then outputs ONLY test-file operations (create_file).
 * Tests MUST fail without implementation — they reference functions and files
 * that don't exist yet.
 */
function buildSpecPrompt(feature, adapter, exemplarContent) {
  if (feature === null || feature === undefined || typeof feature !== 'object' || Array.isArray(feature)) {
    const received = feature === null ? 'null' : feature === undefined ? 'undefined' : Array.isArray(feature) ? 'array' : typeof feature;
    throw new AdapterError(
      'BUILD_SPEC_FEATURE_REQUIRED',
      'feature',
      `buildSpecPrompt requires a feature object, received ${received}`,
      { fixHint: 'Pass a feature object loaded via loadFeature() with feature, version, acceptance, and newSurface fields.' },
    );
  }
  if (!Array.isArray(feature.acceptance)) {
    throw new AdapterError(
      'BUILD_SPEC_ACCEPTANCE_REQUIRED',
      'feature.acceptance',
      'buildSpecPrompt requires feature.acceptance to be an array',
      { fixHint: 'Ensure the feature object has an acceptance array with at least one criterion.' },
    );
  }
  if (feature.newSurface == null || typeof feature.newSurface !== 'object' || Array.isArray(feature.newSurface)) {
    throw new AdapterError(
      'BUILD_SPEC_NEW_SURFACE_REQUIRED',
      'feature.newSurface',
      'buildSpecPrompt requires feature.newSurface to be a non-null object',
      { fixHint: 'Ensure the feature object has a newSurface object with id, title, paths, testPaths, and invariants fields.' },
    );
  }
  const guidance = buildLanguageBuildGuidance(inferBuildLanguage(feature, adapter));
  const lines = [];

  lines.push('You are Agent A — the Spec Writer in a TDD pipeline.');
  lines.push('Your job: write the test file ONLY. Do NOT write any implementation code.');
  lines.push('');
  lines.push('## Feature');
  lines.push(`Name: ${feature.feature}`);
  lines.push(`Version: ${feature.version}`);
  lines.push('');
  lines.push('## Acceptance Criteria');
  for (const criterion of feature.acceptance) {
    lines.push(`- ${criterion}`);
  }
  lines.push('');

  if (feature.constraints && feature.constraints.length > 0) {
    lines.push('## Constraints');
    for (const constraint of feature.constraints) {
      lines.push(`- ${constraint}`);
    }
    lines.push('');
  }

  lines.push('## New Surface');
  lines.push(`ID: ${feature.newSurface.id}`);
  lines.push(`Title: ${feature.newSurface.title}`);
  lines.push(`Implementation paths: ${(feature.newSurface.paths || []).join(', ')}`);
  lines.push(`Test paths: ${(feature.newSurface.testPaths || []).join(', ')}`);
  lines.push(`Invariants: ${(feature.newSurface.invariants || []).join('; ')}`);
  lines.push('');

  if (exemplarContent) {
    lines.push('## Exemplar (style template)');
    lines.push('Follow the style, structure, and conventions shown in this exemplar file:');
    lines.push('```');
    lines.push(exemplarContent);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Output format');
  lines.push('Respond with a JSON object containing an "operations" array.');
  lines.push('Each operation must be a create_file that creates a test file.');
  lines.push('Tests MUST fail without implementation — they require/import functions and files that do not exist yet.');
  lines.push('Every acceptance criterion above must be covered by at least one test.');
  lines.push(guidance.testInstruction);
  lines.push('');
  lines.push('Example response:');
  lines.push('```json');
  lines.push(JSON.stringify({
    operations: [
      {
        op: 'create_file',
        path: guidance.testPath,
        content: guidance.testContent,
      },
    ],
  }, null, 2));
  lines.push('```');

  return lines.join('\n');
}

/**
 * Build the prompt for Agent B (Builder).
 *
 * The builder reads the feature spec, the failing test file content from
 * Agent A, and the exemplar. It outputs create_file for the implementation
 * plus any insert_after/replace_exact for integration seams.
 * ALL tests must pass after the implementation is applied.
 */
function buildImplementationPrompt(feature, adapter, testContent, exemplarContent) {
  if (feature === null || feature === undefined || typeof feature !== 'object' || Array.isArray(feature)) {
    const received = feature === null ? 'null' : feature === undefined ? 'undefined' : Array.isArray(feature) ? 'array' : typeof feature;
    throw new AdapterError(
      'BUILD_IMPL_FEATURE_REQUIRED',
      'feature',
      `buildImplementationPrompt requires a feature object, received ${received}`,
      { fixHint: 'Pass a feature object loaded via loadFeature() with feature, version, acceptance, and newSurface fields.' },
    );
  }
  if (!Array.isArray(feature.acceptance)) {
    throw new AdapterError(
      'BUILD_IMPL_ACCEPTANCE_REQUIRED',
      'feature.acceptance',
      'buildImplementationPrompt requires feature.acceptance to be an array',
      { fixHint: 'Ensure the feature object has an acceptance array with at least one criterion.' },
    );
  }
  if (feature.newSurface == null || typeof feature.newSurface !== 'object' || Array.isArray(feature.newSurface)) {
    throw new AdapterError(
      'BUILD_IMPL_NEW_SURFACE_REQUIRED',
      'feature.newSurface',
      'buildImplementationPrompt requires feature.newSurface to be a non-null object',
      { fixHint: 'Ensure the feature object has a newSurface object with id, title, paths, testPaths, and invariants fields.' },
    );
  }
  if (typeof testContent !== 'string') {
    const received = testContent === null ? 'null' : testContent === undefined ? 'undefined' : typeof testContent;
    throw new AdapterError(
      'BUILD_IMPL_TEST_CONTENT_REQUIRED',
      'testContent',
      `buildImplementationPrompt requires a testContent string, received ${received}`,
      { fixHint: 'Pass the test file content string produced by the red phase (extractTestContent output).' },
    );
  }
  const guidance = buildLanguageBuildGuidance(inferBuildLanguage(feature, adapter));
  const lines = [];

  lines.push('You are Agent B — the Builder in a TDD pipeline.');
  lines.push('Agent A already wrote the tests (shown below). Your job: write the implementation that makes ALL tests pass.');
  lines.push('Do NOT modify the test files.');
  lines.push('');
  lines.push('## Feature');
  lines.push(`Name: ${feature.feature}`);
  lines.push(`Version: ${feature.version}`);
  lines.push('');
  lines.push('## Acceptance Criteria');
  for (const criterion of feature.acceptance) {
    lines.push(`- ${criterion}`);
  }
  lines.push('');

  if (feature.constraints && feature.constraints.length > 0) {
    lines.push('## Constraints');
    for (const constraint of feature.constraints) {
      lines.push(`- ${constraint}`);
    }
    lines.push('');
  }

  lines.push('## New Surface');
  lines.push(`ID: ${feature.newSurface.id}`);
  lines.push(`Title: ${feature.newSurface.title}`);
  lines.push(`Implementation paths: ${(feature.newSurface.paths || []).join(', ')}`);
  lines.push(`Test paths: ${(feature.newSurface.testPaths || []).join(', ')}`);
  lines.push(`Invariants: ${(feature.newSurface.invariants || []).join('; ')}`);
  lines.push('');

  if (feature.integrationSeams && feature.integrationSeams.length > 0) {
    lines.push('## Integration Seams');
    lines.push('These seams connect the new surface to existing code. Use insert_after or replace_exact to wire them in:');
    for (const seam of feature.integrationSeams) {
      lines.push(`- Surface "${seam.surface}", path: ${seam.path}, operation: ${seam.operation}, reason: ${seam.reason}`);
    }
    lines.push('');
  }

  lines.push('## Failing Tests (written by Agent A)');
  lines.push('These tests currently fail because the implementation does not exist. Make them all pass:');
  lines.push(`\`\`\`${guidance.fence}`);
  lines.push(testContent);
  lines.push('```');
  lines.push('');

  if (exemplarContent) {
    lines.push('## Exemplar (style template)');
    lines.push('Follow the style, structure, and conventions shown in this exemplar file:');
    lines.push('```');
    lines.push(exemplarContent);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Output format');
  lines.push('Respond with a JSON object containing an "operations" array.');
  lines.push('Use create_file for new implementation files.');
  lines.push('Use insert_after or replace_exact for integration seams in existing files.');
  lines.push('Do NOT include any test file operations — Agent A already wrote them.');
  lines.push('ALL tests must pass after your operations are applied.');
  lines.push('');
  lines.push('Example response:');
  lines.push('```json');
  lines.push(JSON.stringify({
    operations: [
      {
        op: 'create_file',
        path: guidance.implementationPath,
        content: guidance.implementationContent,
      },
    ],
  }, null, 2));
  lines.push('```');

  return lines.join('\n');
}

/**
 * Build a repair prompt for when the red or green phase fails.
 *
 * @param {string} phase - Human-readable phase label, e.g. "spec generation" or "implementation".
 * @param {string} originalPrompt - The original prompt sent to the LLM (appears under ## Original Instructions).
 * @param {string|null} testOutput - Raw test-runner output (appears under ## Test Output); pass null when no test output is available.
 * @param {string|null} errorDetail - Human-readable description of what went wrong (appears under ## Error).
 * @returns {string} Repair prompt string ready to send to the LLM.
 */
function buildRepairPrompt(phase, originalPrompt, testOutput, errorDetail) {
  if (typeof phase !== 'string' || phase.trim().length === 0) {
    const received = phase === null ? 'null' : phase === undefined ? 'undefined' : typeof phase === 'string' ? (phase.length === 0 ? 'empty string' : 'whitespace-only string') : typeof phase;
    throw new AdapterError(
      'BUILD_REPAIR_PHASE_REQUIRED',
      'phase',
      `buildRepairPrompt requires a non-empty phase string, received ${received}`,
      { fixHint: 'Pass a phase string such as "spec generation" or "implementation".' },
    );
  }
  if (typeof originalPrompt !== 'string') {
    const received = originalPrompt === null ? 'null' : originalPrompt === undefined ? 'undefined' : typeof originalPrompt;
    throw new AdapterError(
      'BUILD_REPAIR_ORIGINAL_PROMPT_REQUIRED',
      'originalPrompt',
      `buildRepairPrompt requires an originalPrompt string, received ${received}`,
      { fixHint: 'Pass the original prompt string that was sent to the LLM (e.g. the output of buildSpecPrompt or buildImplementationPrompt).' },
    );
  }
  const safeErrorDetail = typeof errorDetail === 'string' ? errorDetail : String(errorDetail ?? '(no error detail)');
  const safeTestOutput = typeof testOutput === 'string' ? testOutput : String(testOutput ?? '(no test output)');
  const lines = [];

  lines.push(`Your previous ${phase} attempt failed. Fix the issue and try again.`);
  lines.push('');
  lines.push('## Error');
  lines.push(safeErrorDetail);
  lines.push('');
  lines.push('## Test Output');
  lines.push('```');
  lines.push(safeTestOutput);
  lines.push('```');
  lines.push('');
  lines.push('## Original Instructions');
  lines.push(originalPrompt);
  lines.push('');
  lines.push('Respond with the corrected JSON object containing an "operations" array.');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

/**
 * Parse an LLM response text into a normalized operations array.
 * Handles markdown-fenced JSON and bare JSON.
 */
function parseOperationsResponse(text, phaseLabel) {
  if (typeof phaseLabel !== 'string' || phaseLabel.trim().length === 0) {
    const received = phaseLabel === null ? 'null' : phaseLabel === undefined ? 'undefined' : typeof phaseLabel === 'string' ? (phaseLabel.length === 0 ? 'empty string' : 'whitespace-only string') : typeof phaseLabel;
    throw new AdapterError(
      'BUILD_PARSE_PHASE_LABEL_REQUIRED',
      'phaseLabel',
      `parseOperationsResponse requires a non-empty phaseLabel string, received ${received}`,
      { fixHint: 'Pass a phase label string such as "spec_generation" or "implementation" to identify which pipeline phase produced the response.' },
    );
  }
  if (typeof text !== 'string') {
    const received = text === null ? 'null' : text === undefined ? 'undefined' : typeof text;
    throw new AdapterError(
      `BUILD_${phaseLabel.toUpperCase()}_FAILED`,
      'text',
      `parseOperationsResponse requires a text string, received ${received}`,
      { fixHint: `The LLM response for ${phaseLabel} must be a non-null string containing a JSON object with an "operations" array.` },
    );
  }
  let jsonText;
  try {
    jsonText = extractJsonObjectFromText(text, `${phaseLabel} response`);
  } catch (err) {
    throw new AdapterError(
      `BUILD_${phaseLabel.toUpperCase()}_FAILED`,
      'operations',
      `Failed to extract JSON from ${phaseLabel} response: ${err.message}`,
      { fixHint: `The LLM response for ${phaseLabel} must contain a JSON object with an "operations" array.`, cause: err },
    );
  }

  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch (err) {
    throw new AdapterError(
      `BUILD_${phaseLabel.toUpperCase()}_FAILED`,
      'operations',
      `Failed to parse JSON from ${phaseLabel} response: ${err.message}`,
      { fixHint: `The LLM response for ${phaseLabel} must contain valid JSON.`, cause: err },
    );
  }

  const rawOps = Array.isArray(payload.operations) ? payload.operations : [];
  if (rawOps.length === 0) {
    throw new AdapterError(
      `BUILD_${phaseLabel.toUpperCase()}_FAILED`,
      'operations',
      `${phaseLabel} response contains no operations`,
      { fixHint: `The LLM must return at least one operation in the "operations" array.` },
    );
  }

  return normalizeOperationSet(rawOps);
}

// ---------------------------------------------------------------------------
// Review bundle writer
// ---------------------------------------------------------------------------

/**
 * Write the review bundle to disk as JSON for the CLI checkpoint to read.
 *
 * @param {string} outputDir - Absolute path to the directory where the bundle will be written.
 * @param {string} featureId - The feature surface id (e.g. feature.newSurface.id).
 * @param {{ status: string, proposal: object|null, delta: object|null, error: string|null }} result - Pipeline result object.
 * @returns {string} Absolute path to the written bundle JSON file.
 * @throws {AdapterError} BUILD_REVIEW_OUTPUTDIR_REQUIRED if outputDir is null/empty/non-string.
 * @throws {AdapterError} BUILD_REVIEW_FEATUREID_REQUIRED if featureId is null/empty/non-string.
 * @throws {AdapterError} BUILD_REVIEW_RESULT_REQUIRED if result is null/non-object.
 * @throws {AdapterError} BUILD_REVIEW_WRITE_FAILED if the file cannot be written.
 */
function writeReviewBundle(outputDir, featureId, result) {
  if (!outputDir || typeof outputDir !== 'string') {
    const received = outputDir === null ? 'null' : outputDir === undefined ? 'undefined' : typeof outputDir === 'string' ? 'empty string' : typeof outputDir;
    throw new AdapterError(
      'BUILD_REVIEW_OUTPUTDIR_REQUIRED',
      'outputDir',
      `writeReviewBundle requires a non-empty outputDir string, received ${received}`,
      { fixHint: 'Pass an absolute directory path as the outputDir argument (e.g. path.join(repoRoot, "reports", "features")).' },
    );
  }
  if (featureId == null || typeof featureId !== 'string' || featureId.trim().length === 0) {
    const received = featureId === null ? 'null' : featureId === undefined ? 'undefined' : typeof featureId === 'string' ? (featureId.length === 0 ? 'empty string' : 'whitespace-only string') : typeof featureId;
    throw new AdapterError(
      'BUILD_REVIEW_FEATUREID_REQUIRED',
      'featureId',
      `writeReviewBundle requires a non-empty featureId string, received ${received}`,
      { fixHint: 'Pass the feature surface id (e.g. feature.newSurface.id) as the featureId argument.' },
    );
  }
  if (result === null || result === undefined || typeof result !== 'object' || Array.isArray(result)) {
    const received = result === null ? 'null' : result === undefined ? 'undefined' : Array.isArray(result) ? 'array' : typeof result;
    throw new AdapterError(
      'BUILD_REVIEW_RESULT_REQUIRED',
      'result',
      `writeReviewBundle requires a result object, received ${received}`,
      { fixHint: 'Pass an object with status, proposal, delta, and error fields as the result argument.' },
    );
  }
  try {
    // Audit P2: feature_checkpoint.bundlePath reads from
    //   <reportsDir>/<featureId>/review-bundle.json
    // but writeReviewBundle used to write to
    //   <outputDir>/<featureId>-review-bundle.json (flat)
    // so every BUILD proposal became unreachable through the approval flow.
    // Write into the nested layout the checkpoint already consumes.
    const featureDir = path.join(outputDir, featureId);
    ensureDir(featureDir);
    const bundlePath = path.join(featureDir, 'review-bundle.json');
    const bundle = {
      featureId,
      status: result.status || null,
      createdAt: nowIso(),
      proposal: result.proposal || null,
      delta: result.delta || null,
      error: result.error || null,
    };
    writeJsonAtomic(bundlePath, bundle);
    return bundlePath;
  } catch (err) {
    throw new AdapterError(
      'BUILD_REVIEW_WRITE_FAILED',
      'outputDir',
      `Failed to write review bundle: ${err.message}`,
      { fixHint: `Ensure the output directory ${outputDir} is writable.`, cause: err },
    );
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Run the BUILD TDD pipeline.
 *
 * 1. Load feature.yaml via loadFeature()
 * 2. Load exemplar file content if specified
 * 3. Call LLM with buildSpecPrompt() -> parse response as test operations
 * 4. Apply test operations to a temp directory
 * 5. Run tests -> confirm ALL FAIL (red phase)
 *    - If any pass: repair prompt -> retry up to maxRepairTurns
 * 6. Call LLM with buildImplementationPrompt() -> parse response as code operations
 * 7. Apply code + test operations together to a clean temp directory
 * 8. Run delta validation (red->green)
 *    - If delta fails: repair prompt -> retry
 * 9. Write review bundle to outputDir
 * 10. Return result with status 'awaiting_approval'
 */
async function runBuildPipeline(opts = {}) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    const received = opts === null ? 'null' : Array.isArray(opts) ? 'array' : typeof opts;
    throw new AdapterError(
      'BUILD_PIPELINE_OPTIONS_REQUIRED',
      'options',
      `runBuildPipeline requires an options object, received ${received}`,
      { fixHint: 'Pass an object with featurePath, adapterPath, repoRoot, proposerConfig, and outputDir.' },
    );
  }
  const {
    featurePath,
    adapterPath,
    repoRoot,
    proposerConfig,
    liveAgentProvider,
    outputDir,
    maxRepairTurns = 3,
  } = opts;
  const resolvedRepoRoot = path.resolve(repoRoot || process.cwd());

  // --- 1. Load adapter + feature.yaml ---
  let adapter;
  try {
    adapter = loadOvernightAdapter(adapterPath || 'overnight.yaml', { repoRoot: resolvedRepoRoot });
  } catch (err) {
    return {
      status: 'build_failed',
      featureId: null,
      proposal: { operations: [], testOperations: [] },
      delta: { ok: false, red: null, green: null, full: null },
      reviewBundlePath: null,
      error: `Failed to load adapter: ${err.message || String(err)}`,
    };
  }

  let feature;
  try {
    feature = loadFeature(featurePath, adapter, { repoRoot: resolvedRepoRoot });
  } catch (err) {
    return {
      status: 'build_failed',
      featureId: null,
      proposal: { operations: [], testOperations: [] },
      delta: { ok: false, red: null, green: null, full: null },
      reviewBundlePath: null,
      error: err.message || String(err),
    };
  }

  const featureId = feature.newSurface.id;
  const resolvedOutputDir = path.resolve(outputDir || path.join(resolvedRepoRoot, 'reports', 'features'));

  // --- 2. Load exemplar file content ---
  let exemplarContent = null;
  if (feature.exemplar) {
    const exemplarAbsolute = path.resolve(resolvedRepoRoot, feature.exemplar);
    try {
      exemplarContent = fs.readFileSync(exemplarAbsolute, 'utf8');
    } catch (_err) {
      // Exemplar is optional for the pipeline — a missing one was already validated by loadFeature
      exemplarContent = null;
    }
  }

  // --- 3. Agent A: Generate test operations ---
  const specPrompt = buildSpecPrompt(feature, adapter, exemplarContent);
  const buildLanguage = inferBuildLanguage(feature, adapter);
  let testOperations;
  try {
    const specResponse = await callBuildAgent({
      liveAgentProvider,
      proposerConfig,
      role: 'spec-writer',
      language: buildLanguage,
      systemPrompt: 'You are a TDD spec writer. Output ONLY JSON.',
      userPrompt: specPrompt,
      context: { featureId, phase: 'spec_generation' },
    });
    testOperations = parseOperationsResponse(specResponse.text, 'spec_generation');
  } catch (err) {
    return buildFailureResult(featureId, resolvedOutputDir, err);
  }

  // --- 4 & 5. Red phase: apply tests, confirm ALL FAIL ---
  let testContent;
  try {
    const redResult = await runRedPhase({
      testOperations,
      feature,
      adapter,
      exemplarContent,
      proposerConfig,
      liveAgentProvider,
      specPrompt,
      repoRoot: resolvedRepoRoot,
      maxRepairTurns,
    });
    testOperations = redResult.testOperations;
    testContent = redResult.testContent;
  } catch (err) {
    return buildFailureResult(featureId, resolvedOutputDir, err);
  }

  // --- 6. Agent B: Generate implementation operations ---
  const implPrompt = buildImplementationPrompt(feature, adapter, testContent, exemplarContent);
  let codeOperations;
  try {
    const implResponse = await callBuildAgent({
      liveAgentProvider,
      proposerConfig,
      role: 'implementation-builder',
      language: buildLanguage,
      systemPrompt: 'You are a TDD implementation builder. Output ONLY JSON.',
      userPrompt: implPrompt,
      context: { featureId, phase: 'implementation' },
    });
    codeOperations = parseOperationsResponse(implResponse.text, 'implementation');
  } catch (err) {
    return buildFailureResult(featureId, resolvedOutputDir, err);
  }

  // --- 7 & 8. Green phase: apply code + tests, run delta validation ---
  let delta;
  try {
    const greenResult = await runGreenPhase({
      testOperations,
      codeOperations,
      feature,
      adapter,
      exemplarContent,
      testContent,
      proposerConfig,
      liveAgentProvider,
      implPrompt,
      repoRoot: resolvedRepoRoot,
      maxRepairTurns,
    });
    codeOperations = greenResult.codeOperations;
    delta = greenResult.delta;
  } catch (err) {
    return buildFailureResult(featureId, resolvedOutputDir, err);
  }

  // --- 9. Write review bundle ---
  const result = {
    status: 'awaiting_approval',
    featureId,
    proposal: {
      operations: codeOperations,
      testOperations,
    },
    delta,
    reviewBundlePath: null,
    error: null,
  };

  try {
    result.reviewBundlePath = writeReviewBundle(resolvedOutputDir, featureId, result);
  } catch (err) {
    return buildFailureResult(featureId, resolvedOutputDir, err);
  }

  // --- 10. Return result ---
  return result;
}

// ---------------------------------------------------------------------------
// Internal phase helpers
// ---------------------------------------------------------------------------

/**
 * Red phase: apply test operations to a temp dir and verify ALL tests fail.
 * Retries up to maxRepairTurns if any test unexpectedly passes.
 */
async function runRedPhase({
  testOperations,
  feature,
  adapter,
  exemplarContent: _exemplarContent,
  proposerConfig,
  liveAgentProvider,
  specPrompt,
  repoRoot: _repoRoot,
  maxRepairTurns,
}) {
  let currentTestOps = testOperations;

  for (let turn = 0; turn <= maxRepairTurns; turn += 1) {
    // Create a temp directory and copy repo contents for isolation
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-red-'));

    try {
      applyOperationSet(currentTestOps, { cwd: tmpDir });
    } catch (applyErr) {
      cleanupTempDir(tmpDir);
      if (turn === maxRepairTurns) {
        throw new AdapterError(
          'BUILD_RED_PHASE_FAILED',
          'testOperations',
          `Failed to apply test operations: ${applyErr.message}`,
          { fixHint: 'The test operations produced by Agent A could not be applied.', cause: applyErr },
        );
      }
      // Retry with repair prompt
      const repairPrompt = buildRepairPrompt(
        'spec generation',
        specPrompt,
        null,
        `Test operations failed to apply: ${applyErr.message}`,
      );
      const repairResponse = await callBuildAgent({
        liveAgentProvider,
        proposerConfig,
        role: 'spec-repair',
        systemPrompt: 'You are a TDD spec writer. Output ONLY JSON.',
        userPrompt: repairPrompt,
        context: { phase: 'spec_generation_repair' },
      });
      currentTestOps = parseOperationsResponse(repairResponse.text, 'spec_generation');
      continue;
    }

    // Run tests in the temp dir — they should ALL fail
    const testPaths = feature.newSurface.testPaths;
    const language = inferBuildLanguage(feature, adapter);
    const testCommand = buildLanguageTestCommand(language, testPaths);
    const testResult = runTestsInDir(testPaths, tmpDir, { testCommand });

    cleanupTempDir(tmpDir);

    if (testResult.passed === 0 && testResult.total > 0) {
      // All tests fail — red phase passes
      const testContent = extractTestContent(currentTestOps);
      return { testOperations: currentTestOps, testContent };
    }

    if (testResult.total === 0) {
      // No tests detected — tests may not have run
      if (turn === maxRepairTurns) {
        throw new AdapterError(
          'BUILD_RED_PHASE_FAILED',
          'testOperations',
          'No tests were detected in the generated test files',
          { fixHint: 'Agent A must produce test files that contain at least one test.' },
        );
      }
      const repairPrompt = buildRepairPrompt(
        'spec generation',
        specPrompt,
        testResult.output || '(no output)',
        'No tests were detected. Ensure the generated test file uses the native test framework for this feature language and contains at least one test.',
      );
      const repairResponse = await callBuildAgent({
        liveAgentProvider,
        proposerConfig,
        role: 'spec-repair',
        systemPrompt: 'You are a TDD spec writer. Output ONLY JSON.',
        userPrompt: repairPrompt,
        context: { phase: 'spec_generation_repair' },
      });
      currentTestOps = parseOperationsResponse(repairResponse.text, 'spec_generation');
      continue;
    }

    // Some tests passed — they are vacuous
    if (turn === maxRepairTurns) {
      throw new AdapterError(
        'BUILD_RED_PHASE_FAILED',
        'testOperations',
        `${testResult.passed} test(s) passed without implementation — tests are vacuous`,
        { fixHint: 'All tests must fail before the implementation is written. Vacuous tests prove nothing.' },
      );
    }

    const repairPrompt = buildRepairPrompt(
      'spec generation',
      specPrompt,
      testResult.output,
      `${testResult.passed} test(s) passed without implementation — these tests are vacuous. ` +
      'Tests must import/require functions that do not exist yet so they fail at the module level.',
    );
    const repairResponse = await callBuildAgent({
      liveAgentProvider,
      proposerConfig,
      role: 'spec-repair',
      systemPrompt: 'You are a TDD spec writer. Output ONLY JSON.',
      userPrompt: repairPrompt,
      context: { phase: 'spec_generation_repair' },
    });
    currentTestOps = parseOperationsResponse(repairResponse.text, 'spec_generation');
  }

  // Should not reach here due to the throw inside the loop, but just in case
  throw new AdapterError(
    'BUILD_RED_PHASE_FAILED',
    'testOperations',
    'Red phase exhausted all repair turns',
    { fixHint: 'Increase maxRepairTurns or simplify the feature.' },
  );
}

/**
 * Green phase: apply code + test operations together and validate the
 * red->green delta.
 */
async function runGreenPhase({
  testOperations,
  codeOperations,
  feature,
  adapter,
  exemplarContent: _exemplarContent,
  testContent: _testContent,
  proposerConfig,
  liveAgentProvider,
  implPrompt,
  repoRoot: _repoRoot,
  maxRepairTurns,
}) {
  let currentCodeOps = codeOperations;

  for (let turn = 0; turn <= maxRepairTurns; turn += 1) {
    // Create two temp dirs: baseDir (tests only) and candidateDir (tests + code)
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-base-'));
    const candidateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cand-'));

    try {
      // Apply test-only operations to baseDir
      applyOperationSet(testOperations, { cwd: baseDir });

      // Apply tests + code to candidateDir
      applyOperationSet([...testOperations, ...currentCodeOps], { cwd: candidateDir });
    } catch (applyErr) {
      cleanupTempDir(baseDir);
      cleanupTempDir(candidateDir);
      if (turn === maxRepairTurns) {
        throw new AdapterError(
          'BUILD_DELTA_FAILED',
          'codeOperations',
          `Failed to apply operations: ${applyErr.message}`,
          { fixHint: 'The operations produced by Agent B could not be applied.', cause: applyErr },
        );
      }
      const repairPrompt = buildRepairPrompt(
        'implementation',
        implPrompt,
        null,
        `Operations failed to apply: ${applyErr.message}`,
      );
      const repairResponse = await callBuildAgent({
        liveAgentProvider,
        proposerConfig,
        role: 'implementation-repair',
        systemPrompt: 'You are a TDD implementation builder. Output ONLY JSON.',
        userPrompt: repairPrompt,
        context: { phase: 'implementation_repair' },
      });
      currentCodeOps = parseOperationsResponse(repairResponse.text, 'implementation');
      continue;
    }

    // Run delta validation
    const testPaths = feature.newSurface.testPaths;
    const language = inferBuildLanguage(feature, adapter);
    const testCommand = buildLanguageTestCommand(language, testPaths);
    const fullValidation = adapter.repo
      ? (adapter.repo.final_validation || adapter.repo.finalValidation || [])
      : [];

    const delta = validateRedGreenDelta({
      baseDir,
      candidateDir,
      testPaths,
      testCommand,
      fullValidation,
    });

    cleanupTempDir(baseDir);
    cleanupTempDir(candidateDir);

    if (delta.ok) {
      return { codeOperations: currentCodeOps, delta };
    }

    // Delta failed — attempt repair
    if (turn === maxRepairTurns) {
      throw new AdapterError(
        'BUILD_DELTA_FAILED',
        'codeOperations',
        delta.reason || 'Red-green delta validation failed',
        { fixHint: 'The implementation must make all new tests pass without breaking existing tests.' },
      );
    }

    const repairPrompt = buildRepairPrompt(
      'implementation',
      implPrompt,
      JSON.stringify(delta, null, 2),
      delta.reason || 'Delta validation failed — some tests still fail or existing tests broke.',
    );
    const repairResponse = await callBuildAgent({
      liveAgentProvider,
      proposerConfig,
      role: 'implementation-repair',
      systemPrompt: 'You are a TDD implementation builder. Output ONLY JSON.',
      userPrompt: repairPrompt,
      context: { phase: 'implementation_repair' },
    });
    currentCodeOps = parseOperationsResponse(repairResponse.text, 'implementation');
  }

  throw new AdapterError(
    'BUILD_DELTA_FAILED',
    'codeOperations',
    'Green phase exhausted all repair turns',
    { fixHint: 'Increase maxRepairTurns or simplify the feature.' },
  );
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text content of test files from test operations (for passing
 * to Agent B so it can see what tests it needs to make pass).
 */
function extractTestContent(testOperations) {
  return testOperations
    .filter((op) => op.op === 'create_file')
    .map((op) => `// --- ${op.path} ---\n${op.content}`)
    .join('\n\n');
}

/**
 * Clean up a temp directory (best effort).
 */
function cleanupTempDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (_err) {
    // best effort
  }
}

/**
 * Build a standardized failure result and write the review bundle.
 */
function buildFailureResult(featureId, outputDir, err) {
  const result = {
    status: 'build_failed',
    featureId,
    proposal: { operations: [], testOperations: [] },
    delta: { ok: false, red: null, green: null, full: null },
    reviewBundlePath: null,
    error: err.message || String(err),
  };

  try {
    if (featureId && outputDir) {
      result.reviewBundlePath = writeReviewBundle(outputDir, featureId, result);
    }
  } catch (_writeErr) {
    // best effort — don't mask the original error
  }

  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  inferBuildLanguage,
  buildLanguageBuildGuidance,
  buildLanguageTestCommand,
  buildSpecPrompt,
  buildImplementationPrompt,
  buildRepairPrompt,
  writeReviewBundle,
  runBuildPipeline,
  parseOperationsResponse,
};
