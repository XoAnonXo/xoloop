#!/usr/bin/env node
'use strict';

class Parser {
  constructor(text) {
    this.text = String(text);
    this.i = 0;
  }
  fail(message) {
    throw new Error(`${message} at byte ${this.i}`);
  }
  ws() {
    while (/[\t\n\r ]/.test(this.text[this.i])) this.i += 1;
  }
  expect(ch) {
    if (this.text[this.i] !== ch) this.fail(`expected ${JSON.stringify(ch)}`);
    this.i += 1;
  }
  string() {
    this.expect('"');
    while (this.i < this.text.length) {
      const ch = this.text[this.i++];
      if (ch === '"') return;
      if (ch === '\\') {
        const esc = this.text[this.i++];
        if ('"\\/bfnrt'.includes(esc)) continue;
        if (esc !== 'u' || !/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.i, this.i + 4))) this.fail('invalid escape');
        this.i += 4;
      } else if (ch < ' ') {
        this.fail('control character in string');
      }
    }
    this.fail('unterminated string');
  }
  number() {
    const start = this.i;
    if (this.text[this.i] === '-') this.i += 1;
    if (this.text[this.i] === '0') this.i += 1;
    else if (/[1-9]/.test(this.text[this.i])) while (/[0-9]/.test(this.text[this.i])) this.i += 1;
    else this.fail('invalid number');
    if (this.text[this.i] === '.' || this.text[this.i] === 'e' || this.text[this.i] === 'E') this.fail('floats are not supported');
    if (!Number.isSafeInteger(Number(this.text.slice(start, this.i)))) this.fail('unsafe integer');
  }
  literal(word) {
    if (this.text.slice(this.i, this.i + word.length) !== word) this.fail(`expected ${word}`);
    this.i += word.length;
  }
  array() {
    this.expect('[');
    this.ws();
    if (this.text[this.i] === ']') {
      this.i += 1;
      return;
    }
    while (this.i < this.text.length) {
      this.value();
      this.ws();
      if (this.text[this.i] === ']') {
        this.i += 1;
        return;
      }
      this.expect(',');
      this.ws();
    }
    this.fail('unterminated array');
  }
  object() {
    this.expect('{');
    const keys = new Set();
    this.ws();
    if (this.text[this.i] === '}') {
      this.i += 1;
      return;
    }
    while (this.i < this.text.length) {
      this.ws();
      const start = this.i;
      this.string();
      const key = JSON.parse(this.text.slice(start, this.i));
      if (keys.has(key)) this.fail(`duplicate key ${JSON.stringify(key)}`);
      keys.add(key);
      this.ws();
      this.expect(':');
      this.ws();
      this.value();
      this.ws();
      if (this.text[this.i] === '}') {
        this.i += 1;
        return;
      }
      this.expect(',');
      this.ws();
    }
    this.fail('unterminated object');
  }
  value() {
    this.ws();
    const ch = this.text[this.i];
    if (ch === '{') return this.object();
    if (ch === '[') return this.array();
    if (ch === '"') return this.string();
    if (ch === 't') return this.literal('true');
    if (ch === 'f') return this.literal('false');
    if (ch === 'n') return this.literal('null');
    if (ch === '-' || /[0-9]/.test(ch)) return this.number();
    this.fail('expected JSON value');
  }
  all() {
    this.value();
    this.ws();
    if (this.i !== this.text.length) this.fail('trailing characters');
  }
}

function canon(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    new Parser(input).all();
    process.stdout.write(`${canon(JSON.parse(input))}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
    process.exitCode = 1;
  }
});
