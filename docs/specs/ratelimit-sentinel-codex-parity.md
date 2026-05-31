---
title: RateLimitSentinel codex parity (codex-aware recovery + dark detection)
slug: ratelimit-sentinel-codex-parity
status: approved
review-convergence: 2026-05-31T02:30:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the standing 12h autonomous deploy mandate (topic 13435,
  2026-05-30/31: "any robustness or Codex issue I find, I fix as a proper fleet PR").
  An INDEPENDENT second-pass review CONCURRED on shipping with detection DARK (it verified
  the v1 bug is gone, the Claude path is byte-for-byte unchanged, and the new helper is
  correct + perf-safe). The review's one real finding — a concurrent-codex-session false
  recovery — is gated entirely behind the default-off flag and is documented below as a
  hard must-fix BEFORE the flag is enabled. Ships DARK.
second-pass-required: true
second-pass-status: concur-ship-dark
---

# RateLimitSentinel codex parity

## Problem

`RateLimitSentinel` keeps a throttled session alive — detect → "backing off" notice →
escalating-backoff nudge → verify recovery by watching the session's transcript JSONL
GROW → escalate. The whole lifecycle was **claude-only** on both ends: detection (claude
panes / claude-PID watchdog) and recovery-verification (`readJsonlBaseline` →
`$HOME/.claude/projects/...`). A codex session throttled by OpenAI is invisible to it and
can hang with no recovery — the exact failure the sentinel exists to prevent, but only
for Claude. (v1 of this fix was correctly bounced by review for wiring the codex rollout
id to `claudeSessionId`, which is undefined for codex.)

## Design (v2)

**Recovery — account-wide newest-rollout signal.** The OpenAI rate limit is ACCOUNT-WIDE,
so "did the throttle clear?" == "is the codex account producing output again?" == "did the
newest rollout grow?". `readJsonlBaseline` gains a codex branch: when
`getSessionFramework(name) === 'codex-cli'` it returns the newest codex rollout via the
new sync `findNewestRolloutSync(codexHome)` (newest day partition, newest-by-filename,
single `statSync` — perf-safe, no stat-storm). NO per-session UUID (that was v1's bug);
deps are `getSessionFramework` + `codexHome` only. The existing `verify()` size-growth +
baseline-refresh logic is reused unchanged.

**Vendor wording.** `vendor(sessionName)` returns per-framework provider/agent/statusUrl;
codex throttle notices say OpenAI / status.openai.com. Claude strings are byte-identical.

**Detection — dark poll.** A `server.ts` poll (gated on `codexUsageDetection`, default
OFF) reads `readLatestCodexUsage()`; when codex flags `rateLimitReachedType`, it reports
each running codex session into the sentinel (deduped). The existing claude triggers are
untouched.

## Safety / rollback
- Claude behavior is byte-for-byte unchanged (every codex path is framework-gated;
  18 existing message-asserting tests pass).
- Detection ships DARK (`monitoring.rateLimitSentinel.codexUsageDetection`, default false).
  Rollback = set it false (instant). PR revert is clean (additive).

## KNOWN LIMITATION — must-fix BEFORE enabling `codexUsageDetection`
The recovery watches the ACCOUNT's newest rollout, not a specific session's. Correct for
ONE codex session (today's reality). With **≥2 concurrent throttled codex sessions**, one
session's resumed output grows the shared newest rollout and would recover ALL reported
sessions — including a sibling that is genuinely still stuck (a false recovery). Safe
while DARK + single-session. Before flipping the flag on a host that can run ≥2 concurrent
codex sessions, make recovery per-session (track the session's own rollout) OR redefine it
as account-level with a per-session re-probe. (2nd-pass review item 2.) Also: codex may
rotate to a fresh smaller rollout on resume → a first-cycle growth miss that self-heals on
the next cycle via baseline-refresh.

## Test plan (3-tier)
- **Unit:** `findNewestRolloutSync` (newest-by-filename, month/year crossing, empty
  partition skip, null on missing/non-codex, single-stat perf). RateLimitSentinel codex
  recovery (grow→recover, no-grow→escalate, codex vendor wording = OpenAI not Anthropic).
  Claude path unchanged (existing suite).
- **Integration/E2E (follow-up, should-fix per review item 3):** exercise the server.ts
  detection poll (gate-defaults-off + codex-filter + per-session fan-out). Tracked; the
  poll ships dark so the gap is lower-risk.
