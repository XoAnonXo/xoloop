'use strict';

const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { AdapterError } = require('./errors.cjs');

// ── AST helpers ────────────────────────────────────────────────────────

function walk(node, visitor, _halt) {
  if (!node || typeof node !== 'object') return;
  if (_halt && _halt.stop) return;
  if (node.type) visitor(node);
  if (_halt && _halt.stop) return;
  for (const key of Object.keys(node)) {
    if (_halt && _halt.stop) return;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (_halt && _halt.stop) return;
        walk(item, visitor, _halt);
      }
    } else if (child && typeof child === 'object' && child.type) {
      walk(child, visitor, _halt);
    }
  }
}

function isAssertCall(node, methodName) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'assert' &&
    node.callee.property.name === methodName
  );
}

function isAnyAssertCall(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'MemberExpression' &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'assert'
  );
}

function isTestBlock(node) {
  if (node.type !== 'CallExpression' || node.arguments.length < 2) return false;
  // test('name', fn)
  if (node.callee.type === 'Identifier' && node.callee.name === 'test') return true;
  // test.only('name', fn), test.skip('name', fn), t.test('name', fn)
  if (node.callee.type === 'MemberExpression' &&
      node.callee.property.type === 'Identifier') {
    const obj = node.callee.object;
    const prop = node.callee.property.name;
    // test.only, test.skip, test.todo
    if (obj.type === 'Identifier' && obj.name === 'test' &&
        (prop === 'only' || prop === 'skip' || prop === 'todo')) return true;
    // t.test (subtest pattern)
    if (obj.type === 'Identifier' && prop === 'test') return true;
  }
  return false;
}

function getTestBody(node) {
  const fn = node.arguments[1];
  if (!fn) return null;
  if (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression') {
    return fn.body;
  }
  return null;
}

function getTestName(node) {
  const arg = node.arguments[0];
  if (!arg) return '';
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral' && arg.quasis.length > 0) {
    return arg.quasis.map(q => q.value.raw).join('');
  }
  return '';
}

function containsAssertCall(bodyNode) {
  const halt = { stop: false };
  let found = false;
  walk(bodyNode, (n) => {
    if (isAnyAssertCall(n)) { found = true; halt.stop = true; }
  }, halt);
  return found;
}

function isFunctionArg(node) {
  return node && (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression');
}

// ── Rule 1: require-throws-callback ────────────────────────────────────

function checkRequireThrowsCallback(ast, filePath) {
  const violations = [];

  walk(ast, (node) => {
    if (!isAssertCall(node, 'throws') && !isAssertCall(node, 'rejects')) return;
    const method = node.callee.property.name;
    const secondArg = node.arguments[1];

    if (!secondArg) {
      violations.push({
        rule: 'require-throws-callback',
        file: filePath,
        line: node.loc.start.line,
        column: node.loc.start.column,
        message: `assert.${method}() without validation callback — add (err) => { assert...; return true; }`,
        severity: 'error',
      });
      return;
    }

    if (secondArg.type === 'Literal' && secondArg.regex) {
      violations.push({
        rule: 'require-throws-callback',
        file: filePath,
        line: node.loc.start.line,
        column: node.loc.start.column,
        message: `assert.${method}() with regex-only validation — use a callback to assert error shape`,
        severity: 'error',
      });
      return;
    }

    if (secondArg.type === 'ObjectExpression') {
      violations.push({
        rule: 'require-throws-callback',
        file: filePath,
        line: node.loc.start.line,
        column: node.loc.start.column,
        message: `assert.${method}() with object-only validation — use a callback to assert full error contract`,
        severity: 'error',
      });
      return;
    }

    // Block empty callbacks: (err) => true, () => true
    if (isFunctionArg(secondArg) && !containsAssertCall(secondArg.body)) {
      // Check if the body is just `return true` or an arrow returning `true`
      const body = secondArg.body;
      const isBareLiteral = body.type === 'Literal' && body.value === true;
      const isReturnTrue = body.type === 'BlockStatement' && body.body.length === 1 &&
        body.body[0].type === 'ReturnStatement' &&
        body.body[0].argument && body.body[0].argument.type === 'Literal' &&
        body.body[0].argument.value === true;
      if (isBareLiteral || isReturnTrue) {
        violations.push({
          rule: 'require-throws-callback',
          file: filePath,
          line: node.loc.start.line,
          column: node.loc.start.column,
          message: `assert.${method}() callback is () => true with no assertions — validate the error shape`,
          severity: 'error',
        });
      }
    }
  });

  return violations;
}

// ── Rule 2: require-adapter-error-shape ────────────────────────────────

function checkRequireAdapterErrorShape(ast, filePath) {
  const violations = [];

  walk(ast, (node) => {
    if (!isTestBlock(node)) return;
    const body = getTestBody(node);
    if (!body) return;

    // Check if test references AdapterError
    const testName = getTestName(node);
    let referencesAdapterError = /AdapterError/i.test(testName);
    if (!referencesAdapterError) {
      walk(body, (n) => {
        if (referencesAdapterError) return;
        if (n.type === 'Identifier' && n.name === 'AdapterError') referencesAdapterError = true;
      });
    }
    if (!referencesAdapterError) return;

    // Find assert.throws callbacks in this test
    walk(body, (throwsNode) => {
      if (!isAssertCall(throwsNode, 'throws') && !isAssertCall(throwsNode, 'rejects')) return;
      const callback = throwsNode.arguments[1];
      if (!isFunctionArg(callback)) return;

      // Collect asserted error properties — look for err.PROP anywhere in the callback
      const assertedProps = new Set();
      const paramName = callback.params[0] && callback.params[0].name;
      walk(callback.body, (n) => {
        // Any MemberExpression on the error param: err.code, err.field, err.fixHint.length, etc.
        if (n.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === paramName) {
          assertedProps.add(n.property.name || n.property.value);
        }
        // Also catch err.fixHint.length (nested MemberExpression)
        if (n.type === 'MemberExpression' && n.object.type === 'MemberExpression' &&
            n.object.object.type === 'Identifier' && n.object.object.name === paramName) {
          assertedProps.add(n.object.property.name || n.object.property.value);
        }
      });

      if (assertedProps.has('code') && !assertedProps.has('field') && !assertedProps.has('fixHint')) {
        violations.push({
          rule: 'require-adapter-error-shape',
          file: filePath,
          line: throwsNode.loc.start.line,
          column: throwsNode.loc.start.column,
          message: `AdapterError test asserts .code but not .field or .fixHint — lock the full error contract`,
          severity: 'error',
        });
      }
    });
  });

  return violations;
}

// ── Rule 3: no-assertion-free-test ─────────────────────────────────────

function checkNoAssertionFreeTest(ast, filePath) {
  const violations = [];

  walk(ast, (node) => {
    if (!isTestBlock(node)) return;
    const body = getTestBody(node);
    if (!body) return;

    if (!containsAssertCall(body)) {
      const testName = getTestName(node);
      violations.push({
        rule: 'no-assertion-free-test',
        file: filePath,
        line: node.loc.start.line,
        column: node.loc.start.column,
        message: `test "${testName.slice(0, 60)}" has no assert.* calls — exercising code without assertions proves nothing`,
        severity: 'error',
      });
    }
  });

  return violations;
}

// ── Rule 4: no-truthiness-assertion ────────────────────────────────────

function checkNoTruthinessAssertion(ast, filePath) {
  const violations = [];

  walk(ast, (node) => {
    if (!isAssertCall(node, 'ok')) return;
    const firstArg = node.arguments[0];
    if (!firstArg) return;

    // Has a message arg? Then it's intentional — skip
    if (node.arguments.length >= 2 && node.arguments[1] &&
        (node.arguments[1].type === 'Literal' || node.arguments[1].type === 'TemplateLiteral')) {
      return;
    }

    // Bare identifier: assert.ok(result)
    if (firstArg.type === 'Identifier') {
      violations.push({
        rule: 'no-truthiness-assertion',
        file: filePath,
        line: node.loc.start.line,
        column: node.loc.start.column,
        message: `assert.ok(${firstArg.name}) is a truthiness tautology — assert specific shape or value`,
        severity: 'error',
      });
      return;
    }

    // result !== undefined or result !== null
    if (firstArg.type === 'BinaryExpression' && firstArg.operator === '!==') {
      const { left, right } = firstArg;
      const isSimpleNullCheck =
        (left.type === 'Identifier' && (
          (right.type === 'Identifier' && right.name === 'undefined') ||
          (right.type === 'Literal' && right.value === null)
        )) ||
        (right.type === 'Identifier' && (
          (left.type === 'Identifier' && left.name === 'undefined') ||
          (left.type === 'Literal' && left.value === null)
        ));

      if (isSimpleNullCheck) {
        violations.push({
          rule: 'no-truthiness-assertion',
          file: filePath,
          line: node.loc.start.line,
          column: node.loc.start.column,
          message: `assert.ok(x !== undefined/null) is a weak assertion — assert specific type or value`,
          severity: 'error',
        });
      }
    }
  });

  return violations;
}

// ── Rule 5: require-export-coverage ────────────────────────────────────

function extractExports(libSource) {
  let ast;
  try {
    ast = acorn.parse(libSource, { ecmaVersion: 2022, sourceType: 'script', locations: true });
  } catch (_e) {
    return [];
  }

  const exports = [];
  walk(ast, (node) => {
    // module.exports = { fn1, fn2, ... }
    if (
      node.type === 'AssignmentExpression' &&
      node.left.type === 'MemberExpression' &&
      node.left.object.type === 'Identifier' &&
      node.left.object.name === 'module' &&
      node.left.property.name === 'exports' &&
      node.right.type === 'ObjectExpression'
    ) {
      for (const prop of node.right.properties) {
        if (prop.key && (prop.key.type === 'Identifier' || prop.key.type === 'Literal')) {
          exports.push(prop.key.name || prop.key.value);
        }
      }
    }
  });

  return exports;
}

function checkRequireExportCoverage(testSource, testFilePath, libDir) {
  if (typeof testFilePath !== 'string') return [];
  if (typeof libDir !== 'string') return [];
  if (typeof testSource !== 'string') {
    throw new AdapterError('SLOP_SOURCE_REQUIRED', 'testSource', 'testSource must be a string', {
      fixHint: 'Pass the test file content as a string to checkRequireExportCoverage.',
    });
  }

  const violations = [];
  const baseName = path.basename(testFilePath, '.test.cjs');
  const libPath = path.join(libDir, `${baseName}.cjs`);

  if (!fs.existsSync(libPath)) return violations;

  const libSource = fs.readFileSync(libPath, 'utf8');
  const exportedNames = extractExports(libSource);
  if (exportedNames.length === 0) return violations;

  // Collect test names
  let testAst;
  try {
    testAst = acorn.parse(testSource, { ecmaVersion: 2022, sourceType: 'script', locations: true });
  } catch (_e) {
    return violations;
  }

  const testNames = [];
  walk(testAst, (node) => {
    if (isTestBlock(node)) testNames.push(getTestName(node));
  });

  const allTestText = testNames.join(' ').toLowerCase();

  for (const exportName of exportedNames) {
    const nameLower = exportName.toLowerCase();
    // Check if any test name mentions this export (case-insensitive, partial match)
    if (!allTestText.includes(nameLower)) {
      // Also check if the test source imports and references it
      if (!testSource.includes(exportName)) {
        violations.push({
          rule: 'require-export-coverage',
          file: testFilePath,
          line: 1,
          column: 0,
          message: `exported function "${exportName}" has no test mentioning it`,
          severity: 'info',
        });
      }
    }
  }

  return violations;
}

// ── Rule 6: require-edge-case-coverage ────────────────────────────────

function checkRequireEdgeCaseCoverage(ast, filePath, _options) {
  const violations = [];

  // Scan the entire AST for edge-case argument patterns.
  // Categories:
  //   1. null / undefined
  //   2. empty string ''
  //   3. numeric edge: 0, NaN, Infinity
  //   4. empty array []
  const found = { nullish: false, emptyStr: false, numericEdge: false, emptyArr: false };

  walk(ast, (node) => {
    // null literal  —  Literal { value: null }
    if (node.type === 'Literal' && node.value === null) {
      found.nullish = true;
    }

    // undefined identifier
    if (node.type === 'Identifier' && node.name === 'undefined') {
      found.nullish = true;
    }

    // empty string ''  —  Literal { value: '' }
    if (node.type === 'Literal' && node.value === '') {
      found.emptyStr = true;
    }

    // 0 literal
    if (node.type === 'Literal' && node.value === 0) {
      found.numericEdge = true;
    }

    // NaN / Infinity identifiers
    if (node.type === 'Identifier' && (node.name === 'NaN' || node.name === 'Infinity')) {
      found.numericEdge = true;
    }

    // empty array []  —  ArrayExpression with 0 elements
    if (node.type === 'ArrayExpression' && node.elements.length === 0) {
      found.emptyArr = true;
    }
  });

  const categoriesHit = [found.nullish, found.emptyStr, found.numericEdge, found.emptyArr]
    .filter(Boolean).length;

  if (categoriesHit < 2) {
    violations.push({
      rule: 'require-edge-case-coverage',
      file: filePath,
      line: 1,
      column: 0,
      message: `test file covers ${categoriesHit} of 4 edge-case categories (null/undefined, empty string, 0/NaN/Infinity, empty array) — aim for at least 2`,
      severity: 'info',
    });
  }

  return violations;
}

// ── Main entry points ──────────────────────────────────────────────────

function detectSlopInSource(source, filePath, options = {}) {
  if (typeof source !== 'string') {
    throw new AdapterError('SLOP_SOURCE_REQUIRED', 'source', 'source must be a string', {
      fixHint: 'Pass the test file content as a string to detectSlopInSource.',
    });
  }

  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: 'script', locations: true });
  } catch (parseErr) {
    return [{
      rule: 'parse-error',
      file: filePath,
      line: parseErr.loc ? parseErr.loc.line : 1,
      column: parseErr.loc ? parseErr.loc.column : 0,
      message: `Failed to parse: ${parseErr.message}`,
      severity: 'error',
    }];
  }

  const violations = [
    ...checkRequireThrowsCallback(ast, filePath),
    ...checkRequireAdapterErrorShape(ast, filePath),
    ...checkNoAssertionFreeTest(ast, filePath),
    ...checkNoTruthinessAssertion(ast, filePath),
    ...checkRequireEdgeCaseCoverage(ast, filePath, options),
  ];

  if (options.libDir) {
    violations.push(...checkRequireExportCoverage(source, filePath, options.libDir));
  }

  return violations;
}

function detectSlop(testFilePaths, options = {}) {
  if (!Array.isArray(testFilePaths)) {
    throw new AdapterError('SLOP_FILES_REQUIRED', 'testFilePaths', 'testFilePaths must be an array', {
      fixHint: 'Pass an array of test file paths to detectSlop.',
    });
  }

  const safeOptions = options && typeof options === 'object' ? options : {};
  const allViolations = [];

  for (const filePath of testFilePaths) {
    if (typeof filePath !== 'string') continue;
    if (!fs.existsSync(filePath)) continue;

    const source = fs.readFileSync(filePath, 'utf8');
    const violations = detectSlopInSource(source, filePath, safeOptions);
    allViolations.push(...violations);
  }

  const hasErrors = allViolations.some(v => v.severity === 'error');

  return {
    ok: !hasErrors,
    violations: allViolations,
  };
}

module.exports = {
  detectSlop,
  detectSlopInSource,
  checkRequireThrowsCallback,
  checkRequireAdapterErrorShape,
  checkNoAssertionFreeTest,
  checkNoTruthinessAssertion,
  checkRequireExportCoverage,
  checkRequireEdgeCaseCoverage,
  extractExports,
};
