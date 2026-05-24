# Side-Effects Review — Codex token-ledger observability (Part A)

**Change:** Teach the TokenLedger to read Codex's persisted session rollouts so
Codex-engine agents' token usage is actually counted and surfaced on `/tokens/*`.
Closes the "ledger blind to Codex" finding (M-ledger-codex-blind) from the codey
live test. **Observability-only — no behavioural change.**

**Files:** `src/monitoring/CodexRolloutParser.ts` (new, pure), `src/monitoring/TokenLedger.ts`,
`src/monitoring/TokenLedgerPoller.ts`, `src/server/AgentServer.ts`, `src/server/routes.ts`
(+ tests, NEXT.md). **Spec basis:** TokenLedger's own contract ("read-only
observability; never gates jobs, throttles sessions, or reaches back into the
runtime") + Testing Integrity Standard (3 tiers) + the empirical Codex rollout
shape captured 2026-05-23 (Codex CLI 0.133.0).

## What changed

1. **CodexRolloutParser** — pure `parseCodexRollout(content)`: extracts session id /
   cwd / model / plan from `session_meta`+`turn_context`, and the LAST
   `token_count.info.total_token_usage` (cumulative, so last reading = session
   total — never summed) plus `rate_limits` used-percentages. No I/O.
2. **TokenLedger** — new `codex_token_sessions` table (session_id PK; cumulative
   totals; primary/secondary used-percent), `ingestCodexRollout` / `ingestCodexSession`
   (upsert, latest-wins, first_ts preserved), `scanCodexRolloutsAsync` (FS walk via
   the existing `listAllRollouts` helper, cwd-attributed), `codexSummary` / `codexSessions`.
   `summary()` / `byAttributionKey()` / `token_events` are **untouched**.
3. **TokenLedgerPoller** — optional `codexProjectDir`; when set, each tick also runs
   the Codex scan (chained after the Claude scan; either failing never stops the
   other or stacks ticks). Unset → Codex scan skipped entirely (Claude-only hosts).
4. **AgentServer** — passes `process.cwd()` (the agent's project dir, matching
   `session_meta.cwd`) as `codexProjectDir`.
5. **routes** — `/tokens/summary` gains an additive `codex` field; new
   `/tokens/codex-sessions`. Existing `summary` field unchanged.

## Over-block / under-block

- **BurnDetector isolation (the key risk):** `token_events` is also read by the
  BurnDetector (per-`attribution_key` rate polling). Codex rows go in a SEPARATE
  table and are surfaced only via NEW methods (`codexSummary`/`codexSessions`),
  which the BurnDetector never calls (`Pick<TokenLedger,'byAttributionKey'|'summary'>`).
  Two dedicated tests assert Codex ingest leaves `summary()` / `byAttributionKey()`
  / `topSessions()` empty. → BurnDetector provably unaffected. No alerting behavior
  changes.
- **Attribution over-grab:** the scan filters by `cwd === projectDir` (or a
  subdirectory). Codex's session store is machine-global, so without the filter an
  agent would ingest other agents' sessions. Tested: an other-agent rollout in the
  same store is excluded; subdir sessions are included.
- **Idempotency:** upsert keyed on session_id with cumulative latest-wins; re-scans
  do not duplicate or sum (tested across two scans and two ingests of a grown session).
- **Cost / event-loop:** scan reuses `listAllRollouts` (newest-first, capped at 500)
  with a 30-day age cutoff mirroring the Claude scan; runs fire-and-forget off the
  60s poller tick. Rollouts are small relative to Claude transcripts.

## Level-of-abstraction fit

Parsing-format knowledge lives in a dedicated pure module; persistence lives in
TokenLedger (which already inlines the Claude line shape); the FS walk reuses the
Codex adapter's existing `sessionPaths` helper. The poller stays a thin cadence
driver. No layering inversion beyond a pure-helper import (monitoring → the
adapter's pure `sessionPaths`).

## Signal vs authority

This is pure signal/observability. It assigns no authority: it never throttles,
gates, or alerts. The follow-up that WOULD give Codex usage authority (feeding
`rate_limits.used_percent` into burn-detection to replace the false budget alarm)
is explicitly NOT in this change — it is gated on an owner decision + its own
side-effects review.

## Interactions

- Dashboard `/tokens/summary` consumers: additive `codex` field; existing `summary`
  shape unchanged → no breakage.
- Claude-only hosts: `codexProjectDir` unset → zero new behavior, zero new I/O.
- Native module: only compiled `dist/*.js` is deployed to codey; codey's own
  better-sqlite3 (Node 22) creates the new table on init. The worktree's
  better-sqlite3 was rebuilt for Node 25 for the local test runner only.

## Rollback

Drop the `codex_token_sessions` table additions, the new TokenLedger methods, the
poller's `codexProjectDir` branch, the AgentServer arg, and the route additions
(+ the new parser and test files). `token_events` and all existing routes are
untouched, so rollback is clean and the Claude path is unaffected at every step.

## Evidence

- 27 tests across tiers: `CodexRolloutParser.test.ts` (8), `TokenLedger-codex.test.ts`
  (10, incl 2 BurnDetector-isolation), `TokenLedgerPoller-codex.test.ts` (6: wiring-not-dead-code,
  FS walk, cwd filter, idempotency), `tokens-codex-routes.test.ts` (3 integration HTTP).
- Live on codey (deployed dist, restarted): `/tokens/summary` → `codex.sessionCount=473`,
  `codex.totalTokens=50,478,475`, `maxPrimaryUsedPercent=11`; `/tokens/codex-sessions`
  top rows gpt-5.4-mini 2,945,942 / gpt-5.2 2,897,754, all cwd=instar-codey. Claude
  summary still separate (966M). **NOT published.**
