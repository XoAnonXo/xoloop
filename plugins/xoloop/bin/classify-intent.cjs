#!/usr/bin/env node
/**
 * classify-intent.cjs — Adaptive UserPromptSubmit hook (locked A.3).
 *
 * Reads the UserPromptSubmit hook payload on stdin, classifies the prompt
 * against 8 XOLoop mode trigger sets, emits a routing nudge ONLY when a
 * match fires. Silent otherwise — per locked decision, medium-aggressiveness
 * boilerplate on every turn gets tuned out by the model.
 *
 * Design:
 *   - Pure pattern match, no LLM call, no network. Runs in milliseconds.
 *   - Emits `additionalContext` JSON to stdout for Claude Code to inject.
 *   - Non-matching prompts produce empty output (hook silent).
 *   - Multi-match prompts emit a tie-breaker hint listing candidates.
 *
 * Hook payload shape (per Claude Code docs):
 *   { user_prompt: string, session_id: string, cwd: string, ... }
 *
 * Output (per Claude Code hook protocol):
 *   JSON with `additionalContext` field OR empty for no-op.
 */

'use strict';

const MODE_TRIGGERS = {
  'xo-polish': {
    patterns: [
      /\b(polish|refine|clean\s*up|tighten|make\s+(this|it)\s+better|iterate\s+on|improve\s+(the\s+)?readab)/i,
      /\b(prettier|more\s+elegant|cleaner|neater)\b/i,
    ],
    antipatterns: [
      /\bbenchmark\b/i,
      /\bbuild\s+(a\s+)?new\b/i,
      /\bfind\s+bugs?\b/i,
    ],
    hint: 'User intent looks like POLISH. Consider routing through xo-polish skill (tournament-based refinement, no explicit benchmark required).',
  },

  'xo-build': {
    patterns: [
      // Verb + optional object + noun
      /\b(build|create|implement|scaffold)\s+(me\s+)?(a\s+|an\s+)?(new\s+|brand[\s-]new\s+)?\w/i,
      /\bwrite\s+(me\s+)?(a\s+|an\s+)?(new\s+|brand[\s-]new\s+)?(feature|function|module|utility|class|endpoint|api|helper|component|middleware|handler|service)/i,
      /\bfrom\s+scratch\b/i,
      /\bnet[\s-]new\b/i,
      /\bnew\s+(feature|function|module|utility|class|endpoint|api|helper|component|middleware|handler|service)/i,
    ],
    antipatterns: [
      /\b(polish|refine|audit|improve\s+existing|find\s+bugs?)\b/i,
    ],
    hint: 'User intent looks like BUILD. Consider routing through xo-build skill (serialized TDD: failing tests first, then implementation).',
  },

  'xo-audit': {
    patterns: [
      /\b(audit|security[\s-]review|find\s+bugs?|check\s+for\s+(vuln|issues|bugs)|what\s+could\s+go\s+wrong|review\s+(this|for)\s+issues)/i,
      /\bis\s+(this|the)\s+code\s+(correct|safe|secure)/i,
      /\b(vulnerab|TOCTOU|injection|leak)/i,
    ],
    antipatterns: [
      /\b(polish|make\s+(this|it)\s+better)\b/i,
    ],
    hint: 'User intent looks like AUDIT. Consider routing through xo-audit skill (Codex auditor + Opus fixer, fails closed on protocol drift).',
  },

  'xo-fuzz': {
    patterns: [
      /\b(fuzz|stress[\s-]test|property[\s-]test|find\s+edge\s+cases|random\s+inputs?|what\s+inputs?\s+(crash|break))/i,
      /\bthrow\s+(random|weird|bad)\s+data/i,
    ],
    antipatterns: [],
    hint: 'User intent looks like FUZZ. Consider routing through xo-fuzz skill (fast-check property-based fuzzing, writes crash corpus).',
  },

  'xo-benchmark': {
    patterns: [
      /\b(benchmark|lock\s+(the\s+)?output|regression\s+test|deterministic\s+(test|output))/i,
      /\bhow\s+fast\s+is\b/i,
      /\bmeasure\s+(the\s+)?(perf|speed|memory|cost)/i,
    ],
    antipatterns: [
      /\bimprove\b/i,
      /\bmake\s+(it|this)\s+faster\b/i,
    ],
    hint: 'User intent looks like BENCHMARK. Consider routing through xo-benchmark skill (SHA-256-locked deterministic output).',
  },

  'xo-improve': {
    patterns: [
      /\bmake\s+(it|this|\w+(\s+\w+)?)\s+(faster|smaller|cheaper)/i,
      /\breduce\s+(memory|cost|size|latency)/i,
      /\blower\s+(cost|latency|memory|compute)/i,
      /\boptimize\s+(for\s+)?(perf|speed|memory|cost|latency)/i,
      /\bhit\s+(a\s+|the\s+)?benchmark/i,
      /\bbeat\s+(the\s+)?baseline/i,
    ],
    antipatterns: [
      /\bfind\s+bugs?\b/i,
    ],
    hint: 'User intent looks like IMPROVE. Consider routing through xo-improve skill (benchmark-driven iteration toward a metric).',
  },

  'xo-autoresearch': {
    patterns: [
      /\b(research\s+alternatives?|find\s+a\s+(different|better)\s+(approach|way|implementation)|is\s+there\s+a\s+better\s+way|propose\s+(a\s+)?(radical\s+)?alternative|explore\s+.+?\s+(for|alternatives))/i,
      /\bwhat\s+else\s+could\s+we\s+use\s+instead/i,
    ],
    antipatterns: [],
    hint: 'User intent looks like AUTORESEARCH. Consider routing through xo-autoresearch skill (Champion vs Challenger tournament, heterogeneous council).',
  },

  'xo-overnight': {
    patterns: [
      /\brun\s+(the\s+)?overnight\b/i,
      /\brun\s+the\s+full\s+(loop|pipeline|xo)/i,
      /\bchain\s+(polish|audit|improve|fuzz)/i,
      /\bimprove\s+.+?\s+while\s+I\s+sleep\b/i,
      /\brun\s+all\s+modes\b/i,
      /\bovernight\s+engine\b/i,
      /\bfull\s+xo\s+pipeline\b/i,
    ],
    antipatterns: [],
    hint: 'User intent looks like OVERNIGHT. Consider routing through xo-overnight skill (full XO pipeline: polish + fuzz + benchmark + improve + audit).',
  },
};

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
    // Some hook runners don't keep stdin open; bail after 500ms if nothing came.
    setTimeout(() => resolve(buf), 500);
  });
}

function classify(prompt) {
  if (!prompt || typeof prompt !== 'string') return [];
  const matches = [];
  for (const [mode, config] of Object.entries(MODE_TRIGGERS)) {
    const hasAntipattern = (config.antipatterns || []).some((re) => re.test(prompt));
    if (hasAntipattern) continue;
    const hasPattern = config.patterns.some((re) => re.test(prompt));
    if (hasPattern) matches.push({ mode, hint: config.hint });
  }
  return matches;
}

function buildRouterMessage(matches) {
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    return `[XOLoop] ${matches[0].hint}`;
  }
  const modeList = matches.map((m) => m.mode).join(', ');
  return [
    `[XOLoop] User prompt matches multiple XOLoop modes: ${modeList}.`,
    'Consider which skill is the closest fit before writing code directly.',
    ...matches.map((m) => `  - ${m.mode}: ${m.hint}`),
  ].join('\n');
}

async function main() {
  let payload;
  try {
    const raw = await readStdin();
    if (!raw.trim()) { process.exit(0); }
    payload = JSON.parse(raw);
  } catch (_ignoreParseError) {
    // If we can't parse, stay silent — never break Claude Code for a hook.
    process.exit(0);
  }
  const prompt = payload && (payload.user_prompt || payload.prompt || payload.message);
  const matches = classify(prompt);
  const message = buildRouterMessage(matches);
  if (message) {
    // Emit additionalContext per Claude Code hook protocol.
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: message,
      },
    }));
  }
  process.exit(0);
}

main().catch(() => process.exit(0)); // Hook NEVER breaks the session
