# Side-Effects Review — CompactionSentinel: stand down instead of trampling a working session

**Version / slug:** `compaction-sentinel-no-trample`
**Date:** `2026-06-18`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `required (sentinel/recovery change) — appended below`

## Summary of the change

Fixes the recurring mid-turn interrupt of long autonomous sessions ("[Request interrupted by user]"). Root cause: `CompactionSentinel.deferForActiveWork` deferred a recovery resume-nudge while the session was actively working, but only up to `maxWorkingDefers` (~4min); once exhausted it returned `false`, and the caller **force-injected the resume nudge even though the session was still actively working** — interrupting the live turn. On a 23h session that compacts periodically, this fired repeatedly. The fix: when the defer budget is exhausted but `isActivelyWorking` is STILL true, the sentinel **stands down** (emits `compaction:recovered`, finalizes — a session demonstrably alive + working has already self-recovered and needs no nudge) instead of force-injecting. The explicit `maxWorkingDefers === 0` opt-out (inject-immediately-even-while-working) is preserved. File: `src/monitoring/CompactionSentinel.ts` (one guard method). Test: `tests/unit/CompactionSentinel.test.ts` (updated the old "force inject after cap" test to assert stand-down; added a dedicated stand-down regression test; 24 tests pass).

## Decision-point inventory
- `CompactionSentinel.deferForActiveWork` — **modify** — when budget exhausted AND still actively working: stand down (no inject) instead of returning false (which force-injected). The `not actively working` path and the `maxWorkingDefers === 0` opt-out are unchanged.

## 1. Over-block
Not a block/allow surface. The change makes the sentinel inject LESS (a de-escalation). The only "rejection" added: it now declines to inject a recovery nudge into a still-working session — which is the entire point (that inject was the defect).

## 2. Under-block
The one scenario the old force-inject targeted — a session whose tmux footer FALSELY shows "working" while truly hung — is no longer force-recovered by THIS sentinel. That case is covered by the frozen-frame detectors (ActiveWorkSilenceSentinel, ContextWedgeSentinel, SessionWatchdog), which use frame-change/socket signals rather than the footer boolean. So the genuinely-hung case still has recovery owners; this sentinel simply stops trampling genuinely-working sessions.

## 3. Level-of-abstraction fit
Correct layer — the fix is in the guard that already exists for exactly this purpose (`deferForActiveWork`). It uses the same `isActivelyWorking` (live-tmux-frame) signal already wired; no new detection added.

## 4. Signal vs authority compliance
**Required reference:** docs/signal-vs-authority.md
- [x] Yes, with appropriate de-escalation: the sentinel holds runtime authority (it injects into sessions). This change REDUCES that authority (it stops acting on working sessions). Strictly safer direction — never adds a brittle block; it removes a brittle action.

## 5. Interactions
- **Shadowing:** none changed. The other recovery sentinels are unaffected and now solely own the falsely-working-footer case (no double-recovery with this one).
- **Double-fire:** reduced (this sentinel no longer fires into working sessions that the autonomous stop-hook is already re-driving).
- **Races:** the stand-down calls `finalize(state,'recovered')` which keeps state briefly for the recovery-guard window (existing behavior), so the zombie-killer veto timing is unchanged.

## 6. External surfaces
No operator surface, no API, no message shape change. The only external-visible effect: long sessions stop being interrupted mid-turn. A `compaction:recovered` event now fires for the stand-down case (audited in `sentinel-events.jsonl`) — additive, no consumer breaks.

## 7. Multi-machine posture (Cross-Machine Coherence)
Machine-local BY DESIGN — the CompactionSentinel runs per-machine over that machine's own sessions (recovery is a local-process concern). No cross-machine state; the fix changes only local decision logic. Both machines get the fix via the normal deploy/update path.

## 8. Rollback cost
One-method revert, ship a patch. No persistent state, no migration, no operator action. Because the change is a pure de-escalation, even an un-noticed regression fails safe (worst case: a falsely-working-footer hung session waits for the other sentinels instead of this one).

## Conclusion
Small, well-scoped fix to the exact guard responsible for the recurring interrupt. De-escalation only; 24 unit tests pass incl. a new regression test that fails if a still-working session is ever force-injected again. Clear to ship pending the appended second-pass.

## Second-pass review (if required)
**Reviewer:** independent general-purpose reviewer subagent (read-only), 2026-06-18 — **CONCUR**

Verified against the actual code (cited file:line): (1) stand-down replaces force-inject — when `isActivelyWorking` && `workingDefers >= maxWorkingDefers`, emits `compaction:recovered` + `finalize('recovered')` + returns true; both callers (`attemptInjection:297`, `verifyRecovery:420`) bail before `recoverFn` — no inject. (2) `maxWorkingDefers === 0` opt-out preserved (early `return false` at :348 → inject). (3) not-working path unchanged (:345 → normal inject/retry/fail; genuinely-stuck still recovered). (4) no timer/state leak — stand-down routes through the same `finalize` terminal path; at every call site the per-session timer was already deleted; `isRecoveryActive` returns false in `recovered` so the zombie-veto releases. (5) strict de-escalation — `recoverFn` called strictly less; no new block/interrupt path. (6) coverage gap closed — the falsely-working-footer hung case is owned by ActiveWorkSilenceSentinel (frame-HASH change + frozen-indicator backstop) and ContextWedgeSentinel (transcript fast-fail signatures), which use orthogonal signals, so standing down here strands nothing. **No concerns.**

## Evidence pointers
- `tests/unit/CompactionSentinel.test.ts` — 24/24 pass; new "STANDS DOWN" test + updated cap test.
- `npx tsc --noEmit` clean.
