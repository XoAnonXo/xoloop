---
name: xo-audit
description: Use this skill when the user asks to audit, review, find bugs, security-check, or validate the correctness of existing code. Runs a subagent-driven audit-then-fix loop — first subagent (auditor) finds P1/P2/P3/low findings, subsequent subagents (one per blocking finding) each return a changeSet fix, applied atomically with test-gated rollback, until only low findings remain or iteration cap hit. Default 7 iterations. Not for polishing working code (use xo-polish), not for perf (use xo-improve).
allowed-tools: Agent, Bash, Read, Edit, Write
---

# XOLoop — Audit Mode (subagent-driven)

Closed-loop bug hunt via subagents. One subagent acts as **auditor**;
subsequent subagents act as **fixers**, each addressing one blocking
finding. All apply through the same test-gated engine bridge as polish.

**Default operational mode — no API key required.** Engine-mode
(`xoloop-audit.cjs`) is available as EXTRA for headless/CI use.

## When to invoke

- "audit this"
- "find bugs in X"
- "security review Y"
- "check Z for vulnerabilities"
- "is this code correct?"
- "what could go wrong with this?"

## Verify / Discovery gate

For fix mode on behavior-sensitive, stateful, concurrent, public API, or
safety-relevant code, run `xoloop-verify discover --write --json` before
fixer subagents mutate files. Select repo-specific suites from detected
frontend, api, state, function, runtime-lab, performance, formal, cli,
concurrency, state-machine, and safety surfaces. Fixes should leave
relevant goals at `PASS_EVIDENCED`; `PASS_WITH_GAPS` requires accepted
named gaps, and
`FAIL`/`NO_EVIDENCE` blocks broad auto-fix.

## How it runs

1. **Initialize or resume the session.** Run
   `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-session.cjs init --mode audit
   --objective "<what we're auditing>" --files "<paths>"`. Creates
   `.xoloop/session.md` + `.xoloop/session.jsonl`. If a session
   already exists, read it — prior findings and dead-ends help.
2. **Read target** (file or directory list).
3. **Discover validation command** (same as polish).
4. **Round 1 — Auditor subagent.** Spawn Agent with prompt:
   > Review these files for P1 (exploitable / silent data corruption),
   > P2 (breaks under unusual conditions), P3 (code smell), and low
   > findings. Return ONLY a JSON array:
   > `[{"severity":"P1","file":"rel/path","line":42,"issue":"..."}]`
4. **Filter** by severity floor (default P2 — means fix P1 and P2).
5. **For each blocking finding (up to iteration cap, default 7):**
   a. Spawn a fixer subagent with the specific finding + current
      file content + rationale request. Demand a changeSet proposal
      in the same schema as xo-polish.
   b. Shell out to
      `node $CLAUDE_PLUGIN_ROOT/bin/xoloop-apply-proposal.cjs` with
      the proposal + validate command.
   c. Read the JSON report. Keep on success, note rollback on fail.
6. **Re-audit round (final subagent call)** — run the auditor once
   more against the fixed state. If any blocking findings remain, loop
   ends with "iteration cap exhausted" or continues if budget allows.
7. **Report**: findings by severity (original vs remaining), fixes
   landed, fixes rolled back.

## Proposal JSON schema

Same as xo-polish (see its SKILL.md). Each fixer subagent emits one
changeSet addressing ONE finding.

## Defaults

| Setting | Default |
|---|---|
| Iterations | 7 |
| Severity floor | P2 (block-and-fix P1+P2; leave P3/low as reports) |
| Validation | detected from repo |
| Read-only mode | pass `read-only: true` — skips all fixer subagents, just reports findings |

## What audit does NOT do

- **Not for refinement** → `xo-polish`
- **Not for perf** → `xo-improve`
- **Not for implementation alternatives** → `xo-autoresearch`

## EXTRA: API-key mode (codex auditor + Opus fixer)

For unattended audits with an available API key:
```bash
node $CLAUDE_PLUGIN_ROOT/bin/xoloop-audit.cjs \
  --target <path> --severity-floor P2 --max-rounds 10
```
Uses codex CLI for the auditor and Opus-via-API for the fixer.

## Safety

- Apply is atomic + TOCTOU-protected (same bridge as polish)
- Validation-failed changeSets auto-rollback
- First finding's fix is shown to user for approval before remaining
  fixes auto-apply (trust-building first iteration)
