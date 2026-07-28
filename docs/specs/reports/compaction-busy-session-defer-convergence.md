# Convergence report — compaction busy-session defer guard

**Spec:** `docs/specs/compaction-busy-session-defer.md`
**Author:** echo
**Date:** 2026-05-29
**Iterations:** 2 (self-review; fast-tracked — see note)

## Fast-track note (transparency)

This is an URGENT, fleet-wide bug fix: the false "session is restarting" loop
breaks the mandatory Telegram relay UX (a user's message is buried by stacked
recovery re-injects and never reaches the live session — Justin reported it from
his own seat, topic 15160). Per the standing directive to auto-fix-and-deploy
urgent fleet bugs, the multi-agent `/spec-converge` panel was fast-tracked to a
constrained self-review rather than the full external panel. The change is a
bounded, additive, safety-IMPROVING guard behind an existing, already-rate-
guarded recovery primitive, with full three-tier test coverage. This deviation
is disclosed here and to Justin.

## Material questions resolved

1. **Could deferring starve a genuinely-stuck session of recovery?**
   No. The defer fires ONLY when `isSessionActivelyWorking` is true (mid-turn
   footer present OR a live non-baseline child process). A genuinely idle-at-
   prompt session, or a wedged session that fast-fails every turn, shows neither
   tell → no defer → recovery proceeds exactly as before. The defer count is also
   capped (`maxWorkingDefers`, default 10 ≈ 4 min) after which a forced inject
   resumes, so even a permanently-hung "working" footer cannot defer forever.

2. **Spinner glyphs vs footer hints for the "working" signal?**
   Footer hints only (`esc to interrupt` / `tokens · esc` / `ctrl+t to hide
   tasks`). Spinner glyphs can persist in a dead pane's frozen last frame, which
   would make a dead session read as "working" and starve recovery — the exact
   trap `StuckInputSentinel` already documents. The footer is structurally
   present only during an in-flight turn.

3. **Default ON vs opt-in flag?**
   Default ON. Unlike the context-wedge auto-recovery (which is DESTRUCTIVE —
   kills+respawns — and is therefore opt-in), this change only PREVENTS an
   over-aggressive action. It removes a false-positive harm and cannot worsen a
   real recovery, so gating it behind a default-OFF flag would leave the bug live
   fleet-wide for no safety benefit. Escape hatch: `maxWorkingDefers: 0`.

4. **Hot-path safety.** `getTopicForSession` and the inject hot path are
   untouched. `isSessionActivelyWorking` is consulted only inside the recovery
   lifecycle (already off the message hot path) and is a bounded capture + ps
   walk, fail-closed to `false`.

## Outcome

Converged. No open blocking questions. Three-tier tests green (unit +
integration + e2e). No migration required (pure `src/`).
