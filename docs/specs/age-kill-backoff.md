---
title: Age-Timeout Kill Back-off — stop re-requesting a kill the guard keeps vetoing
status: converged
tier: 2
parent-principle: "Notice + Solve Inefficiencies — Efficiency Is a Standing Search"
review-convergence: self-converged against the live incident + code read (SessionManager.ts monitorTick age-gate); single-file behavioral change with a pure, unit-testable decision helper.
approved: true
---

# Age-Timeout Kill Back-off

## Problem (grounded, 2026-06-05 — 17,503 log lines)

`SessionManager.monitorTick()` runs every 5 seconds. Its age-gate
(`SessionManager.ts:910-963`): for a session past `maxDurationMinutes + 20%` that is
"truly idle" (idle-prompt AND no procs), it logs `Session "X" exceeded timeout … is
idle. Requesting kill via ReapAuthority.` and calls `terminateSession(id,'age-limit')`.

`terminateSession` is the ReapAuthority. On an over-age session that's idle-at-prompt but
**recently received a user message / is topic-bound / holds a commitment**, the §P2
KEEP-guard correctly VETOES the kill — it returns `{ terminated:false, skipped:<reason> }`
and the session survives (this is right).

**The bug:** the age-gate IGNORES that return value and `continue`s. So 5 seconds later the
same session is still over-age + idle → it logs + re-requests the kill → vetoed again →
… forever. We observed **17,503** identical "Requesting kill" lines for ~4 legitimately
long-lived sessions ("Resource Limitation Mitigation" kept by recent user messages;
"standby mode edits"/"feedback reports"/"Initiative lifecycle tracking" kept by
bindings/commitments). Nothing is ever killed — it's pure wasted CPU + log churn (720
attempts/hour/session) that reads, to operators on other topics, as "the machine is under
heavy load."

The sophisticated multi-signal `SessionReaper` is NOT the culprit (ships off/dry-run); the
crude age-gate is. The fix makes the age-gate **respect the KEEP-guard's verdict**: ask
once, and if the guard says keep, back off instead of nagging.

## Design (minimal, single-file behavioral change)

**A pure, injectable back-off ledger** `AgeKillBackoff` (`src/core/AgeKillBackoff.ts`),
mirroring the `AttentionTopicGuard` pattern (pure logic, injectable clock, bounded memory,
unit-testable in isolation):
- `shouldRequest(sessionId, nowMs): boolean` — false while a session is within its back-off
  window (a kill was recently vetoed-as-keep).
- `recordVeto(sessionId, nowMs): void` — the guard kept this session; suppress re-requests
  for `backoffMs` (default 10 min → 6 attempts/hr, down from 720/hr — a 120× cut).
- `recordKilled(sessionId)` — drop state after an actual kill (wired into the age-gate).
- `clear(sessionId)` / `reset(sessionId)` — ledger-maintenance API to drop a session's state
  (exercised by the unit suite). They are NOT wired into the injection/removal paths in this
  PR: a re-engaged session is already protected without them (see Invariants — it becomes
  non-idle and the age-gate takes its active-work branch, so it is never age-killed while
  active), and memory is already bounded. Bounded `Map` with oldest-eviction at `maxTracked`
  (default 1024) — so a stale entry for a removed session id is harmless and self-evicts;
  this is strictly better-bounded than the sibling `overAgeButActiveLogged` Set, which has no
  cap and no removal hook.

**Wiring in `SessionManager.monitorTick()` age-gate** (the `ageGateTrulyIdle` → kill branch):
1. `if (!this.ageKillBackoff.shouldRequest(session.id, now)) { /* skip silently */ }` —
   no log, no `terminateSession`, fall through to idle-detection as before.
2. Otherwise: log ONCE-style + `const r = await this.terminateSession(...)`.
   - `r.terminated === true` → killed → `recordKilled` (cleanup; `continue` as today).
   - `r.terminated === false` (vetoed/kept) → `recordVeto(session.id, now)` + a single
     informative line: `Session "X" over age but KEPT (<skipped reason>); backing off
     re-checks for Nm.` Then fall through (do NOT spam).
3. A session the user just touched needs no special back-off handling: the new injection
   makes it non-idle, so the age-gate takes its active-work branch (not the kill branch) and
   it is never age-killed while active — the back-off window is moot for it.

**Config:** `sessions.ageKillBackoffMinutes` (default 10; 0 disables back-off = legacy
behavior). Read at construction.

## Invariants
- NEVER changes WHICH sessions are killed — the KEEP-guard is the sole authority; this only
  changes how often the age-gate ASKS. A genuinely-idle-abandoned session (no keep-reason)
  still gets `terminated:true` on the first ask and dies exactly as today.
- Monitor cadence (5s) is unchanged — other checks need it; only the age-gate's per-session
  re-ask rate is bounded.
- Back-off is per-session and time-bounded; a session whose keep-reason lapses is re-checked
  after `backoffMs` and reaped then if now reapable. No session is kept alive *by* the
  back-off — it only suppresses redundant *requests*.

## Testing
- **Unit** (`AgeKillBackoff.test.ts`, 7 tests): shouldRequest true on first ask; false within
  window after recordVeto; true again after the window elapses; recordKilled/clear/reset drop
  state; bounded-map eviction; backoffMs:0 disables; the 720→6 asks/hr regression pin.
- **Integration** (`age-kill-backoff-integration.test.ts`, 4 tests, real `new SessionManager`):
  a monitorTick over an over-age idle session whose terminateSession vetoes → exactly ONE
  kill-request across many ticks within the window (vs one-per-tick before); a kill
  (terminated:true) path still kills once. This IS the wiring-integrity proof — it constructs
  the real SessionManager and exercises the age-gate consulting the real back-off ledger.
- **No Tier-3 E2E**: the e2e-pairing gate (`check-e2e-pairing.cjs`) scopes Tier-3
  "feature-is-alive" enforcement to changes under `src/server/*` (API-route features that can
  503 in production). This change adds no API route or server surface — there is nothing for a
  boot-the-server e2e to probe that the real-SessionManager integration test does not already
  prove. Forcing a contrived e2e here would assert nothing the integration tier doesn't.

## Migration parity
- The fix reaches existing agents purely through the code update: the default
  (`ageKillBackoffMinutes = 10`) lives in the `SessionManager` constructor, applied whenever
  the config field is absent. This mirrors the sibling dial `defaultMaxDurationMinutes`
  (`SessionManager.getMaxDuration()` → `?? FALLBACK_MAX_DURATION_MINUTES`), which likewise
  has no `migrateConfig` entry — so NO config migration is required, and adding one would be
  inconsistent with the established pattern for these internal SessionManager dials.
- No CLAUDE.md template change: this is internal lifecycle behavior with no user-facing
  capability, API route, proactive trigger, or registry lookup to surface (the
  Agent-Awareness Standard targets user-surfaceable capabilities). Consistent with
  `defaultMaxDurationMinutes` and the other internal monitor dials, which are not templated.
- No hook/skill changes.

## Follow-up <!-- tracked: topic-18423 -->
This PR is complete on its own terms: it fully fixes the operator-visible bug (the
17,503-line churn) by making the age-gate respect the KEEP-guard's verdict. Full
unification of the crude age-gate with the multi-signal `SessionReaper` into a single
authority is a distinct, larger workstream tracked against topic-18423 — a separate future
improvement, not an unfinished part of this change.
