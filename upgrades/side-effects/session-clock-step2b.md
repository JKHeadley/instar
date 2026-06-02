# Side-Effects Review — Session Clock Step 2b (autonomous-continuation injection)

**Slug:** `session-clock-step2b`
**Date:** `2026-06-02`
**Author:** `echo`
**Tier:** 2 (converged+approved `ROBUST-SESSION-TIME-AWARENESS-SPEC.md`)
**Spec:** `docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md` (Component 2 — the stop-hook render call site)

## Summary of the change

Wires the time-awareness injection into the **autonomous stop-hook** — the actual fix for the wind-down-early incident. On every blocked continuation of a time-boxed run, the hook now feeds back a rich `⏱ SESSION CLOCK: Nh elapsed · Mh remaining (NN%)` line so the autonomous agent always SEES how much of its window remains.

- `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh`: after the existing `(${REMAINING_MIN}m remaining)` slot (kept untouched), an additive `${CLOCK_SEG}` segment is rendered by `emit-session-clock.sh render` **from the hook's OWN already-computed `STARTED_AT`/`DURATION_SECONDS`/`ELAPSED`/`REMAINING`** — no re-resolution, so the injected clock can never disagree with the hook's own duration-expiry verdict (adversarial round-2 concern). Fail-safe: if the script is absent or the run is unbounded (no `ELAPSED`), the segment is simply omitted.
- `src/core/PostUpdateMigrator.ts`: the existing `migrateAutonomousStopHookTopicKeyed` marker is bumped `p13_stop_allowed → CLOCK_SEG`, re-deploying the wired hook to existing agents (Migration Parity; customized hooks with no stock fingerprint untouched).

The query-mode call site (user-turn injection via `telegram-topic-context.sh`) is the second, separate injection site, tracked in #682; the routine's query mode is shipped + tested and ready for it.

## Decision-point inventory
- placement: enrich the `(...)` slot vs add a segment → add a separate `${CLOCK_SEG}` segment (the existing slot is untouched = lowest risk).
- value source: render from the hook's own numbers vs re-resolve → render (no double-resolution).

## 1. Over-correction risk
None — additive. The existing `(${REMAINING_MIN}m remaining)` slot and the expiry logic are unchanged; only an extra informational segment is appended.

## 2. Under-correction risk
The user-turn (query-mode) site is the separate injection point tracked in #682; this change covers the autonomous-continuation site, which is the incident's actual failure mode.

## 3. Level-of-abstraction fit
The hook calls the single shared `emit-session-clock.sh render`; the format lives there, the numbers come from the hook. No duplication.

## 4. Signal vs Authority
Signal-only: the injected line is informational; it never changes the block/exit decision (which is the unchanged expiry logic).

## 5. External surfaces
None. The hook reads the locally-installed script; nothing new is exposed.

## 6. Interactions with existing primitives
Reuses the established `migrateAutonomousStopHookTopicKeyed` re-deploy mechanism (marker bump) and the hook's own computed values. `bash -n` clean; the existing autonomous-stop-hook tests (P13, completion-condition, topic-keyed) stay green.

## 7. Rollback cost
Trivial: remove the `CLOCK_SEG` block + the two `${CLOCK_SEG}` insertions + revert the marker. No state.

## Migration parity
- New agents: `installBuiltinSkills`/`init` ship the wired hook.
- Existing agents: `migrateAutonomousStopHookTopicKeyed` (marker `CLOCK_SEG`) re-deploys the wired hook on update; customized hooks untouched.

## Tests
- `autonomous-stop-hook-session-clock.test.ts` (2): a blocked continuation of a timed run feeds back the SESSION CLOCK line (functional, runs the real hook with the installed script); fail-safe with the script absent (continuation still fires, segment omitted).
- Regression: `bash -n` clean; PostUpdateMigrator-autonomousStopHook (8), autonomous-completion-condition + evaluate-stop (15) green; `tsc --noEmit` clean.
