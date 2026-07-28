# Side-Effects Review — Session Clock Step 1 (SessionClock + GET /session/clock)

**Slug:** `session-clock-step1`
**Date:** `2026-06-02`
**Author:** `echo`
**Tier:** 2 (driven by the converged + approved spec `ROBUST-SESSION-TIME-AWARENESS-SPEC.md`)
**Spec:** `docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md` (review-convergence iteration 3, approved)

## Summary of the change

Step 1 of the time-awareness fix: the compute + query surface.
- `src/core/SessionClock.ts` — pure tier0 module: `computeSessionClock(input, nowMs)` (elapsed/remaining with clock-skew clamping + the status matrix), `deriveLabel(goal)` (the sanitized, cap-80, control-char/angle-bracket-stripped label that is the ONLY task text ever injected/served), `humanizeDuration`.
- `src/core/SessionClockReader.ts` — read-only I/O layer: maps ACTIVE autonomous-state records → computed clocks, with optional topic binding. Reuses `AutonomousSessions.activeAutonomousJobs()`.
- `src/core/AutonomousSessions.ts` — `AutonomousJobSummary` gains `durationSeconds` (parsed from the existing `duration_seconds` front-matter field). Additive.
- `src/server/routes.ts` — new read-only `GET /session/clock` (optional `?topic=N`). Bearer-gated (inherits app-wide auth). Leak-bounded: returns the computed clock + sanitized `label` only, never the raw `goal`.
- `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` — CLAUDE.md "Session Clock" awareness (template for new agents; content-sniffed `migrateClaudeMd` block for existing agents).

## Decision-point inventory
- route exposure: read vs write → read-only (GET only; POST → 404). No gate, no mutation.
- label: inject raw goal vs derived → derived + sanitized + capped. The raw goal never leaves the record.
- record field: `end_at` vs `started_at`+`duration_seconds` → the latter (canonical, matches the stop-hook + setup-autonomous.sh schema); `endsAt` is derived.

## 1. Over-correction risk
None — purely additive observability. No existing behavior changes. A healthy agent with no time-boxed record gets `{ sessions: [] }`.

## 2. Under-correction risk
Step 1 is the QUERY surface only; the per-turn INJECTION (the higher-impact fix for the incident) is Step 2 (emit-session-clock.sh + hooks), a separate PR. Documented in the spec sequencing.

## 3. Level-of-abstraction fit
Compute is pure (SessionClock.ts, no I/O, fully unit-tested both sides of every boundary); I/O is isolated (SessionClockReader.ts); the route is a thin reader. The record-enumeration reuses the existing AutonomousSessions module rather than duplicating frontmatter parsing.

## 4. Signal vs Authority
Tier0, deterministic, no LLM, no gate. Pure computation + a read route. Appropriate.

## 5. External surfaces
One new read-only HTTP route (`GET /session/clock`), Bearer-gated like `/tokens/summary`. **Leak-bound:** the response carries the sanitized `label` only — never the raw `goal`/task text (verified by integration + E2E assertions). No config/schema change.

## 6. Interactions with existing primitives
`AutonomousJobSummary.durationSeconds` is additive (existing consumers unaffected — AutonomousSessions unit tests still green). The route composes with the existing auth middleware. No change to the autonomous-state writer or the stop-hook.

## 7. Rollback cost
Trivial: remove the route + the two new modules + the additive `durationSeconds` field + the CLAUDE.md block. No persistent state, no migration of data.

## Migration parity
- New agents: the route ships in code; the CLAUDE.md template carries the awareness.
- Existing agents: the route reaches them on the normal dist update (code); `migrateClaudeMd` content-sniffs `/session/clock` and appends the awareness block (idempotent).

## Tests (all three tiers)
- Unit: `SessionClock` (14 — full status matrix, clock-skew clamp, label derivation/sanitization incl. `<promise>`-token stripping + cap-80) + `SessionClockReader` (6 — record parsing, topic binding, goal→label end-to-end, missing dir).
- Integration: `session-clock-route` (4 — 200 with computed fields, `{sessions:[]}` when none, topic filter, leak-bound: raw goal never in the response).
- E2E: `session-clock-lifecycle` (4 — real AgentServer boot, route alive 200 not 503, leak-bound, Bearer required, read-only POST→404).
- No regressions: AutonomousSessions (13) + migrateClaudeMd (3) still green; `tsc --noEmit` clean.
