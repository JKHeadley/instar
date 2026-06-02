# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Your autonomous agent now sees how much of its time window is left — on every turn.

This is the fix for the failure where an agent in a long autonomous run wound down far too early because it had lost track of time. The autonomous stop-hook now feeds back a rich `⏱ SESSION CLOCK: Nh elapsed · Mh remaining (NN%)` line on every continuation, rendered from the hook's own elapsed/remaining numbers, so the agent always knows where it is in the window before deciding anything.

## What to Tell Your User

Nothing to do. If you run timed autonomous sessions, the agent will now quote accurate elapsed/remaining time as it works instead of guessing — and won't conclude a session is "done" with hours left. Existing agents get the updated hook automatically on update.

## Summary of New Capabilities

- The autonomous stop-hook injects a SESSION CLOCK line into every blocked continuation, rendered by `emit-session-clock.sh` from the hook's own computed numbers (no re-resolution → it can never disagree with the hook's own duration-expiry check). Additive and fail-safe: unbounded runs or a missing script simply omit the segment.
- Delivered to existing agents via the autonomous-skill re-deploy migration (marker bumped to `CLOCK_SEG`); customized hooks are left untouched.

## Evidence

- Functional wiring test (`autonomous-stop-hook-session-clock.test.ts`): a blocked continuation of a timed run feeds back the SESSION CLOCK line (runs the real hook); fail-safe path with the script absent verified. `bash -n` clean; autonomous-stop-hook regression suites (P13/completion/topic-keyed, 23) green; `tsc --noEmit` clean.
- Spec: `docs/specs/ROBUST-SESSION-TIME-AWARENESS-SPEC.md` (Component 2). Side-effects: `upgrades/side-effects/session-clock-step2b.md`. The user-turn injection site: #682.
