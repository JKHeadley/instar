# Side-Effects Review — Compaction recovery: defer re-inject while the session is actively working

**Version / slug:** `compaction-busy-session-defer`
**Date:** `2026-05-29`
**Author:** `echo`
**Spec:** `docs/specs/compaction-busy-session-defer.md` (+ `.eli16.md`)
**Convergence:** `docs/specs/reports/compaction-busy-session-defer-convergence.md` (fast-tracked — urgent fleet bug; see report)
**Second-pass reviewer:** `not required` (see §"Phase 5 trigger check")

## Summary of the change

Fixes the user-reported false "session is restarting" loop (Justin, topic 15160):
a live, actively-working session gets its inbound message buried under stacked
compaction-recovery re-injects, so the message never reaches the session and the
user sees repeated "restarting / starting up" narration.

Root cause (verified in running code + `logs/server.log` on Echo): `CompactionSentinel`
re-injects a recovery prompt when the session's JSONL doesn't grow within the
verify window — but a long extended-think on a large context (typical right after
resuming a near-full transcript) writes nothing to the JSONL until the turn
lands, so a healthy session reads as "stuck." Caught firing 3× in ~52s against a
live session.

The change teaches the recovery surfaces to recognize a mid-turn session (the
canonical `esc to interrupt` / `tokens · esc` footer OR a live non-baseline child
process) and DEFER instead of re-injecting, bounded by `maxWorkingDefers`.

## Files touched

- `src/core/claudeActivityIndicators.ts` (**new**) — `CLAUDE_WORKING_INDICATORS`
  single source of truth + pure `paneShowsClaudeWorking`.
- `src/core/StuckInputSentinel.ts` — its `ACTIVITY_INDICATORS` now imports the
  shared const (no behavior change; removes drift risk).
- `src/core/SessionManager.ts` — `paneShowsActiveWork` + `isSessionActivelyWorking`;
  `verifyInjection` skips the recovery Enter while the pane is actively working.
- `src/monitoring/CompactionSentinel.ts` — `isActivelyWorking?` dep,
  `maxWorkingDefers` config, `workingDefers` state, `deferForActiveWork()` +
  `scheduleVerify()`, `compaction:deferred` event, `deferring` status.
- `src/commands/server.ts` — wires `isActivelyWorking` to
  `sessionManager.isSessionActivelyWorking`.
- Tests: `tests/unit/CompactionSentinel.test.ts` (+6 cases),
  `tests/unit/claudeActivityIndicators.test.ts` (new),
  `tests/unit/session-active-work.test.ts` (new),
  `tests/integration/compaction-busy-defer-wiring.test.ts` (new),
  `tests/e2e/compaction-busy-defer-lifecycle.test.ts` (new).

## Decision-point inventory

- **Inject vs defer (CompactionSentinel)** — *modify, additive*. Was "no jsonl
  growth → re-inject/fail." Now: "no growth AND actively working AND defer budget
  remains → wait without injecting; else unchanged." A presence check, not a
  judgment. Both branches test-covered. With the dep absent or
  `maxWorkingDefers: 0`, behavior is byte-for-byte the old path.
- **Recovery-Enter vs skip (verifyInjection)** — *modify, additive*. Was "marker
  at prompt → fire Enter." Now: "marker at prompt AND actively working → skip
  this tick, keep polling." Skipping is strictly less action; the input is
  correctly queued by Claude Code and submits when the turn ends.
- **Working signal** — *read-only*. Reuses the existing footer indicators +
  `hasActiveProcesses`. No new file format, no write, no new tmux command.
  `isSessionActivelyWorking` is wrapped so a capture/ps failure resolves to
  `false` (cannot throw into recovery).

## Blast radius

- **No new authority, no new gate, no new detector, no new API route, no
  external surface.** A defer behind an existing, already-rate-guarded recovery
  primitive.
- **Hot paths unchanged.** `getTopicForSession` and the message-inject hot path
  are untouched. `isSessionActivelyWorking` runs only inside the recovery
  lifecycle (already off the hot path).
- **Strictly less aggressive.** The change can only PREVENT a re-inject/Enter; it
  never adds one. It cannot starve a real recovery: an idle or wedged session
  shows no working tell → no defer. Bounded by `maxWorkingDefers`.
- **No agent-installed files changed** — no `.claude/settings.json` hooks, no
  `.instar/config.json` defaults, no CLAUDE.md template, no hook scripts, no
  skills. So **no PostUpdateMigrator entry is required**: pure `src/` logic that
  reaches every agent through the normal dist update.

## Phase 5 trigger check (second-pass reviewer)

Second pass **not required**: no new authority, no destructive operation
introduced (the only behavioral deltas REMOVE actions — a re-inject and a
recovery Enter — against working sessions), no external surface, no migration.
Additive, read-only signal behind an existing rate-guarded recovery primitive,
with full three-tier coverage.

## Verification

- Unit: `CompactionSentinel.test.ts`, `claudeActivityIndicators.test.ts`,
  `session-active-work.test.ts` (+ existing `StuckInputSentinel.test.ts` still
  green after the shared-const refactor) — 125 pass across the related set.
- Integration: `compaction-busy-defer-wiring.test.ts` — 4 pass.
- E2E: `compaction-busy-defer-lifecycle.test.ts` — 4 pass (incl. WIRED guard).
- `tsc --noEmit` clean.
