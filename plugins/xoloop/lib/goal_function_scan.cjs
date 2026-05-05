'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_EXTENSIONS = new Set([
  '.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx',
  '.py', '.go', '.rs',
]);

const SKIP_DIRS = new Set([
  '.git',
  '.xoloop',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  '__pycache__',
]);

const TEST_FILE_RE = /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.(cjs|mjs|js|jsx|ts|tsx|py|go|rs)$/i;

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_err) {
    return '';
  }
}

function listFiles(cwd, rel = '.', predicate = null, limit = 500) {
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
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relPath = path.relative(cwd, absolute).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (!predicate || predicate(relPath, absolute)) {
        out.push(relPath);
      }
    }
  }
  walk(root);
  return out.sort();
}

function languageForFile(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (['.ts', '.tsx'].includes(ext)) return 'typescript';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  return '';
}

function lineNumberFor(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function functionId(relPath, name) {
  return `${relPath.replace(/[^a-zA-Z0-9_.-]+/g, '-')}:${name}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitTopLevel(value) {
  const input = String(value || '').trim();
  if (!input) return [];
  const parts = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const previous = input[index - 1];
    if (quote) {
      current += char;
      if (char === quote && previous !== '\\') quote = '';
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if ('([{<'.includes(char)) depth += 1;
    if (')]}>' .includes(char)) depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function normalizeType(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/,$/, '')
    .trim();
}

function parseJsTsParams(text) {
  return splitTopLevel(text)
    .map((rawParam) => {
      const raw = rawParam.replace(/^\.\.\./, '').trim();
      if (!raw || raw === 'this') return null;
      const withoutDefault = raw.split('=').slice(0, -1).join('=').trim() || raw.split('=')[0].trim();
      const optional = /\?/.test(withoutDefault.split(':')[0] || '');
      const colon = withoutDefault.indexOf(':');
      const name = (colon >= 0 ? withoutDefault.slice(0, colon) : withoutDefault)
        .replace(/[?{}\[\]\s]/g, '')
        .trim();
      const type = colon >= 0 ? normalizeType(withoutDefault.slice(colon + 1)) : '';
      if (!name) return null;
      return {
        name,
        type,
        optional,
        default: raw.includes('=') ? raw.slice(raw.indexOf('=') + 1).trim() : '',
        raw,
      };
    })
    .filter(Boolean);
}

function parsePythonParams(text) {
  return splitTopLevel(text)
    .map((rawParam) => {
      const raw = rawParam.trim();
      if (!raw || raw === '*' || raw.startsWith('**')) return null;
      const cleaned = raw.replace(/^\*/, '');
      const beforeDefault = cleaned.split('=')[0].trim();
      const colon = beforeDefault.indexOf(':');
      const name = (colon >= 0 ? beforeDefault.slice(0, colon) : beforeDefault).trim();
      if (!name || name === 'self' || name === 'cls') return null;
      return {
        name,
        type: colon >= 0 ? normalizeType(beforeDefault.slice(colon + 1)) : '',
        optional: raw.includes('='),
        default: raw.includes('=') ? raw.slice(raw.indexOf('=') + 1).trim() : '',
        raw,
      };
    })
    .filter(Boolean);
}

function parseGoParams(text) {
  const params = [];
  let pendingNames = [];
  for (const rawGroup of splitTopLevel(text)) {
    const raw = rawGroup.trim();
    if (!raw) continue;
    const pieces = raw.split(/\s+/);
    if (pieces.length === 1) {
      pendingNames.push(pieces[0]);
      continue;
    }
    const type = normalizeType(pieces.slice(1).join(' '));
    const names = [
      ...pendingNames,
      ...pieces[0].split(',').map((item) => item.trim()).filter(Boolean),
    ];
    pendingNames = [];
    for (const name of names) {
      params.push({ name, type, optional: false, default: '', raw });
    }
  }
  for (const type of pendingNames) {
    params.push({ name: '', type: normalizeType(type), optional: false, default: '', raw: type });
  }
  return params;
}

function parseRustParams(text) {
  return splitTopLevel(text)
    .map((rawParam) => {
      const raw = rawParam.trim();
      if (!raw || raw === 'self' || raw === '&self' || raw === '&mut self') return null;
      const colon = raw.indexOf(':');
      if (colon < 0) return { name: raw, type: '', optional: false, default: '', raw };
      return {
        name: raw.slice(0, colon).replace(/^mut\s+/, '').trim(),
        type: normalizeType(raw.slice(colon + 1)),
        optional: false,
        default: '',
        raw,
      };
    })
    .filter(Boolean);
}

function parseReturnType(language, raw) {
  const text = normalizeType(raw);
  if (!text) return { type: '', raw: '' };
  if (language === 'typescript' || language === 'javascript') {
    const match = text.match(/:\s*(.+)$/);
    return { type: match ? normalizeType(match[1]) : '', raw: text };
  }
  if (language === 'python') return { type: text, raw: text };
  if (language === 'go') return { type: text.replace(/^\((.*)\)$/, '$1').trim(), raw: text };
  if (language === 'rust') return { type: text, raw: text };
  return { type: text, raw: text };
}

function cleanComment(comment) {
  return String(comment || '')
    .replace(/^\s*\/\*\*?/, '')
    .replace(/\*\/\s*$/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\*+|\/\/\/?|#|--)\s?/, '').trimEnd())
    .join('\n')
    .trim();
}

function extractLeadingComment(text, startIndex, lineCommentRe = /^\s*\/\/\/?\s?(.*)$/) {
  const before = text.slice(0, startIndex).replace(/[ \t]+$/g, '');
  const block = before.match(/\/\*\*?[\s\S]*?\*\/\s*$/);
  if (block) return cleanComment(block[0]);

  const lines = before.split(/\r?\n/);
  const comments = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) {
      if (comments.length === 0) continue;
      break;
    }
    const match = line.match(lineCommentRe);
    if (!match) break;
    comments.unshift(match[1]);
  }
  return cleanComment(comments.join('\n'));
}

function extractPythonDocstring(body) {
  const match = body.match(/^\s*(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/);
  return match ? cleanComment(match[1] || match[2] || '') : '';
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    const previous = text[index - 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote && previous !== '\\') quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function expressionEnd(text, startIndex) {
  const semi = text.indexOf(';', startIndex);
  const newline = text.indexOf('\n', startIndex);
  if (semi < 0) return newline < 0 ? text.length : newline;
  if (newline < 0) return semi;
  return Math.min(semi, newline);
}

function compactSignature(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function commonJsExportMap(text) {
  const exports = new Map();
  for (const match of text.matchAll(/\bmodule\.exports\s*=\s*\{/g)) {
    const openIndex = match.index + match[0].lastIndexOf('{');
    const closeIndex = findMatchingBrace(text, openIndex);
    if (closeIndex < 0) continue;
    const body = text
      .slice(openIndex + 1, closeIndex)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const entry of splitTopLevel(body)) {
      const raw = entry.trim();
      if (!raw || raw.startsWith('...')) continue;
      const alias = raw.match(/^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\b/);
      if (alias) {
        exports.set(alias[2], alias[1]);
        continue;
      }
      const shorthand = raw.match(/^([A-Za-z_$][\w$]*)\b/);
      if (shorthand) exports.set(shorthand[1], shorthand[1]);
    }
  }
  for (const match of text.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g)) {
    exports.set(match[2], match[1]);
  }
  return exports;
}

function makeFunctionRecord({ relPath, language, name, visibility, signature, params, returns, body, comments, async = false, startIndex, text }) {
  const sideEffects = detectSideEffects(language, body);
  const classification = sideEffects.length > 0 ? 'side_effectful' : 'pure';
  return {
    id: functionId(relPath, name),
    name,
    language,
    file: relPath,
    line: lineNumberFor(text, startIndex),
    visibility,
    signature: compactSignature(signature),
    params,
    returns: returns || { type: '', raw: '' },
    async: Boolean(async),
    comments: comments ? [comments] : [],
    purity: {
      classification,
      confidence: sideEffects.length > 0 ? 0.86 : 0.66,
      reasons: sideEffects.length > 0
        ? sideEffects.map((effect) => `detected ${effect.kind} effect via ${effect.match}`)
        : ['no obvious filesystem, network, process, logging, time, random, or environment effects detected'],
    },
    side_effects: sideEffects,
    candidate_inputs: [],
    candidate_outputs: [],
    oracles: [],
    obligations: {
      present: [],
      missing: [],
    },
    generated_cases: [],
    harness_suggestions: [],
  };
}

function scanJsTsFile(root, relPath, text, language) {
  const out = [];
  const seen = new Set();
  const commonJsExports = commonJsExportMap(text);
  const add = (record) => {
    const key = `${record.name}:${record.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(record);
  };

  const functionRe = /\bexport\s+(default\s+)?(async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*([^{};]*)\{/g;
  for (const match of text.matchAll(functionRe)) {
    const openIndex = match.index + match[0].lastIndexOf('{');
    const closeIndex = findMatchingBrace(text, openIndex);
    const body = closeIndex >= 0 ? text.slice(openIndex + 1, closeIndex) : '';
    const signature = match[0].slice(0, -1);
    add(makeFunctionRecord({
      relPath,
      language,
      name: match[3],
      visibility: 'exported',
      signature,
      params: parseJsTsParams(match[4]),
      returns: parseReturnType(language, match[5]),
      body,
      comments: extractLeadingComment(text, match.index),
      async: Boolean(match[2]),
      startIndex: match.index,
      text,
    }));
  }

  const arrowRe = /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*([^=;{}]*?)=>/g;
  for (const match of text.matchAll(arrowRe)) {
    const arrowIndex = match.index + match[0].lastIndexOf('=>');
    const afterArrow = text.slice(arrowIndex + 2);
    const openOffset = afterArrow.search(/\S/);
    const openIndex = openOffset >= 0 ? arrowIndex + 2 + openOffset : arrowIndex + 2;
    let body = '';
    if (text[openIndex] === '{') {
      const closeIndex = findMatchingBrace(text, openIndex);
      body = closeIndex >= 0 ? text.slice(openIndex + 1, closeIndex) : '';
    } else {
      body = text.slice(openIndex, expressionEnd(text, openIndex));
    }
    const signature = text.slice(match.index, arrowIndex + 2);
    add(makeFunctionRecord({
      relPath,
      language,
      name: match[1],
      visibility: 'exported',
      signature,
      params: parseJsTsParams(match[3] || match[4] || ''),
      returns: parseReturnType(language, match[5]),
      body,
      comments: extractLeadingComment(text, match.index),
      async: Boolean(match[2]),
      startIndex: match.index,
      text,
    }));
  }

  const commonJsRe = /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)\s*([^{};]*)\{/g;
  for (const match of text.matchAll(commonJsRe)) {
    const openIndex = match.index + match[0].lastIndexOf('{');
    const closeIndex = findMatchingBrace(text, openIndex);
    const body = closeIndex >= 0 ? text.slice(openIndex + 1, closeIndex) : '';
    const signature = match[0].slice(0, -1);
    add(makeFunctionRecord({
      relPath,
      language,
      name: match[1],
      visibility: 'exported',
      signature,
      params: parseJsTsParams(match[3]),
      returns: parseReturnType(language, match[4]),
      body,
      comments: extractLeadingComment(text, match.index),
      async: Boolean(match[2]),
      startIndex: match.index,
      text,
    }));
  }

  if (commonJsExports.size > 0) {
    const localFunctionRe = /\b(async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*([^{};]*)\{/g;
    for (const match of text.matchAll(localFunctionRe)) {
      if (!commonJsExports.has(match[2])) continue;
      const openIndex = match.index + match[0].lastIndexOf('{');
      const closeIndex = findMatchingBrace(text, openIndex);
      const body = closeIndex >= 0 ? text.slice(openIndex + 1, closeIndex) : '';
      add(makeFunctionRecord({
        relPath,
        language,
        name: commonJsExports.get(match[2]) || match[2],
        visibility: 'exported',
        signature: match[0].slice(0, -1),
        params: parseJsTsParams(match[3]),
        returns: parseReturnType(language, match[4]),
        body,
        comments: extractLeadingComment(text, match.index),
        async: Boolean(match[1]),
        startIndex: match.index,
        text,
      }));
    }

    const localArrowRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*([^=;{}]*?)=>/g;
    for (const match of text.matchAll(localArrowRe)) {
      if (!commonJsExports.has(match[1])) continue;
      const arrowIndex = match.index + match[0].lastIndexOf('=>');
      const afterArrow = text.slice(arrowIndex + 2);
      const openOffset = afterArrow.search(/\S/);
      const openIndex = openOffset >= 0 ? arrowIndex + 2 + openOffset : arrowIndex + 2;
      let body = '';
      if (text[openIndex] === '{') {
        const closeIndex = findMatchingBrace(text, openIndex);
        body = closeIndex >= 0 ? text.slice(openIndex + 1, closeIndex) : '';
      } else {
        body = text.slice(openIndex, expressionEnd(text, openIndex));
      }
      add(makeFunctionRecord({
        relPath,
        language,
        name: commonJsExports.get(match[1]) || match[1],
        visibility: 'exported',
        signature: text.slice(match.index, arrowIndex + 2),
        params: parseJsTsParams(match[3] || match[4] || ''),
        returns: parseReturnType(language, match[5]),
        body,
        comments: extractLeadingComment(text, match.index),
        async: Boolean(match[2]),
        startIndex: match.index,
        text,
      }));
    }

    const localFunctionExpressionRe = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)\s*([^{};]*)\{/g;
    for (const match of text.matchAll(localFunctionExpressionRe)) {
      if (!commonJsExports.has(match[1])) continue;
      const openIndex = match.index + match[0].lastIndexOf('{');
      const closeIndex = findMatchingBrace(text, openIndex);
      const body = closeIndex >= 0 ? text.slice(openIndex + 1, closeIndex) : '';
      add(makeFunctionRecord({
        relPath,
        language,
        name: commonJsExports.get(match[1]) || match[1],
        visibility: 'exported',
        signature: match[0].slice(0, -1),
        params: parseJsTsParams(match[3]),
        returns: parseReturnType(language, match[4]),
        body,
        comments: extractLeadingComment(text, match.index),
        async: Boolean(match[2]),
        startIndex: match.index,
        text,
      }));
    }
  }

  return out;
}

function scanPythonFile(root, relPath, text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  const lineOffsets = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^(async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/);
    if (!match) continue;
    const name = match[2];
    const startIndex = lineOffsets[index];
    if (name.startsWith('_')) continue;
    const bodyLines = [];
    let bodyIndex = index + 1;
    for (; bodyIndex < lines.length; bodyIndex += 1) {
      const bodyLine = lines[bodyIndex];
      if (bodyLine.trim() && !/^\s+/.test(bodyLine)) break;
      bodyLines.push(bodyLine);
    }
    const body = bodyLines.join('\n');
    const leading = extractLeadingComment(text, startIndex, /^\s*#\s?(.*)$/);
    const docstring = extractPythonDocstring(body);
    out.push(makeFunctionRecord({
      relPath,
      language: 'python',
      name,
      visibility: 'public',
      signature: line,
      params: parsePythonParams(match[3]),
      returns: parseReturnType('python', match[4] || ''),
      body,
      comments: [leading, docstring].filter(Boolean).join('\n\n'),
      async: Boolean(match[1]),
      startIndex,
      text,
    }));
    index = bodyIndex - 1;
  }
  return out;
}

function scanGoFile(root, relPath, text) {
  const out = [];
  const functionRe = /\bfunc\s+(?:\([^)]*\)\s*)?([A-Z][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*([^{\n]*)\{/g;
  for (const match of text.matchAll(functionRe)) {
    const openIndex = match.index + match[0].lastIndexOf('{');
    const closeIndex = findMatchingBrace(text, openIndex);
    const body = closeIndex >= 0 ? text.slice(openIndex + 1, closeIndex) : '';
    out.push(makeFunctionRecord({
      relPath,
      language: 'go',
      name: match[1],
      visibility: 'public',
      signature: match[0].slice(0, -1),
      params: parseGoParams(match[2]),
      returns: parseReturnType('go', match[3] || ''),
      body,
      comments: extractLeadingComment(text, match.index),
      async: false,
      startIndex: match.index,
      text,
    }));
  }
  return out;
}

function scanRustFile(root, relPath, text) {
  const out = [];
  const functionRe = /\bpub(?:\([^)]*\))?\s+(async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>{}]*>)?\s*\(([^)]*)\)\s*(?:->\s*([^{\n]+))?\s*\{/g;
  for (const match of text.matchAll(functionRe)) {
    const openIndex = match.index + match[0].lastIndexOf('{');
    const closeIndex = findMatchingBrace(text, openIndex);
    const body = closeIndex >= 0 ? text.slice(openIndex + 1, closeIndex) : '';
    out.push(makeFunctionRecord({
      relPath,
      language: 'rust',
      name: match[2],
      visibility: 'public',
      signature: match[0].slice(0, -1),
      params: parseRustParams(match[3]),
      returns: parseReturnType('rust', match[4] || ''),
      body,
      comments: extractLeadingComment(text, match.index, /^\s*\/\/\/?\s?(.*)$/),
      async: Boolean(match[1]),
      startIndex: match.index,
      text,
    }));
  }
  return out;
}

function scrubForEffectScan(language, body) {
  let text = String(body || '');
  if (language === 'python') {
    text = text.replace(/("""|''')[\s\S]*?\1/g, '');
    text = text.replace(/#.*$/gm, '');
  } else {
    text = text.replace(/\/\*[\s\S]*?\*\//g, '');
    text = text.replace(/\/\/.*$/gm, '');
  }
  return text;
}

function detectSideEffects(language, body) {
  const text = scrubForEffectScan(language, body);
  const patterns = [
    { kind: 'filesystem', re: /\b(fs|Deno)\.|readFile|writeFile|appendFile|unlink|mkdir|rmdir|rename|open\s*\(|File::|std::fs|os\.(?:remove|unlink|rename|mkdir)|Path\([^)]*\)\.(?:write|unlink)|ioutil\.|os\.(?:Create|Open|WriteFile|Remove)/ },
    { kind: 'network', re: /\bfetch\s*\(|axios\.|XMLHttpRequest|http\.|https\.|requests\.|urllib\.|net\/http|http\.(?:Get|Post|Client)|reqwest|TcpStream|UdpSocket/ },
    { kind: 'process', re: /child_process|exec\s*\(|spawn\s*\(|process\.exit|subprocess\.|os\.system|exec\.Command|Command::new|std::process/ },
    { kind: 'logging', re: /console\.(?:log|warn|error|info)|\bprint\s*\(|logging\.|fmt\.Print|log\.|println!\s*\(|eprintln!\s*\(/ },
    { kind: 'time', re: /Date\.now|new\s+Date\s*\(|performance\.now|datetime\.now|time\.time|time\.Now|Instant::now|SystemTime::now/ },
    { kind: 'random', re: /Math\.random|crypto\.random|random\.|rand::|thread_rng|rand\./ },
    { kind: 'environment', re: /process\.env|os\.environ|env\.Getenv|std::env/ },
  ];
  const out = [];
  for (const pattern of patterns) {
    const match = text.match(pattern.re);
    if (!match) continue;
    out.push({
      kind: pattern.kind,
      match: match[0],
    });
  }
  return out;
}

function sampleValuesForType(type) {
  const lower = String(type || '').toLowerCase();
  if (!lower) return ['<value>'];
  if (/string|str|char|&str/.test(lower)) return ['""', '"sample"', '"unicode"'];
  if (/bool/.test(lower)) return ['true', 'false'];
  if (/number|int|float|double|i\d+|u\d+|usize|isize|f32|f64/.test(lower)) return ['0', '1', '-1'];
  if (/array|\[\]|list|vec|slice/.test(lower)) return ['[]', '[1]'];
  if (/map|dict|record|object/.test(lower)) return ['{}'];
  return [`<${type}>`];
}

function addSignatureCandidates(fn) {
  for (const param of fn.params) {
    fn.candidate_inputs.push({
      source: 'signature',
      param: param.name,
      type: param.type,
      samples: sampleValuesForType(param.type),
    });
  }
  if (fn.returns.type) {
    fn.candidate_outputs.push({
      source: 'signature',
      type: fn.returns.type,
      samples: sampleValuesForType(fn.returns.type),
    });
  }
}

function parseExamplesFromComments(fn) {
  const comments = fn.comments.join('\n');
  if (!comments) return;
  const re = new RegExp(`${escapeRegExp(fn.name)}\\s*\\(([^)]*)\\)\\s*(?:=>|==|=)\\s*([^\\n.;]+|\\[[^\\n]+\\]|\\{[^\\n]+\\})`, 'g');
  for (const match of comments.matchAll(re)) {
    const input = {
      source: 'comment-example',
      expression: `${fn.name}(${match[1].trim()})`,
      args: splitTopLevel(match[1]),
      raw: match[0].trim(),
    };
    const output = {
      source: 'comment-example',
      value: match[2].trim(),
      raw: match[0].trim(),
    };
    fn.candidate_inputs.push(input);
    fn.candidate_outputs.push(output);
    fn.oracles.push({
      kind: 'example',
      source: 'comment-example',
      expression: input.expression,
      expected: output.value,
    });
  }
}

function parseTestEvidence(fn, testFiles) {
  const namePattern = new RegExp(`\\b${escapeRegExp(fn.name)}\\b`);
  const expectCall = new RegExp(`expect\\s*\\(\\s*${escapeRegExp(fn.name)}\\s*\\(([^)]*)\\)\\s*\\)\\s*\\.to(?:Be|Equal|StrictEqual)\\s*\\(([^)]*)\\)`, 'g');
  const assertCall = new RegExp(`assert\\.(?:equal|strictEqual|deepEqual)\\s*\\(\\s*${escapeRegExp(fn.name)}\\s*\\(([^)]*)\\)\\s*,\\s*([^)]*)\\)`, 'g');
  for (const file of testFiles) {
    if (!namePattern.test(file.text)) continue;
    const lines = file.text.split(/\r?\n/).filter((line) => namePattern.test(line)).slice(0, 5);
    fn.oracles.push({
      kind: 'test-reference',
      source: 'existing-test',
      file: file.relPath,
      snippets: lines.map((line) => line.trim()),
    });
    for (const re of [expectCall, assertCall]) {
      re.lastIndex = 0;
      for (const match of file.text.matchAll(re)) {
        const input = {
          source: 'existing-test',
          file: file.relPath,
          expression: `${fn.name}(${match[1].trim()})`,
          args: splitTopLevel(match[1]),
          raw: match[0].trim(),
        };
        const output = {
          source: 'existing-test',
          file: file.relPath,
          value: match[2].trim(),
          raw: match[0].trim(),
        };
        fn.candidate_inputs.push(input);
        fn.candidate_outputs.push(output);
        fn.oracles.push({
          kind: 'assertion',
          source: 'existing-test',
          file: file.relPath,
          expression: input.expression,
          expected: output.value,
        });
      }
    }
  }
}

function hasPropertyEvidence(fn, testFiles) {
  return evidenceText(fn, testFiles, /\b(fast-check|fc\.|property\s*\(|hypothesis|quickcheck|proptest|go test\s+-fuzz|cargo fuzz)\b/i);
}

function hasFuzzEvidence(fn, testFiles) {
  return evidenceText(fn, testFiles, /\b(fuzz|corpus|fast-check|hypothesis|go test\s+-fuzz|cargo fuzz|libfuzzer)\b/i);
}

function hasDifferentialEvidence(fn, testFiles) {
  return evidenceText(fn, testFiles, /\b(differential|reference|oracle|golden|compare|legacy|metamorphic)\b/i);
}

function hasFormalComment(fn) {
  return /\b(invariant|ensures|requires|precondition|postcondition|theorem|proof|law|contract)\b/i.test(fn.comments.join('\n'));
}

function evidenceText(fn, testFiles, pattern) {
  if (pattern.test(fn.comments.join('\n'))) return true;
  const namePattern = new RegExp(`\\b${escapeRegExp(fn.name)}\\b`);
  return testFiles.some((file) => namePattern.test(file.text) && pattern.test(file.text));
}

function addObligations(fn, testFiles) {
  const present = new Set(['signature_inventory', 'surface_inventory', 'side_effect_classification']);
  if (fn.params.some((param) => param.type)) present.add('typed_inputs');
  if (fn.returns.type) present.add('typed_output');
  if (fn.purity.classification === 'pure') present.add('purity_classification');
  if (fn.side_effects.length > 0) present.add('effect_inventory');
  if (fn.oracles.length > 0) present.add('example_oracle');
  if (fn.oracles.some((oracle) => oracle.source === 'existing-test')) present.add('existing_test');
  if (hasPropertyEvidence(fn, testFiles)) present.add('property');
  if (hasFuzzEvidence(fn, testFiles)) present.add('fuzz');
  if (hasDifferentialEvidence(fn, testFiles)) present.add('differential');
  if (hasFormalComment(fn)) present.add('formal_comment');

  const missing = new Set();
  if (!present.has('example_oracle')) missing.add('oracle');
  if (!present.has('property')) missing.add('property');
  if (!present.has('fuzz')) missing.add('fuzz');
  if (fn.purity.classification === 'pure' && !present.has('differential')) missing.add('differential');
  if (!present.has('formal_comment')) missing.add('formal');
  if (fn.purity.classification === 'side_effectful' && !present.has('existing_test')) {
    missing.add('side_effect_harness');
  }

  fn.obligations = {
    present: [...present].sort(),
    missing: [...missing].sort(),
  };
}

function languageHarness(language, kind) {
  const matrix = {
    javascript: {
      property: 'fast-check property test under node:test',
      fuzz: 'node:test corpus replay plus generated edge cases',
      differential: 'node:test reference implementation comparator',
      formal: 'JSDoc contract/invariant checks plus type-aware lint',
      side_effect_harness: 'node:test with mocked fs/network/process adapters and snapshots',
    },
    typescript: {
      property: 'fast-check property test under node:test or vitest',
      fuzz: 'fast-check edge corpus with TypeScript type fixtures',
      differential: 'typed reference implementation comparator',
      formal: 'TSDoc invariant plus tsc/ESLint contract check',
      side_effect_harness: 'node:test with mocked fs/network/process adapters and snapshots',
    },
    python: {
      property: 'Hypothesis property test under pytest',
      fuzz: 'Hypothesis strategies and regression corpus',
      differential: 'pytest reference implementation comparator',
      formal: 'docstring contract with icontract/CrossHair-ready predicates',
      side_effect_harness: 'pytest monkeypatch/tmp_path side-effect harness',
    },
    go: {
      property: 'testing/quick property test',
      fuzz: 'Go native fuzz target with seed corpus',
      differential: 'go test reference implementation comparator',
      formal: 'commented invariants plus go vet/staticcheck assertions',
      side_effect_harness: 'go test with fake filesystem/network/process seams',
    },
    rust: {
      property: 'proptest property test',
      fuzz: 'cargo fuzz target with seed corpus',
      differential: 'cargo test reference implementation comparator',
      formal: 'doc-comment invariant plus optional kani/proptest proof harness',
      side_effect_harness: 'cargo test with tempdir/mock adapter side-effect harness',
    },
  };
  return (matrix[language] && matrix[language][kind]) || `${kind} harness`;
}

function buildGeneratedCases(fn) {
  const generated = [];
  const add = (kind, objective, detail = {}) => {
    generated.push({
      id: `${fn.id}:${kind}`,
      function_id: fn.id,
      function_name: fn.name,
      kind,
      objective,
      ...detail,
    });
  };

  const signatureInputs = fn.params.map((param) => ({
    name: param.name,
    type: param.type,
    samples: sampleValuesForType(param.type),
  }));

  if (fn.oracles.length === 0) {
    add('oracle', 'Record at least one expected output for a representative call.', {
      inputs: signatureInputs,
    });
  }
  if (fn.obligations.missing.includes('property')) {
    add('property', fn.purity.classification === 'pure'
      ? 'Assert deterministic and algebraic properties across generated inputs.'
      : 'Assert side effects stay within an allowlist across generated inputs.', {
        inputs: signatureInputs,
      });
  }
  if (fn.obligations.missing.includes('fuzz')) {
    add('fuzz', 'Generate edge-case inputs from the signature and replay any failures as corpus cases.', {
      inputs: signatureInputs,
    });
  }
  if (fn.obligations.missing.includes('differential')) {
    add('differential', 'Compare outputs against a reference, previous version, or independently written oracle.');
  }
  if (fn.obligations.missing.includes('formal')) {
    add('formal', 'Promote comment-level invariants into executable pre/post-condition checks.');
  }
  if (fn.obligations.missing.includes('side_effect_harness')) {
    add('side_effect_harness', 'Mock external dependencies and snapshot emitted effects.', {
      effects: fn.side_effects.map((effect) => effect.kind),
    });
  }

  fn.generated_cases = generated;
}

function buildHarnessSuggestions(fn) {
  fn.harness_suggestions = fn.obligations.missing.map((kind) => ({
    id: `${fn.id}:${kind}:harness`,
    function_id: fn.id,
    function_name: fn.name,
    kind,
    language: fn.language,
    suggestion: languageHarness(fn.language, kind),
    target_file: fn.file,
  }));
}

function finalizeFunction(fn, testFiles) {
  addSignatureCandidates(fn);
  parseExamplesFromComments(fn);
  parseTestEvidence(fn, testFiles);
  addObligations(fn, testFiles);
  buildGeneratedCases(fn);
  buildHarnessSuggestions(fn);
  return fn;
}

function scanSourceFile(root, relPath) {
  const language = languageForFile(relPath);
  const text = readText(path.resolve(root, relPath));
  if (!language || !text) return [];
  if (language === 'javascript' || language === 'typescript') return scanJsTsFile(root, relPath, text, language);
  if (language === 'python') return scanPythonFile(root, relPath, text);
  if (language === 'go') return scanGoFile(root, relPath, text);
  if (language === 'rust') return scanRustFile(root, relPath, text);
  return [];
}

function scanFunctionRepo(cwd = process.cwd(), options = {}) {
  const root = path.resolve(cwd);
  const limit = Number.isFinite(options.limit) ? options.limit : 2000;
  const allSourceFiles = listFiles(root, '.', (rel) => SOURCE_EXTENSIONS.has(path.extname(rel).toLowerCase()), limit);
  const sourceFiles = allSourceFiles.filter((rel) => !TEST_FILE_RE.test(rel));
  const testFiles = allSourceFiles
    .filter((rel) => TEST_FILE_RE.test(rel))
    .map((relPath) => ({
      relPath,
      text: readText(path.resolve(root, relPath)),
    }));

  const functions = [];
  for (const relPath of sourceFiles) {
    functions.push(...scanSourceFile(root, relPath));
  }
  for (const fn of functions) finalizeFunction(fn, testFiles);

  const missing = new Set();
  const generatedCases = [];
  const harnessSuggestions = [];
  for (const fn of functions) {
    for (const item of fn.obligations.missing) missing.add(item);
    generatedCases.push(...fn.generated_cases);
    harnessSuggestions.push(...fn.harness_suggestions);
  }

  return {
    schema: 'xoloop.function_scan.v0.1',
    cwd: root,
    files: sourceFiles,
    test_files: testFiles.map((file) => file.relPath).sort(),
    functions: functions.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name)),
    missing_obligations: [...missing].sort(),
    generated_cases: generatedCases,
    harness_suggestions: harnessSuggestions,
  };
}

module.exports = {
  scanFunctionRepo,
};
