'use strict';

const SUPPORTED_LANGUAGES = Object.freeze([
  'javascript',
  'typescript',
  'python',
  'rust',
  'go',
  'ruby',
  'java',
  'kotlin',
  'csharp',
  'swift',
  'c',
  'cpp',
]);

const REFERENCE_LANGUAGES = Object.freeze(['javascript', 'typescript']);

const XO_MODES = Object.freeze([
  'init',
  'build',
  'simplify',
  'polish',
  'fuzz',
  'benchmark',
  'improve',
  'autoresearch',
  'audit',
  'docs',
  'overnight',
  'finalize',
]);

const USER_FACING_MODES = Object.freeze(XO_MODES.filter((mode) => mode !== 'init'));

const STATUS = Object.freeze({
  FULL: 'full',
  PARTIAL: 'partial',
  MISSING: 'missing',
  BLOCKED: 'blocked',
  SKIPPED: 'skipped',
});

const EVIDENCE_LEVEL = Object.freeze({
  LOCAL: 'local',
  LIVE_AGENTIC: 'live-agentic',
});

const LIVE_AGENTIC_MODES = Object.freeze([
  'build',
  'polish',
  'autoresearch',
  'audit',
  'overnight',
]);

function full(evidence, options = {}) {
  return {
    status: STATUS.FULL,
    evidence: Array.isArray(evidence) ? evidence.slice() : [String(evidence || 'capability implemented')],
    evidenceLevel: options.evidenceLevel || EVIDENCE_LEVEL.LOCAL,
    missing: [],
    blockedReason: null,
  };
}

function partial(evidence, missing, options = {}) {
  return {
    status: STATUS.PARTIAL,
    evidence: Array.isArray(evidence) ? evidence.slice() : [String(evidence || 'capability exists but is incomplete')],
    evidenceLevel: options.evidenceLevel || EVIDENCE_LEVEL.LOCAL,
    missing: Array.isArray(missing) ? missing.slice() : [String(missing || 'parity gap not specified')],
    blockedReason: null,
  };
}

function missing(reason) {
  return {
    status: STATUS.MISSING,
    evidence: [],
    evidenceLevel: EVIDENCE_LEVEL.LOCAL,
    missing: [String(reason || 'capability not implemented')],
    blockedReason: null,
  };
}

function fullModeMap(evidencePrefix) {
  return Object.fromEntries(
    XO_MODES.map((mode) => [mode, full(`${evidencePrefix}: ${mode}`)]),
  );
}

// This is intentionally conservative. The matrix describes what the current
// v0.3.0 plugin can prove today, not what the future adapter work promises.
const CURRENT_LANGUAGE_CAPABILITIES = Object.freeze({
  javascript: Object.freeze(fullModeMap('JS reference path is available')),
  typescript: Object.freeze({
    ...fullModeMap('TS reference path is available through JS/Node tooling'),
    fuzz: full(['native TypeScript fast-check harness generation is available', 'native TypeScript fuzz execution runs through tsx']),
  }),
  python: Object.freeze({
    init: full(['pyproject.toml / requirements.txt are detected', 'pytest validation is scaffolded']),
    build: full(['build prompts route Python features to pytest-shaped tests and .py implementation files', 'BUILD red/green validation can run python3 -m pytest']),
    simplify: full(['Python public symbols are scanned with stdlib ast-backed checks']),
    polish: full(['polish is patch-and-validation based and can run pytest']),
    fuzz: full(['Python stdlib fuzz harness generation and execution are available']),
    benchmark: full(['benchmark runner shells arbitrary entry_point commands']),
    improve: full(['benchmark execution is language-neutral', 'Python target extraction and hotspot detection are language-aware']),
    autoresearch: full(['autoresearch operates on patches, validation, and judge packets']),
    audit: full(['audit operates on patch proposals and validation gates']),
    docs: full(['Python public docs extraction uses ast-backed docstring checks']),
    overnight: full(['all tracked phases have full Python language parity']),
    finalize: full(['finalize groups kept file changes independent of language']),
  }),
  rust: Object.freeze({
    init: full(['Cargo.toml is detected', 'cargo test validation is scaffolded']),
    build: full(['build prompts route Rust features to cargo test-shaped tests and .rs implementation files', 'BUILD red/green validation can run cargo test']),
    simplify: full(['simplify detects Rust public API exports and blocks deleting pub items']),
    polish: full(['polish is patch-and-validation based and can run cargo test']),
    fuzz: full(['Rust cargo fuzz-style harness generation and execution are available']),
    benchmark: full(['benchmark runner shells arbitrary entry_point commands']),
    improve: full(['benchmark execution is language-neutral', 'Rust target extraction and hotspot detection are language-aware']),
    autoresearch: full(['autoresearch operates on patches, validation, and judge packets']),
    audit: full(['audit operates on patch proposals and validation gates']),
    docs: full(['docs discovers Rust source files and extracts pub symbols with existing /// docs']),
    overnight: full(['all tracked phases have full Rust language parity']),
    finalize: full(['finalize groups kept file changes independent of language']),
  }),
  go: Object.freeze({
    init: full(['go.mod is detected', 'go test ./... validation is scaffolded']),
    build: full(['build prompts route Go features to testing-package _test.go files', 'BUILD red/green validation can run go test ./...']),
    simplify: full(['simplify detects Go exported identifiers and blocks deleting public API symbols']),
    polish: full(['polish is patch-and-validation based and can run go test ./...']),
    fuzz: full(['Go native FuzzXxx harness generation and bounded execution are available']),
    benchmark: full(['benchmark runner shells arbitrary entry_point commands']),
    improve: full(['benchmark execution is language-neutral', 'Go target extraction and hotspot detection are language-aware']),
    autoresearch: full(['autoresearch operates on patches, validation, and judge packets']),
    audit: full(['audit operates on patch proposals and validation gates']),
    docs: full(['docs discovers Go source files and extracts exported symbols with existing // docs']),
    overnight: full(['all tracked phases have full Go language parity']),
    finalize: full(['finalize groups kept file changes independent of language']),
  }),
  ruby: Object.freeze({
    init: full(['Gemfile / gemspec / .rb files are detected', 'bundle validation is scaffolded']),
    build: full(['build prompts route Ruby features to RSpec/minitest-shaped tests and .rb implementation files', 'BUILD red/green validation can run bundle exec rspec or ruby -Itest']),
    simplify: full(['Ruby public symbols are scanned with Ripper-backed checks']),
    polish: full(['polish is patch-and-validation based', 'Ruby starter adapter discovers bundle exec rspec/rake validation']),
    fuzz: full(['Ruby minitest fuzz harness generation and execution are available']),
    benchmark: full(['benchmark runner shells arbitrary entry_point commands']),
    improve: full(['benchmark execution is language-neutral', 'Ruby target extraction and hotspot detection are language-aware']),
    autoresearch: full(['autoresearch operates on patches, validation, and judge packets']),
    audit: full(['audit operates on patch proposals and validation gates']),
    docs: full(['Ruby public docs extraction uses Ripper-backed symbols and comment docs']),
    overnight: full(['all tracked phases have full Ruby language parity']),
    finalize: full(['finalize groups kept file changes independent of language']),
  }),
  java: Object.freeze({
    init: full(['pom.xml, build.gradle, settings.gradle, and src/main Java layouts are detected', 'mvn test or gradle test validation is scaffolded']),
    build: full(['build prompts route Java features to JUnit-shaped tests and .java implementation files', 'BUILD red/green validation can run mvn test or gradle test']),
    simplify: full(['simplify detects Java public classes/interfaces/enums/methods and blocks public API deletion']),
    polish: full(['polish is patch-and-validation based and can run Maven/Gradle tests']),
    fuzz: full(['Java JUnit fuzz-style harness generation is available']),
    benchmark: full(['benchmark runner shells arbitrary entry_point commands']),
    improve: full(['benchmark execution is language-neutral', 'Java target extraction and hotspot detection are language-aware']),
    autoresearch: full(['autoresearch operates on patches, validation, and judge packets']),
    audit: full(['audit operates on patch proposals and validation gates']),
    docs: full(['docs discovers Java source files and extracts public symbols with Javadoc comments']),
    overnight: full(['all tracked phases have full Java language parity']),
    finalize: full(['finalize groups kept file changes independent of language']),
  }),
  kotlin: Object.freeze({
    init: full(['build.gradle.kts, settings.gradle.kts, and src/main Kotlin layouts are detected', 'gradle test validation is scaffolded']),
    build: full(['build prompts route Kotlin features to kotlin.test/JUnit-shaped tests and .kt implementation files', 'BUILD red/green validation can run gradle test']),
    simplify: full(['simplify detects Kotlin public classes/objects/interfaces/functions and blocks public API deletion']),
    polish: full(['polish is patch-and-validation based and can run Gradle tests']),
    fuzz: full(['Kotlin test fuzz-style harness generation is available']),
    benchmark: full(['benchmark runner shells arbitrary entry_point commands']),
    improve: full(['benchmark execution is language-neutral', 'Kotlin target extraction and hotspot detection are language-aware']),
    autoresearch: full(['autoresearch operates on patches, validation, and judge packets']),
    audit: full(['audit operates on patch proposals and validation gates']),
    docs: full(['docs discovers Kotlin source files and extracts public symbols with KDoc comments']),
    overnight: full(['all tracked phases have full Kotlin language parity']),
    finalize: full(['finalize groups kept file changes independent of language']),
  }),
  csharp: Object.freeze({
    init: full(['.csproj and .sln projects are detected', 'dotnet test/build validation is scaffolded']),
    build: full(['build prompts route C# features to xUnit/NUnit/MSTest-shaped tests and .cs implementation files', 'BUILD red/green validation can run dotnet test']),
    simplify: full(['simplify detects C# public classes/interfaces/structs/enums/methods and blocks public API deletion']),
    polish: full(['polish is patch-and-validation based and can run dotnet test/build']),
    fuzz: full(['C# xUnit fuzz-style harness generation is available']),
    benchmark: full(['benchmark runner shells arbitrary entry_point commands']),
    improve: full(['benchmark execution is language-neutral', 'C# target extraction and hotspot detection are language-aware']),
    autoresearch: full(['autoresearch operates on patches, validation, and judge packets']),
    audit: full(['audit operates on patch proposals and validation gates']),
    docs: full(['docs discovers C# source files and extracts public symbols with XML doc comments']),
    overnight: full(['all tracked phases have full C# language parity']),
    finalize: full(['finalize groups kept file changes independent of language']),
  }),
  swift: Object.freeze({
    init: full(['Package.swift, .xcodeproj, and .xcworkspace projects are detected', 'swift test or xcodebuild test validation is scaffolded']),
    build: full(['build prompts route Swift features to XCTest-shaped tests and .swift implementation files', 'BUILD red/green validation can run swift test or xcodebuild test']),
    simplify: full(['simplify detects Swift public/open classes/structs/enums/protocols/functions and blocks public API deletion']),
    polish: full(['polish is patch-and-validation based and can run Swift/Xcode tests']),
    fuzz: full(['Swift XCTest fuzz-style harness generation is available']),
    benchmark: full(['benchmark runner shells arbitrary entry_point commands']),
    improve: full(['benchmark execution is language-neutral', 'Swift target extraction and hotspot detection are language-aware']),
    autoresearch: full(['autoresearch operates on patches, validation, and judge packets']),
    audit: full(['audit operates on patch proposals and validation gates']),
    docs: full(['docs discovers Swift source files and extracts public symbols with /// docs']),
    overnight: full(['all tracked phases have full Swift language parity']),
    finalize: full(['finalize groups kept file changes independent of language']),
  }),
  c: Object.freeze({
    init: full(['CMakeLists.txt, Makefile, meson.build, BUILD.bazel, and C source layouts are detected', 'ctest/make/custom validation is scaffolded']),
    build: full(['build prompts route C features to native test files and .c/.h implementation files', 'BUILD red/green validation can run ctest, make test, meson test, or bazel test']),
    simplify: full(['simplify detects C public header declarations and blocks public API deletion']),
    polish: full(['polish is patch-and-validation based and can run native C validation commands']),
    fuzz: full(['C native smoke/fuzz-style harness generation is available']),
    benchmark: full(['benchmark runner shells arbitrary entry_point commands']),
    improve: full(['benchmark execution is language-neutral', 'C target extraction and hotspot detection are language-aware']),
    autoresearch: full(['autoresearch operates on patches, validation, and judge packets']),
    audit: full(['audit operates on patch proposals and validation gates']),
    docs: full(['docs discovers C source/header files and extracts public declarations with comments']),
    overnight: full(['all tracked phases have full C language parity']),
    finalize: full(['finalize groups kept file changes independent of language']),
  }),
  cpp: Object.freeze({
    init: full(['CMakeLists.txt, Makefile, meson.build, BUILD.bazel, and C++ source layouts are detected', 'ctest/make/custom validation is scaffolded']),
    build: full(['build prompts route C++ features to native test files and .cpp/.hpp implementation files', 'BUILD red/green validation can run ctest, make test, meson test, or bazel test']),
    simplify: full(['simplify detects C++ public class/function declarations and blocks public API deletion']),
    polish: full(['polish is patch-and-validation based and can run native C++ validation commands']),
    fuzz: full(['C++ native smoke/fuzz-style harness generation is available']),
    benchmark: full(['benchmark runner shells arbitrary entry_point commands']),
    improve: full(['benchmark execution is language-neutral', 'C++ target extraction and hotspot detection are language-aware']),
    autoresearch: full(['autoresearch operates on patches, validation, and judge packets']),
    audit: full(['audit operates on patch proposals and validation gates']),
    docs: full(['docs discovers C++ source/header files and extracts public declarations with comments']),
    overnight: full(['all tracked phases have full C++ language parity']),
    finalize: full(['finalize groups kept file changes independent of language']),
  }),
});

function normalizeCell(language, mode, rawCell) {
  const cell = rawCell && typeof rawCell === 'object' ? rawCell : missing('cell not declared');
  const status = Object.values(STATUS).includes(cell.status) ? cell.status : STATUS.MISSING;
  return {
    language,
    mode,
    status,
    evidence: Array.isArray(cell.evidence) ? cell.evidence.slice() : [],
    evidenceLevel: Object.values(EVIDENCE_LEVEL).includes(cell.evidenceLevel)
      ? cell.evidenceLevel
      : EVIDENCE_LEVEL.LOCAL,
    missing: Array.isArray(cell.missing) ? cell.missing.slice() : [],
    blockedReason: cell.blockedReason || null,
  };
}

function buildLanguageParityMatrix(capabilities = CURRENT_LANGUAGE_CAPABILITIES) {
  const matrix = {};
  for (const language of SUPPORTED_LANGUAGES) {
    matrix[language] = {};
    const languageCapabilities = capabilities[language] || {};
    for (const mode of XO_MODES) {
      matrix[language][mode] = normalizeCell(language, mode, languageCapabilities[mode]);
    }
  }
  return matrix;
}

function referenceStatusForMode(matrix, mode) {
  return REFERENCE_LANGUAGES.every((language) => matrix[language][mode].status === STATUS.FULL)
    ? STATUS.FULL
    : STATUS.PARTIAL;
}

function compareToReference(matrix = buildLanguageParityMatrix()) {
  const comparisons = [];
  for (const mode of XO_MODES) {
    const referenceStatus = referenceStatusForMode(matrix, mode);
    for (const language of SUPPORTED_LANGUAGES) {
      const cell = matrix[language][mode];
      const fullParity = cell.status === STATUS.FULL;
      comparisons.push({
        language,
        mode,
        referenceStatus,
        status: cell.status,
        fullParity,
        evidence: cell.evidence,
        evidenceLevel: cell.evidenceLevel,
        missing: cell.missing,
        blockedReason: cell.blockedReason,
      });
    }
  }
  return comparisons;
}

module.exports = {
  CURRENT_LANGUAGE_CAPABILITIES,
  EVIDENCE_LEVEL,
  LIVE_AGENTIC_MODES,
  REFERENCE_LANGUAGES,
  STATUS,
  SUPPORTED_LANGUAGES,
  USER_FACING_MODES,
  XO_MODES,
  buildLanguageParityMatrix,
  compareToReference,
};
