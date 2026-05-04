'use strict';

/*
Closed integer interval sets over a bounded integer universe.

Representation:
  { lo: integer, hi: integer, intervals: [[a,b], ...] }
where intervals are canonical: sorted, non-overlapping, non-adjacent, and every
endpoint is inside [lo, hi]. All exported operations are deterministic and pure:
they return new frozen objects and never mutate their inputs.

Text format:
  "0..10:"                  empty set over universe [0,10]
  "0..10:1..3,5,7..9"      intervals [1,3], [5,5], [7,9]
Whitespace is ignored around separators. Singletons may be written as "5".
*/

class IntervalSetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntervalSetError';
  }
}

function isInteger(n) {
  return Number.isInteger(n) && Number.isSafeInteger(n);
}

function assertInteger(n, name) {
  if (!isInteger(n)) throw new IntervalSetError(`${name} must be a safe integer`);
}

function assertUniverse(lo, hi) {
  assertInteger(lo, 'universe lo');
  assertInteger(hi, 'universe hi');
  if (lo > hi) throw new IntervalSetError('universe lo must be <= hi');
}

function freezeSet(lo, hi, intervals) {
  const frozenIntervals = intervals.map(([a, b]) => Object.freeze([a, b]));
  return Object.freeze({ lo, hi, intervals: Object.freeze(frozenIntervals) });
}

function normalize(lo, hi, intervals) {
  assertUniverse(lo, hi);
  if (!Array.isArray(intervals)) throw new IntervalSetError('intervals must be an array');

  const parts = intervals.map((iv, i) => {
    if (!Array.isArray(iv) || iv.length !== 2) {
      throw new IntervalSetError(`interval ${i} must be [start,end]`);
    }
    const [a, b] = iv;
    assertInteger(a, `interval ${i} start`);
    assertInteger(b, `interval ${i} end`);
    if (a > b) throw new IntervalSetError(`interval ${i} start must be <= end`);
    if (a < lo || b > hi) throw new IntervalSetError(`interval ${i} is outside universe`);
    return [a, b];
  }).sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  const out = [];
  for (const [a, b] of parts) {
    const last = out[out.length - 1];
    if (!last || a > last[1] + 1) out.push([a, b]);
    else if (b > last[1]) last[1] = b;
  }
  return freezeSet(lo, hi, out);
}

function empty(lo, hi) {
  return normalize(lo, hi, []);
}

function full(lo, hi) {
  return normalize(lo, hi, [[lo, hi]]);
}

function parse(text) {
  if (typeof text !== 'string') throw new IntervalSetError('input must be a string');
  const m = text.trim().match(/^([+-]?\d+)\s*\.\.\s*([+-]?\d+)\s*:(.*)$/s);
  if (!m) throw new IntervalSetError('expected format "lo..hi:item,item..item"');
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  assertUniverse(lo, hi);

  const body = m[3].trim();
  if (body === '') return empty(lo, hi);

  const intervals = body.split(',').map((raw, i) => {
    const part = raw.trim();
    if (part === '') throw new IntervalSetError(`empty interval at position ${i}`);
    const range = part.match(/^([+-]?\d+)\s*\.\.\s*([+-]?\d+)$/);
    const single = part.match(/^([+-]?\d+)$/);
    if (range) return [Number(range[1]), Number(range[2])];
    if (single) return [Number(single[1]), Number(single[1])];
    throw new IntervalSetError(`invalid interval syntax at position ${i}: ${JSON.stringify(part)}`);
  });
  return normalize(lo, hi, intervals);
}

function format(set) {
  const s = coerce(set);
  const body = s.intervals.map(([a, b]) => a === b ? String(a) : `${a}..${b}`).join(',');
  return `${s.lo}..${s.hi}:${body}`;
}

function coerce(set) {
  if (!set || typeof set !== 'object') throw new IntervalSetError('set must be an object');
  return normalize(set.lo, set.hi, set.intervals);
}

function assertSameUniverse(a, b) {
  if (a.lo !== b.lo || a.hi !== b.hi) throw new IntervalSetError('sets must share the same universe');
}

function contains(set, value) {
  const s = coerce(set);
  assertInteger(value, 'value');
  if (value < s.lo || value > s.hi) return false;
  let l = 0, r = s.intervals.length - 1;
  while (l <= r) {
    const mid = (l + r) >> 1;
    const [a, b] = s.intervals[mid];
    if (value < a) r = mid - 1;
    else if (value > b) l = mid + 1;
    else return true;
  }
  return false;
}

function union(aSet, bSet) {
  const a = coerce(aSet), b = coerce(bSet);
  assertSameUniverse(a, b);
  return normalize(a.lo, a.hi, a.intervals.concat(b.intervals));
}

function intersect(aSet, bSet) {
  const a = coerce(aSet), b = coerce(bSet);
  assertSameUniverse(a, b);
  const out = [];
  let i = 0, j = 0;
  while (i < a.intervals.length && j < b.intervals.length) {
    const [x1, x2] = a.intervals[i];
    const [y1, y2] = b.intervals[j];
    const lo = Math.max(x1, y1), hi = Math.min(x2, y2);
    if (lo <= hi) out.push([lo, hi]);
    if (x2 < y2) i++; else j++;
  }
  return normalize(a.lo, a.hi, out);
}

function complement(set) {
  const s = coerce(set);
  const out = [];
  let cursor = s.lo;
  for (const [a, b] of s.intervals) {
    if (cursor < a) out.push([cursor, a - 1]);
    cursor = b + 1;
  }
  if (cursor <= s.hi) out.push([cursor, s.hi]);
  return normalize(s.lo, s.hi, out);
}

function diff(aSet, bSet) {
  const a = coerce(aSet), b = coerce(bSet);
  assertSameUniverse(a, b);
  return intersect(a, complement(b));
}

function measure(set) {
  const s = coerce(set);
  return s.intervals.reduce((sum, [a, b]) => sum + (b - a + 1), 0);
}

function equals(aSet, bSet) {
  const a = coerce(aSet), b = coerce(bSet);
  if (a.lo !== b.lo || a.hi !== b.hi || a.intervals.length !== b.intervals.length) return false;
  return a.intervals.every(([x1, x2], i) => x1 === b.intervals[i][0] && x2 === b.intervals[i][1]);
}

function subset(aSet, bSet) {
  const a = coerce(aSet), b = coerce(bSet);
  assertSameUniverse(a, b);
  return equals(diff(a, b), empty(a.lo, a.hi));
}

module.exports = {
  IntervalSetError,
  normalize,
  empty,
  full,
  parse,
  format,
  contains,
  union,
  intersect,
  diff,
  complement,
  measure,
  equals,
  subset,
};
