# xo-verify interval-set MVP

A deliberately small, deterministic target for future verification experiments:
closed integer interval sets over a bounded universe.

The implementation is standalone CommonJS with pure operations and canonical
output. It intentionally includes no tests or verification manifests.

## Text format

```text
0..10:              # empty set in universe [0,10]
0..10:1..3,5,7..9  # [1,3] ∪ [5,5] ∪ [7,9]
```

Whitespace around separators is accepted. Formatting always emits canonical
sorted, merged, non-adjacent intervals.

## API

```js
const I = require('./interval-set.cjs');

const a = I.parse('0..10:1..3,5');
const b = I.parse('0..10:3..8');

I.format(I.union(a, b));      // '0..10:1..8'
I.format(I.intersect(a, b));  // '0..10:3,5'
I.format(I.diff(a, b));       // '0..10:1..2'
I.format(I.complement(a));    // '0..10:0,4,6..10'
I.contains(a, 2);             // true
I.measure(a);                 // 4
I.equals(a, b);               // false
I.subset(a, b);               // false
```

Exports: `IntervalSetError`, `normalize`, `empty`, `full`, `parse`, `format`,
`contains`, `union`, `intersect`, `diff`, `complement`, `measure`, `equals`,
`subset`.

## CLI

```bash
node cli.cjs normalize '0..10:5,1..3,4'
node cli.cjs union '0..10:1..3' '0..10:3..5'
node cli.cjs contains '0..10:1..3' 2
node cli.cjs measure '0..10:1..3,7'
```
