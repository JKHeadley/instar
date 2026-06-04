<!-- bump: patch -->

## What Changed

First increment (the pure engine) of the **Gemini multi-turn loop-driver**
(`need-gem-002`) — the mechanism that will let a Gemini mentee sustain a
multi-turn task instead of being bounded to one-shots (the #1 program-need from
the codey-to-gemini apprenticeship retro).

A new `GeminiLoopDriver` (`src/monitoring/GeminiLoopDriver.ts`) drives a goal
across turns. Unlike Claude/codex — which run as persistent hook-capable sessions
and re-prompt via the autonomous Stop hook — gemini runs as one-shots, so the loop
is driven EXTERNALLY: turn 1 is a one-shot that establishes a session, and each
later turn re-spawns gemini with the proven native resume path. Because gemini
restores the session's context itself, the driver re-prompts with only the next
instruction — never the accumulated transcript — which is the quota-efficient
design that respects the subscription-auth / no-overspend rule.

The engine is fully dependency-injected (the gemini spawn, an optional budget
gate, the session-handle capture, sleep, clock), so its loop logic is exercised
by 14 unit tests with zero real gemini calls and zero quota. It terminates on a
done-sentinel, a turn cap, a budget-gate halt, a spawn failure, or a
handle-capture failure (it ABORTS rather than resuming a foreign session). A
companion transport helper `buildGeminiResumeArgv` adds the `-r <handle>` resume
argv (keeping the explicit `-m` that bypasses gemini-cli's flaky pre-turn
model-router classifier).

This increment is **dark and unwired**: nothing invokes the engine yet. Lifecycle
invocation (a budget-gated route + the apprenticeship machinery calling it, the
real `--list-sessions` handle parser, and a config flag) is the next increment,
which is where the §6 budget-guardrail defaults are finalized. Spec:
`docs/specs/gemini-multi-turn-loop-driver.md`.

## What to Tell Your User

Nothing is live to announce yet. This is internal groundwork — a tested engine
that, once wired up in a following change, will let the Gemini agent work through
a multi-step task on its own (on subscription login, never an API key) instead of
stopping after one reply. It ships turned off and disconnected, so it changes
nothing about how I work today. I will only surface it as a real capability once
it is wired, budget-guarded, and verified.
