---
title: Stated-continuation stop guard (no silent stall after promising to continue)
slug: stop-gate-stated-continuation
status: approved
review-convergence: 2026-05-31T18:55:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate. Justin requested this
  fix DIRECTLY on topic 13481 (2026-05-31): "Looks like your session has stalled
  again ... you gave me the impression you're ready to continue working ... we
  need to improve INSTAR in the behavior." This spec is the structural response.
  Flagged in the PR per cross-agent discipline.
---

# Stated-continuation stop guard

## Problem

A recurring, trust-eroding behavior: the agent's final user-facing message states
it is about to act THIS turn — "I'll build that now", "starting now", "Next phase:
ship the fix" — and then the turn simply **ends** without doing it. From the user's
side this is a silent stall: they were told work was continuing, and instead got
silence.

Live incident (2026-05-31, topic 13481): Echo told Justin "I'm going to build that
now ... then deploy and finish the round-trip proof," then reverted state, wrote
internal notes, and ended the turn. The work never started. Justin: "this is
incoherent and we need to improve INSTAR in the behavior." This is the same
silent-stall / context-death self-stop class he has flagged repeatedly.

Why nothing caught it: the existing `stop-gate-router.js` hook delegates the
continue/stop decision to the server-side Unjustified Stop Gate, which **only
blocks in `enforce` mode**. The gate ships in `shadow` mode (telemetry only) on
subscription agents — so the exact moment a stall happens, nothing intervenes.

## Solution

Add a **local, mode-independent guard** to the `stop-gate-router.js` hook
(`PostUpdateMigrator.getStopGateRouterHook()`), placed AFTER the `stop_hook_active`
loop-guard and BEFORE the server round-trip. When the agent's final message
(`last_assistant_message`) contains a first-person/sequenced commitment to act
(`I'll`, `I'm going to`, `next phase/step`, `starting now`, `on it`, ...) together
with an imminence marker (` now`, `right now`, `immediately`, `this turn/session`,
`then I`), the hook emits `{decision:'block'}` + exit code 2 and re-feeds:

> Either (a) actually do that work now, or (b) if you are genuinely blocked,
> finished, or need the user, send ONE short honest message saying you are
> stopping and exactly why — then you may stop.

Key properties:

- **Mode-independent.** Runs regardless of the server gate's shadow/enforce mode
  and even if the server is unreachable — because shadow mode is precisely when
  stalls slip through.
- **Fires once.** The pre-existing `stop_hook_active` guard exits open on the
  re-fire, so the agent gets exactly one nudge — never an infinite trap.
- **Converts silent stalls into explicit stops.** Even on a borderline match, the
  worst case is the agent must tell the user plainly that it is stopping and why —
  which is exactly the desired behavior. "Report-back-later" intent (no imminence
  marker) is NOT caught; that belongs to the commitment tracker.
- **Pure substring matching.** No regex/`\b` escaping hazards inside the hook's
  template literal.

## Scope

- `src/core/PostUpdateMigrator.ts` — `getStopGateRouterHook()` only. The built-in
  `instar/` hook is always-overwritten on migration, so every existing agent
  receives the guard on its next update (Migration Parity Standard — no separate
  migration needed; the hook content method IS the migration path).

## Testing

`tests/unit/stop-gate-stated-continuation.test.ts` renders the real hook via
`getHookContent('stop-gate-router')` and EXECUTES it as a subprocess against
representative Stop-hook payloads:

- Renders syntactically valid JS containing the guard (`node --check`).
- BLOCKS on "I'll build that now" (exit 2 + `decision:block`).
- BLOCKS on the exact real-world stall ("Next phase: build ...").
- Does NOT block a benign completion ("Done — all tests passed ...").
- Does NOT re-block when `stop_hook_active` is true (loop guard).

## Non-goals

- Not a replacement for the server-side Unjustified Stop Gate's nuanced judgment;
  this is a narrow, high-precision local backstop for one unambiguous pattern.
- Does not change the gate's mode or its telemetry.
