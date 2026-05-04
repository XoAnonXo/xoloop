'use strict';

function makeRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

class Arbitrary {
  constructor(generator) {
    this.generator = generator;
  }

  sample(random, index) {
    return this.generator(random, index);
  }
}

function arbitrary(generator) {
  return new Arbitrary(generator);
}

function pick(random, values) {
  return values[Math.floor(random() * values.length) % values.length];
}

function constant(value) {
  return arbitrary(() => value);
}

function constantFrom(...values) {
  return arbitrary((random) => pick(random, values));
}

function integer() {
  return arbitrary((random) => Math.floor((random() * 2000) - 1000));
}

function double() {
  return arbitrary((random) => {
    const special = [NaN, Infinity, -Infinity, 0, -0];
    if (random() < 0.15) return pick(random, special);
    return (random() * 2000) - 1000;
  });
}

function boolean() {
  return arbitrary((random) => random() >= 0.5);
}

function string() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789_-\n\t';
  return arbitrary((random) => {
    const length = Math.floor(random() * 24);
    let out = '';
    for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(random() * alphabet.length)];
    return out;
  });
}

function array(itemArbitrary = anything()) {
  return arbitrary((random, index) => {
    const length = Math.floor(random() * 8);
    const out = [];
    for (let i = 0; i < length; i += 1) out.push(itemArbitrary.sample(random, index + i));
    return out;
  });
}

function object() {
  return arbitrary((random, index) => {
    const out = {};
    const keys = ['a', 'b', 'c', '__proto__', 'constructor'];
    const count = Math.floor(random() * 5);
    for (let i = 0; i < count; i += 1) {
      out[pick(random, keys)] = anything().sample(random, index + i);
    }
    return out;
  });
}

function anything() {
  return arbitrary((random, index) => pick(random, [
    null,
    undefined,
    integer().sample(random, index),
    string().sample(random, index),
    boolean().sample(random, index),
    { value: integer().sample(random, index) },
    [string().sample(random, index), integer().sample(random, index)],
  ]));
}

function oneof(...arbitraries) {
  return arbitrary((random, index) => {
    const selected = pick(random, arbitraries);
    return selected.sample(random, index);
  });
}

function property(...args) {
  const predicate = args.pop();
  return { arbitraries: args, predicate };
}

function check(prop, options = {}) {
  const numRuns = Number.isFinite(options.numRuns) && options.numRuns > 0 ? Math.floor(options.numRuns) : 100;
  const random = makeRandom(options.seed);
  for (let i = 0; i < numRuns; i += 1) {
    const counterexample = prop.arbitraries.map((arb) => arb.sample(random, i));
    try {
      prop.predicate(...counterexample);
    } catch (error) {
      return { failed: true, counterexample, error };
    }
  }
  return { failed: false, counterexample: null, error: null };
}

module.exports = {
  array,
  anything,
  boolean,
  check,
  constant,
  constantFrom,
  double,
  integer,
  object,
  oneof,
  property,
  string,
};
