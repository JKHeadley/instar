# Side-Effects Review — Gemini multi-turn loop-driver (engine increment)

**Version / slug:** `gemini-multi-turn-loop-driver`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `not required` (dark + unwired engine increment; the
spendable surface — the invoking route/wiring — is a separate later increment
that will carry its own review)

## Summary of the change

Adds `GeminiLoopDriver` (`src/monitoring/GeminiLoopDriver.ts`), a dependency-
injected engine that drives a gemini task across turns via the native
`gemini -r <handle>` resume path (turn 1 one-shot establishes the session; later
turns resume by a stable handle, re-prompting with only the next instruction so
no transcript is re-sent). Adds the `buildGeminiResumeArgv` transport helper. The
engine is NOT invoked anywhere yet (dark + unwired); only its 14 unit tests
exercise it.

## Decision-point inventory

The engine makes five terminal decisions per run: done-sentinel detected,
turn-cap reached, budget-gate closed, spawn failure (non-zero exit), and
handle-capture failure. Each is covered both-sides in the unit suite.

## 1. Over-block

**What legitimate inputs does this change reject?** Nothing in production today —
the engine is unwired, so no caller is gated by it. Within a run: a closed budget
gate halts before spawning (intended — that IS the overspend guard), and a
`null` handle-capture aborts the loop after turn 1 rather than resuming (intended
— resuming `latest` could hijack a foreign session; aborting is the safe choice).
The `maxTurns` clamp floors at 1, so a 0/negative cap still runs exactly one turn
rather than zero or infinite.

## 2. Under-block

**What does this still miss?** The engine does not itself enforce a token budget —
it delegates to the injected `budgetGate`, which is wired to the real
QuotaTracker only in the (later) invocation increment; an integrator that injects
a permissive gate gets no budget protection. It does not detect a wedged turn
mid-spawn (it relies on the injected spawn's own timeout, which the real
`spawnGeminiAndWait` provides). It does not yet verify the empirically-noted 3+
turn resume-accumulation (a live-verify gate recorded in the spec before any
enable). Completion relies on the mentee emitting the sentinel OR (later) a judge;
a mentee that finishes silently without the sentinel runs to the turn cap.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The engine sits in `src/monitoring/` beside the other
driver/lifecycle components and depends only on the gemini transport's pure argv
builders (`buildGeminiOneShotArgv` / `buildGeminiResumeArgv`); all I/O is
injected, so the subscription-auth guarantee stays in the transport
(`buildGeminiChildEnv` strips billing env) and is reused, not re-implemented. The
resume argv helper lives in the transport module next to the one-shot builder,
keeping the gemini-cli invocation surface in one place.
