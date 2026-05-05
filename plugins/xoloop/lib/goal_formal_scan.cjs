'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LANGUAGE_PRESETS = {
  typescript: {
    detect: ['tsconfig.json', 'package.json'],
    commands: [
      { category: 'type_check', tool: 'tsc', command: 'npx tsc --noEmit' },
      { category: 'lint', tool: 'eslint', command: 'npx eslint .' },
      { category: 'property_fuzz', tool: 'fast-check', command: 'npm test -- --runInBand' },
      { category: 'security_analysis', tool: 'npm audit', command: 'npm audit --audit-level=high' },
    ],
  },
  python: {
    detect: ['pyproject.toml', 'requirements.txt', 'setup.py'],
    commands: [
      { category: 'type_check', tool: 'mypy', command: 'mypy .' },
      { category: 'type_check', tool: 'pyright', command: 'pyright' },
      { category: 'lint', tool: 'ruff', command: 'ruff check .' },
      { category: 'property_fuzz', tool: 'hypothesis', command: 'pytest' },
      { category: 'security_analysis', tool: 'bandit', command: 'bandit -r .' },
    ],
  },
  rust: {
    detect: ['Cargo.toml'],
    commands: [
      { category: 'type_check', tool: 'cargo check', command: 'cargo check' },
      { category: 'lint', tool: 'clippy', command: 'cargo clippy -- -D warnings' },
      { category: 'property_fuzz', tool: 'proptest', command: 'cargo test' },
      { category: 'security_analysis', tool: 'cargo audit', command: 'cargo audit' },
      { category: 'symbolic_execution', tool: 'kani', command: 'cargo kani' },
    ],
  },
  go: {
    detect: ['go.mod'],
    commands: [
      { category: 'type_check', tool: 'go test', command: 'go test ./...' },
      { category: 'lint', tool: 'go vet', command: 'go vet ./...' },
      { category: 'property_fuzz', tool: 'go fuzz', command: 'go test -fuzz=Fuzz ./...' },
      { category: 'security_analysis', tool: 'gosec', command: 'gosec ./...' },
    ],
  },
  java: {
    detect: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    commands: [
      { category: 'type_check', tool: 'javac/build', command: 'mvn -q -DskipTests compile' },
      { category: 'lint', tool: 'checkstyle', command: 'mvn -q checkstyle:check' },
      { category: 'property_fuzz', tool: 'jqwik', command: 'mvn -q test' },
      { category: 'security_analysis', tool: 'dependency-check', command: 'mvn -q org.owasp:dependency-check-maven:check' },
    ],
  },
  c_cpp: {
    detect: ['CMakeLists.txt', 'Makefile', 'compile_commands.json'],
    commands: [
      { category: 'type_check', tool: 'build', command: 'cmake --build build' },
      { category: 'lint', tool: 'clang-tidy', command: 'clang-tidy' },
      { category: 'symbolic_execution', tool: 'cbmc', command: 'cbmc' },
      { category: 'symbolic_execution', tool: 'klee', command: 'klee' },
      { category: 'property_fuzz', tool: 'libFuzzer', command: 'clang -fsanitize=fuzzer,address' },
      { category: 'security_analysis', tool: 'cppcheck', command: 'cppcheck .' },
    ],
  },
};

const TOOL_INSTALL_GUIDANCE = {
  codeql: {
    category: 'security_analysis',
    commands: ['Install GitHub CodeQL CLI, then run `codeql database create` and `codeql database analyze --format=sarif-latest`.'],
  },
  semgrep: {
    category: 'security_analysis',
    commands: ['python -m pip install semgrep', 'brew install semgrep'],
  },
  mypy: {
    category: 'type_check',
    commands: ['python -m pip install mypy'],
  },
  pyright: {
    category: 'type_check',
    commands: ['npm install --save-dev pyright', 'python -m pip install pyright'],
  },
  cargo: {
    category: 'type_check',
    commands: ['Install Rust with rustup, then run `cargo check` and `cargo test`.'],
  },
  gosec: {
    category: 'security_analysis',
    commands: ['go install github.com/securego/gosec/v2/cmd/gosec@latest'],
  },
  cbmc: {
    category: 'symbolic_execution',
    commands: ['brew install cbmc', 'Use the CBMC releases for Linux/macOS and emit JSON with `--json-ui`.'],
  },
  klee: {
    category: 'symbolic_execution',
    commands: ['Install KLEE/LLVM and run instrumented bitcode with `klee`.'],
  },
  tlc: {
    category: 'model_check',
    commands: ['Install TLA+ tools and run TLC with a checked spec/config.'],
  },
  coq: {
    category: 'theorem_proof',
    commands: ['opam install coq', 'Use `coqc` or `dune build` for proof checks.'],
  },
  lean: {
    category: 'theorem_proof',
    commands: ['Install Lean with elan, then run `lake build` or `lean <file>`.'],
  },
  fast_check: {
    category: 'property_fuzz',
    commands: ['npm install --save-dev fast-check'],
  },
  hypothesis: {
    category: 'property_fuzz',
    commands: ['python -m pip install hypothesis pytest'],
  },
};

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return '';
  }
}

function listFiles(cwd, rel, predicate, limit = 220) {
  const root = path.resolve(cwd, rel);
  const out = [];
  if (!fs.existsSync(root)) return out;
  function walk(dir) {
    if (out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_err) {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (['.git', 'node_modules', '.xoloop', 'target', 'dist', 'build', '__pycache__'].includes(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relPath = path.relative(cwd, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(absolute);
      else if (!predicate || predicate(relPath, absolute)) out.push(relPath);
    }
  }
  walk(root);
  return out.sort();
}

function packageDependencyNames(pkg) {
  const out = new Set();
  for (const group of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg && pkg[group] && typeof pkg[group] === 'object' ? pkg[group] : {};
    for (const name of Object.keys(deps)) out.add(name);
  }
  return out;
}

function commandExists(name) {
  const paths = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return paths.some((dir) => fs.existsSync(path.join(dir, name)));
}

function categorizeTool(text) {
  const value = String(text || '').toLowerCase();
  if (/\b(tsc|typecheck|mypy|pyright|flow|sorbet|cargo check|go vet|javac|tsserver)\b/.test(value)) return 'type_check';
  if (/\b(eslint|biome|ruff|flake8|pylint|clippy|golangci-lint|shellcheck|rubocop|checkstyle|ktlint)\b/.test(value)) return 'lint';
  if (/\b(tlc|tla\+|apalache|alloy|spin|promela|uppaal|nuXmv|nusmv)\b/i.test(value)) return 'model_check';
  if (/\b(klee|cbmc|angr|manticore|symbiotic|kani|sea[- ]?horn|saw)\b/.test(value)) return 'symbolic_execution';
  if (/\b(coq|lean|isabelle|agda|dafny|why3|fstar|f\*|idris|frama-c|spark)\b/.test(value)) return 'theorem_proof';
  if (/\b(fast-check|hypothesis|quickcheck|proptest|cargo fuzz|go test .* -fuzz|jazzer|jqwik|property|fuzz)\b/.test(value)) return 'property_fuzz';
  if (/\b(semgrep|bandit|npm audit|cargo audit|gosec|snyk|trivy|osv-scanner|codeql|brakeman|safety|pip-audit|grype|dependency-check)\b/.test(value)) return 'security_analysis';
  return '';
}

function detectPackageScripts(pkg) {
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const out = [];
  for (const [name, command] of Object.entries(scripts)) {
    const category = categorizeTool(`${name} ${command}`);
    if (!category) continue;
    out.push({
      id: `script-${name}`,
      category,
      tool: inferTool(command) || inferTool(name) || category,
      command: `npm run ${name}`,
      source: 'package.json',
      confidence: 0.95,
    });
  }
  return out;
}

function inferTool(text) {
  const value = String(text || '').toLowerCase();
  const tools = [
    'tsc', 'mypy', 'pyright', 'flow', 'eslint', 'biome', 'ruff', 'flake8', 'pylint',
    'clippy', 'golangci-lint', 'shellcheck', 'tlc', 'apalache', 'alloy', 'spin',
    'klee', 'cbmc', 'angr', 'kani', 'coq', 'lean', 'isabelle', 'agda', 'dafny',
    'why3', 'fast-check', 'hypothesis', 'quickcheck', 'proptest', 'semgrep',
    'bandit', 'gosec', 'snyk', 'trivy', 'osv-scanner', 'codeql', 'npm audit',
    'cargo audit', 'pip-audit',
  ];
  return tools.find((tool) => value.includes(tool));
}

function normalizeToolName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\+\+/g, 'pp')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function addConfigCheck(out, cwd, rel, category, tool, command) {
  if (!fs.existsSync(path.join(cwd, rel))) return;
  out.push({
    id: `config-${rel.replace(/[^a-zA-Z0-9_.-]+/g, '-')}`,
    category,
    tool,
    command,
    source: rel,
    confidence: 0.70,
    inferred: true,
  });
}

function detectConfigChecks(cwd, pkg) {
  const deps = packageDependencyNames(pkg);
  const out = [];
  addConfigCheck(out, cwd, 'tsconfig.json', 'type_check', 'tsc', deps.has('typescript') ? 'npx tsc --noEmit' : 'tsc --noEmit');
  addConfigCheck(out, cwd, 'pyrightconfig.json', 'type_check', 'pyright', 'pyright');
  addConfigCheck(out, cwd, 'mypy.ini', 'type_check', 'mypy', 'mypy .');
  addConfigCheck(out, cwd, '.eslintrc.json', 'lint', 'eslint', deps.has('eslint') ? 'npx eslint .' : 'eslint .');
  addConfigCheck(out, cwd, 'eslint.config.js', 'lint', 'eslint', deps.has('eslint') ? 'npx eslint .' : 'eslint .');
  addConfigCheck(out, cwd, 'biome.json', 'lint', 'biome', deps.has('@biomejs/biome') ? 'npx biome check .' : 'biome check .');
  addConfigCheck(out, cwd, '.semgrep.yml', 'security_analysis', 'semgrep', 'semgrep --config .semgrep.yml .');
  addConfigCheck(out, cwd, 'Cargo.toml', 'type_check', 'cargo check', 'cargo check');
  addConfigCheck(out, cwd, 'go.mod', 'type_check', 'go test', 'go test ./...');
  addConfigCheck(out, cwd, 'go.mod', 'lint', 'go vet', 'go vet ./...');
  return out;
}

function detectFormalFiles(cwd) {
  return listFiles(cwd, '.', (rel, abs) => {
    if (/\.(tla|als|pml|promela)$/i.test(rel)) return true;
    if (/\.(v|lean|thy|agda|dfy|why|fst|fsi)$/i.test(rel)) return true;
    if (/\.(c|cc|cpp|rs|py|js|ts|tsx|go|java)$/i.test(rel)) {
      const text = readText(abs);
      return /(KLEE|__CPROVER|cbmc|kani::proof|hypothesis|given\(|fast-check|fc\.|quickcheck|proptest|semgrep|bandit)/i.test(text);
    }
    return false;
  }, 220);
}

function classifyFormalFile(rel) {
  if (/\.(tla|als|pml|promela)$/i.test(rel)) return 'model_check';
  if (/\.(v|lean|thy|agda|dfy|why|fst|fsi)$/i.test(rel)) return 'theorem_proof';
  const lower = rel.toLowerCase();
  if (/fuzz|property|quickcheck|proptest|hypothesis|fast-check/.test(lower)) return 'property_fuzz';
  if (/security|semgrep|bandit|audit/.test(lower)) return 'security_analysis';
  return 'symbolic_execution';
}

function detectDependencyTools(pkg) {
  const deps = packageDependencyNames(pkg);
  const out = [];
  const add = (name, category, reason) => out.push({ name, category, reason });
  if (deps.has('typescript')) add('typescript', 'type_check', 'dependency');
  if (deps.has('eslint')) add('eslint', 'lint', 'dependency');
  if (deps.has('@biomejs/biome')) add('biome', 'lint', 'dependency');
  if (deps.has('fast-check')) add('fast-check', 'property_fuzz', 'dependency');
  if (deps.has('jest') || deps.has('vitest')) add('js-test-runner', 'property_fuzz', 'dependency');
  return out;
}

function hasAnyFile(cwd, files) {
  return files.some((rel) => fs.existsSync(path.join(cwd, rel)));
}

function detectLanguagePresets(cwd) {
  const out = [];
  const files = listFiles(cwd, '.', (rel) => /\.(ts|tsx|js|jsx|py|rs|go|java|c|cc|cpp|h|hpp)$/i.test(rel), 120);
  for (const [language, preset] of Object.entries(LANGUAGE_PRESETS)) {
    const detectedByConfig = hasAnyFile(cwd, preset.detect);
    const detectedBySource = language === 'typescript' ? files.some((rel) => /\.(ts|tsx)$/i.test(rel))
      : language === 'python' ? files.some((rel) => /\.py$/i.test(rel))
        : language === 'rust' ? files.some((rel) => /\.rs$/i.test(rel))
          : language === 'go' ? files.some((rel) => /\.go$/i.test(rel))
            : language === 'java' ? files.some((rel) => /\.java$/i.test(rel))
              : language === 'c_cpp' ? files.some((rel) => /\.(c|cc|cpp|h|hpp)$/i.test(rel))
                : false;
    if (detectedByConfig || detectedBySource) {
      out.push({
        language,
        detected_by: detectedByConfig ? 'config' : 'source',
        commands: preset.commands,
      });
    }
  }
  return out;
}

function toolExecutable(command, tool) {
  const parts = String(command || '').trim().split(/\s+/).filter(Boolean);
  if (parts[0] === 'npx' && parts[1]) return parts[1];
  if (parts[0] === 'python' || parts[0] === 'python3') return parts[2] || parts[1] || parts[0];
  if (parts[0] === 'cargo') return 'cargo';
  if (parts[0] === 'go') return 'go';
  if (parts[0] === 'mvn') return 'mvn';
  return parts[0] || String(tool || '').split(/\s+/)[0];
}

function installGuidanceForTool(tool, category, command = '') {
  const normalized = normalizeToolName(tool);
  const aliases = {
    npm_audit: 'npm_audit',
    cargo_audit: 'cargo',
    cargo_check: 'cargo',
    go_test: 'go',
    go_vet: 'go',
    fast_check: 'fast_check',
    fastcheck: 'fast_check',
    lean4: 'lean',
  };
  const key = TOOL_INSTALL_GUIDANCE[normalized] ? normalized : aliases[normalized];
  const executable = toolExecutable(command, tool);
  return {
    tool,
    category,
    executable,
    available: executable ? commandExists(executable) : false,
    guidance: key && TOOL_INSTALL_GUIDANCE[key] ? TOOL_INSTALL_GUIDANCE[key].commands : [],
  };
}

function detectInstallGuidance(checks, languagePresets) {
  const out = [];
  const seen = new Set();
  const add = (tool, category, command) => {
    if (!tool) return;
    const key = `${normalizeToolName(tool)}:${command || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(installGuidanceForTool(tool, category, command));
  };
  for (const check of checks) add(check.tool, check.category, check.command);
  for (const preset of languagePresets) {
    for (const command of preset.commands || []) add(command.tool, command.category, command.command);
  }
  return out;
}

function scanFormalRepo(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  const pkg = readJson(path.join(root, 'package.json'));
  const formalFiles = detectFormalFiles(root);
  const checks = [...detectPackageScripts(pkg), ...detectConfigChecks(root, pkg)];
  const tools = detectDependencyTools(pkg);
  const languagePresets = detectLanguagePresets(root);
  for (const rel of formalFiles) {
    tools.push({ name: path.extname(rel).slice(1) || 'formal-file', category: classifyFormalFile(rel), reason: rel });
  }
  const dedupedChecks = [];
  const seen = new Set();
  for (const check of checks) {
    const key = `${check.category}:${check.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedChecks.push({
      ...check,
      cli_available: commandExists(String(check.command).split(/\s+/)[0].replace(/^npx$/, 'npm')),
    });
  }
  const installGuidance = detectInstallGuidance(dedupedChecks, languagePresets);
  const categories = [...new Set([
    ...tools.map((tool) => tool.category).filter(Boolean),
    ...dedupedChecks.map((check) => check.category).filter(Boolean),
  ])].sort();
  const artifactPaths = [
    pkg ? 'package.json' : null,
    ...formalFiles,
    ...['tsconfig.json', 'pyrightconfig.json', 'mypy.ini', '.eslintrc.json', 'eslint.config.js', 'biome.json', '.semgrep.yml', 'Cargo.toml', 'go.mod']
      .filter((rel) => fs.existsSync(path.join(root, rel))),
  ].filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index).sort();
  const required = ['type_check', 'lint', 'model_check', 'symbolic_execution', 'theorem_proof', 'property_fuzz', 'security_analysis'];
  const gaps = required.filter((category) => !categories.includes(category)).map((category) => `no ${category.replace(/_/g, ' ')} tool or file detected`);
  if (dedupedChecks.length === 0) gaps.push('no runnable formal/static analyzer command detected');
  return {
    schema: 'xoloop.formal_scan.v0.1',
    cwd: root,
    categories,
    tools,
    checks: dedupedChecks,
    language_presets: languagePresets,
    supported_language_presets: LANGUAGE_PRESETS,
    tool_install_guidance: installGuidance,
    formal_files: formalFiles,
    artifact_paths: artifactPaths,
    gaps,
  };
}

module.exports = {
  scanFormalRepo,
};
