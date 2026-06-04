# Side-Effects Review — Gemini loop-driver wiring (need-gem-002, increment 2)

**Version / slug:** `gemini-loop-driver-wiring`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `not required` (ships DARK behind
`autonomousSessions.geminiLoopDriver.enabled`; the developmentAgent gate turns it
on for dev agents only; rollback = flag false, instant)

## Summary of the change

Wires the (already-merged, increment 1) `GeminiLoopDriver` engine into a real,
budget-gated, dark capability:
- `geminiLoopProduction.ts` — production deps: the subscription-auth spawn
  (`createGeminiLoopSpawn` → the billing-env-stripping transport), the
  `--list-sessions` handle parser (`parseLatestGeminiSessionHandle`, min-age), and
  the QuotaTracker-backed budget gate (`createQuotaBudgetGate`).
- `GeminiLoopRunner.ts` — admits + launches runs async (a loop can take minutes,
  so a run returns a `runId` immediately) into a bounded in-memory registry.
- Routes `POST /gemini-loop/runs` (admit) + `GET /gemini-loop/runs[/:id]` (poll).
- `server.ts` constructs it under the developmentAgent gate; `types.ts` adds
  `autonomousSessions.geminiLoopDriver`.

## Decision-point inventory

Admission has four refusal boundaries (disabled / at-capacity / budget / invalid)
plus the OK path; the handle parser picks min-age or null; the budget gate maps
the QuotaTracker signal (fail-open with no tracker). All covered both-sides
across the unit/integration suites.

## 1. Over-block

**What legitimate inputs does this change reject?** Nothing on the fleet — it
ships dark (disabled → POST returns 409 'disabled'). When enabled: a closed budget
gate refuses to start (intended — the overspend guard), `maxConcurrent: 1` refuses
a 2nd concurrent run (intended — keeps shared-cwd handle capture unambiguous), and
an empty goal is 400. A requested `maxTurns` is clamped DOWN to the config cap, never
up. These are all the guardrails, not false rejections.

## 2. Under-block

**What does this still miss?** Handle capture uses the shared process cwd, so it is
only unambiguous at `maxConcurrent: 1` (a per-loop cwd needs a transport `cwd`
option — deferred; documented in the spec risks). The runner does not persist runs
across a restart (in-memory registry — acceptable for a dev dark feature; a SQLite
store is a later increment if it graduates). A 429/capacity wall ends a turn via
the engine's spawn-failure path rather than a graceful gemini-capacity-policy
pause (noted as a refinement). A mentee that finishes silently (no sentinel) runs
to the turn cap rather than an LLM-judge early-exit (judge = a later increment).

## 3. Level-of-abstraction fit

**Right layer?** Yes. Production deps live in `monitoring/` beside the engine and
depend only on the gemini transport (subscription-auth guarantee stays in the
transport, reused not re-implemented). The runner is constructed beside the other
dark monitoring features in `server.ts` under the same `developmentAgent` gate
pattern, and threads through the existing `AgentServer` options → `RouteContext`
plumbing (mirrors `mcpProcessReaper`). The budget gate reuses the existing
QuotaTracker spawn-admission decision rather than inventing new accounting.
