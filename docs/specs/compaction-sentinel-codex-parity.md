---
title: CompactionSentinel codex parity (codex-aware recovery verification)
slug: compaction-sentinel-codex-parity
status: approved
review-convergence: 2026-05-31T02:45:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h autonomous deploy mandate (topic 13435,
  "any robustness or Codex issue I find, I fix as a proper fleet PR"). An INDEPENDENT
  second-pass review CONCURRED on shipping (active, not dark) with NO must-fix items — it
  verified the Claude path is byte-for-byte unchanged, the fix is strictly-better than the
  current broken-for-codex behavior (worst case degrades to today's null-return), and the
  concurrent-codex-session caveat is less harmful than the redundant re-injection it
  replaces. This is a faithful application of the already-shipped + already-reviewed
  RateLimitSentinel #33 recipe to the second of the two sentinels #26 traced as codex-blind.
second-pass-required: true
second-pass-status: concur-ship-active
---

# CompactionSentinel codex parity

## Problem

CompactionSentinel detects a session that didn't recover after compaction, re-injects a
recovery prompt (`recoverFn`), and verifies recovery by watching the session's transcript
JSONL GROW; if no growth it RETRIES re-injection up to `maxInjectAttempts` then emits
`compaction:failed`. Its `readJsonlBaseline` only knew the Claude projects path
(`$HOME/.claude/projects/<hash>`), so for a CODEX session it returned `null` → verification
could NEVER confirm growth → the sentinel re-injected the recovery prompt up to 3× per
codex compaction (stacking bootstraps under the user's real message — the "false session
is restarting" loop the code itself warns about) then emitted a false `compaction:failed`.

This is the second of the two sentinels #26 traced as codex-blind (RateLimitSentinel was
the first, fixed in #33).

## Design (the #33 recipe, faithfully reapplied)

`readJsonlBaseline` gains a codex branch: when `getSessionFramework(name) === 'codex-cli'`
it returns the newest codex rollout via `findNewestRolloutSync(codexHome)` (the OpenAI
account is account-wide, so "is codex producing output again?" == "did the newest rollout
grow?"; NO per-session UUID — that was #33-v1's bug). Deps `getSessionFramework` +
`codexHome` added; `server.ts` wires `getSessionFramework`. No vendor messages needed
(CompactionSentinel emits events, not user-facing vendor-specific text). The existing
`verify()` size-growth + baseline-refresh logic is reused unchanged.

## Safety
- Claude path byte-for-byte unchanged (codex branch strictly gated on `codex-cli`; the
  22 existing CompactionSentinel tests pass).
- Worst case (codex tree unreadable / no rollout) the codex branch returns `null` — exactly
  today's behavior. Everywhere it returns non-null it only ENABLES a correct recovery
  detection that is impossible today. So the fix is strictly-better than the current broken
  state (2nd-pass-verified).
- Ships ACTIVE (no flag) — appropriate because the failure it fixes (redundant
  bootstrap-stacking + false `compaction:failed` on every codex compaction) is firing today.

## Known limitation (same as #33, not a must-fix)
The account-wide newest-rollout signal is shared across concurrent codex sessions — with
≥2 concurrent codex compactions, one session's output could false-recover a still-stuck
sibling. For CompactionSentinel this means stopping a re-injection one cycle early (LESS
harmful than the current redundant re-inject), and a future compaction detection re-triggers
recovery. Correct for single-codex-session (the operational reality). Per-session rollout
tracking is the eventual close (tracked with #33's same caveat).

## Test plan (3-tier)
- **Unit (`CompactionSentinel-codex.test.ts`):** codex session recovers when its newest
  rollout grows; fails (no false-recover) when it never grows. Claude path unchanged
  (existing `CompactionSentinel.test.ts`, 22 tests).
- The detection (PreCompact / watchdog triggers) is framework-neutral already; the gap was
  purely the recovery-verification path fixed here.
