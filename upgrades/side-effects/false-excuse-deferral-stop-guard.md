# Side-Effects Review — False-Excuse Deferral Stop-Guard

**Slug:** `false-excuse-deferral-stop-guard` · **Tier:** 1 (small, low-risk hook behavior addition;
operator-requested direct fix, no spec). Touches `PostUpdateMigrator.getStopGateRouterHook()` (a
hook template), so the tier signal flags `belowFloor` (a PostUpdateMigrator touch raises the floor) —
accepted: the change is a self-contained substring guard, fully reversible, no external surface.

## Summary of the change

`stop-gate-router` hook gains `falseExcuseDeferralGuard`, mirroring the existing
`statedContinuationGuard`: a mode-independent IIFE that, on a Stop, blocks ONCE when the final
assistant message contains BOTH (a) a named piece of remaining work AND (b) a self-protective
deferral rationalization (session-length / time-of-day / made-mistakes / don't-rush /
tracked-so-it-won't-slip / next-session), re-feeding a "this excuse is false — proceed" directive.
Same change in the deployed copy is overwritten from this source on the next update (Migration
Parity — always-overwrite built-in hooks), so it reaches every agent.

## 1. Over-block / false positive

The AND-of-both-signals requirement is the false-positive control: a self-protective phrase alone
(e.g. "it's late, but everything is done") does NOT block — `knownWork` must also match. Tested:
a genuine completion and a time-reference-with-no-pending-work both pass through (no block). Cost of
any residual false positive is bounded to ONE extra turn (the agent re-affirms and re-stops), because
the guard fires once.

## 2. Under-block

If the agent stops with an excuse but uses wording outside the phrase lists, it slips through (a
false negative) — acceptable: the guard is a high-precision catch for the documented recurring
phrasings, not a complete classifier. The lists cover the operator-cited forms and the agent's actual
observed messages. Tunable by extending the arrays.

## 4. Signal vs authority

The guard is a one-shot re-feed (block decision with a reminder), exactly like the
stated-continuation guard. It never silences or rewrites a message and takes no destructive action.
The `stop_hook_active` loop guard guarantees the agent is never trapped — a legitimate stop (real
external blocker / work complete / a user-only decision) re-stops cleanly on the next attempt.

## 5. Interactions

Sits directly after `statedContinuationGuard` in the same hook, before the server round-trip — so it
works even when the server-side stop-gate is in shadow/off mode (which is exactly when these stalls
slip through). No new dependency, no network call, no state. Pure substring matching. Cannot recurse
or grow unbounded.

## 6. External surfaces

None. No route, no egress, no spend (no LLM call — deterministic substring matching in the hook
subprocess).

## 7. Multi-machine posture

Machine-local: the hook runs per-session on whichever machine hosts the session. No replicated state.
Each agent on each machine gets the guard via the standard hook update.

## 8. Rollback cost

Trivial: delete the `falseExcuseDeferralGuard` IIFE from `getStopGateRouterHook()`; the next update
overwrites the deployed copy back to guard-free. No data, no migration to unwind.

## Evidence pointers

- `tests/unit/stop-gate-false-excuse-deferral.test.ts` (6): renders valid JS containing the guard;
  blocks the real-world excuse-stop (named work + self-protective excuse); blocks a
  session-length/next-session deferral; does NOT block a genuine completion; does NOT block a time
  reference with no deferred work (false-positive control); does NOT re-block under `stop_hook_active`.
- `tests/unit/stop-gate-stated-continuation.test.ts` + `tests/unit/generated-hooks-parse.test.ts`
  stay green (the template literal still renders valid JS). Full `tsc` clean.

## Conclusion

Delivers the operator-requested structural catch for the recurring false-excuse early-stop, as an
instar feature that ships to every agent. High-precision, loop-safe, reversible, no external surface.
Ship.
