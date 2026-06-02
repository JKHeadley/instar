# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The session clock now shows on your own messages too, not just autonomous turns.

Step 2b wired the clock into autonomous continuations; this wires the second site: when you message the agent, the UserPromptSubmit hook now also surfaces "⏱ SESSION CLOCK: Nh elapsed · Mh remaining (NN%)" if a time-boxed session is active. Both call sites of the shared routine (render + query) are now live — completing the per-turn, every-turn time awareness.

## What to Tell Your User

Nothing to do. If a timed session is running, your agent now sees its elapsed/remaining time on your turns too, so "how far along are we?" always has a real answer.

## Summary of New Capabilities

- `telegram-topic-context.sh` (built-in UserPromptSubmit hook) now calls `emit-session-clock.sh query` after resolving port/auth/topic, surfacing the SESSION CLOCK line on user turns. Signal-only; emits nothing when no time-boxed session is active or the server is unreachable. Delivered to existing agents via the always-overwrite built-in-hook migration.

## Evidence

- `telegram-topic-context-session-clock.test.ts` (2): generated hook carries the query call + passes `bash -n` (escaping guard). Regression (12) green; lint clean. Spec: Component 2.
