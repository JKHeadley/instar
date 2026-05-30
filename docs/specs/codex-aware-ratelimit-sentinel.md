---
title: Codex-aware RateLimitSentinel (detection + recovery parity)
status: approved
author: echo
date: 2026-05-30
review-convergence: "self-converged"
review-iterations: 1
approved: true
approved-note: "Fast-tracked by echo in autonomous mode under the standing 12h deploy mandate (topic 13435: 'any robustness or Codex issue I find, I fix as a proper fleet PR'). Codex-parity fix; framework-gated so Claude behavior is unchanged (lower blast radius than the autonomous-loop driver, which IS gated on Justin). Second-pass reviewer required (sentinel change) — see Phase 5. Disclosed in the PR."
---

# Codex-aware RateLimitSentinel — detection + recovery parity

## Problem

`RateLimitSentinel` keeps a throttled or transient-errored session alive: it detects
the stall, sends the user a "backing off, you're not dropped" notice, retries with
escalating backoff, verifies recovery by watching the session's transcript JSONL grow,
and escalates if it never clears. This whole lifecycle is **claude-only** on both ends:

1. **Detection is claude-specific.** The three `report()` triggers
   (`src/commands/server.ts:5774-5786`) fire from `SessionWatchdog`'s `rate-limited`
   event and `SessionManager`'s `rateLimitedAtIdle` / `apiErrorAtIdle` events — all of
   which read claude panes / claude PIDs / claude-pane throttle strings (the watchdog is
   claude-PID-only, per the #27 finding). A codex `exec` session that hits an OpenAI
   rate limit and goes idle emits none of these → the sentinel never hears about it.

2. **Recovery-verification is claude-specific.** `readJsonlBaseline()`
   (`src/monitoring/RateLimitSentinel.ts`) resolves the transcript under
   `$HOME/.claude/projects/<project-hash>` via `getClaudeSessionId`. For a codex session
   this returns `null`, so the "did the JSONL grow? → throttle cleared" check can never
   confirm recovery — even if detection were wired, recovery would never verify.

The recovery **action** (`resumeFn` / `notifyFn` in `sentinelWiring`) is already
framework-neutral (tmux `send-keys` injection + topic/lifeline notice), so only the two
ends above are blind. Net effect: a rate-limited codex session (e.g. Codey, which shares
the rate-limited OpenAI account) can hang indefinitely, invisible to the sentinel — the
exact failure the sentinel exists to prevent, but only for Claude.

## Design

Both ends become framework-aware; Claude paths are untouched (framework-gated).

### Detection — codex-usage poll
Add a codex-native detection trigger that reuses the existing monitoring/watchdog poll
cadence (no new timer). For each **running codex session**, call the already-shipped
`readLatestCodexUsage()` (the `/codex/usage` reader, #577). Trigger `report()` when:
- `rate_limit_reached_type` is non-null (codex itself flagged a limit hit), OR
- the secondary (weekly) window `remainingPercent <= codexThrottleThreshold` (default 5),
  as an early-warning that the account is about to throttle.

Call `rateLimitSentinel.report(name, 'codex-usage-poll', { errorClass: 'throttle' })`.
The sentinel already dedupes `report()` per session, so a poll that fires every cycle
while the limit persists collapses to one active recovery. Framework-gate the poll so it
only runs for `framework === 'openai-codex'` sessions (claude sessions keep their
existing watchdog/idle triggers untouched — no double-fire).

### Recovery — framework-aware `readJsonlBaseline`
Add deps so the baseline reader can resolve a codex rollout:
- `getSessionFramework?(sessionName): string | undefined`
- `getCodexThreadId?(sessionName): string | undefined`
- `codexHome?: string`

In `readJsonlBaseline()`, branch on framework: when `codex`, resolve the rollout path via
the existing `findRolloutFileSync(threadId, codexHome)` (the codex-compat resume helper)
and `stat` it. Growth-based recovery verification is then identical to Claude (a codex
turn appends to its rollout JSONL exactly as a claude turn appends to its transcript).

### Wiring (`server.ts`)
Provide the three resolvers from `sessionManager.listRunningSessions()` (each running
session exposes `framework` and its codex thread id / `claudeSessionId`). Add the
codex-usage poll alongside the existing watchdog trigger registration.

## Blast radius / safety
- Claude behavior is byte-for-byte unchanged (every new path is `framework === codex`
  gated; the claude triggers and the claude `readJsonlBaseline` branch are untouched).
- No agent-installed file changes (no `.claude/settings.json`, config, CLAUDE.md, hook,
  or skill change) → **no PostUpdateMigrator entry required**; it ships in `dist/` via npm
  and reaches every agent on their normal update. (Confirm in the side-effects artifact.)
- The poll adds bounded work: `readLatestCodexUsage` tail-reads the newest rollout (the
  perf-hardened `listAllRollouts`, ~32 stats), once per codex session per poll cycle.

## Test plan (3-tier)
- **Unit:** `readJsonlBaseline` returns a codex rollout's size when framework=codex
  (and still returns the claude path when framework=claude); the detection predicate
  fires on `rate_limit_reached_type` set AND on `remaining <= threshold`, and does NOT
  fire when the account has headroom (both sides of the boundary).
- **Integration:** poll → `report('codex-usage-poll')` → recovery loop → `recovered`
  when the (mocked) codex rollout grows; `escalated` when it doesn't. Full HTTP path via
  `GET /rate-limit/status` reflecting the codex recovery.
- **E2E:** the sentinel is alive and codex-capable in the production init path (a codex
  session can enter + clear a recovery; route returns 200).

## Phase 5 — second-pass reviewer
Required (sentinel/monitoring change). Reviewer verifies: (a) no double-fire between the
codex poll and the claude triggers; (b) the framework gate can't accidentally suppress a
claude recovery; (c) the poll's per-cycle cost is bounded; (d) dedup holds when the limit
persists across many poll cycles.
