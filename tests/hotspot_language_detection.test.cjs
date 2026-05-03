'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { detectHotspots } = require('../plugins/xoloop/lib/hotspot_detector.cjs');

test('hotspot detector finds repeated imports in Python, Ruby, Go, and Rust', () => {
  const cases = [
    ['python', 'import json\nimport json\n', 'json'],
    ['ruby', "require 'json'\nrequire 'json'\n", 'json'],
    ['go', 'package main\nimport "fmt"\nimport "fmt"\n', 'fmt'],
    ['rust', 'use std::fmt;\nuse std::fmt;\n', 'std::fmt'],
  ];

  for (const [language, source, moduleName] of cases) {
    const hotspots = detectHotspots(source, { language });
    assert.ok(
      hotspots.some((spot) => spot.type === 'repeated_import' && spot.module === moduleName),
      `${language} should report repeated import for ${moduleName}`,
    );
  }
});

test('hotspot detector still finds generic cache candidates for non-JS languages', () => {
  const hotspots = detectHotspots('value = expensive(input)\nother = expensive(input)\n', { language: 'python' });

  assert.ok(hotspots.some((spot) => spot.type === 'cache_candidate' && spot.call === 'expensive(input)'));
});
