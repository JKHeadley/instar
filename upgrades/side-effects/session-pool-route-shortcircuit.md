# Side-Effects Review — Session-pool inbound dispatch short-circuit (bug #8)

**Version / slug:** `session-pool-route-shortcircuit`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Inbound Telegram dispatch (`src/commands/server.ts`) now short-circuits local
dispatch whenever `SessionRouter.route()` placed/forwarded the session onto another
machine — via a new pure helper `isRemotelyHandled(outcome, selfMachineId)` exported
from `SessionRouter.ts`. Previously only `'forwarded'`/`'duplicate'` short-circuited,
so a remote `'spawned'`/`'owner-dead-replaced'` fell through and double-dispatched
(spawn on target + inject into the stale local session). Adds a module-level
`_meshSelfId` and a one-line routing-decision log.

## Decision-point inventory

- **isRemotelyHandled** — the sole decision: forwarded|duplicate → remote;
  spawned|owner-dead-replaced → remote only when owner!==self; everything else →
  local. Both sides + the null-self boundary unit-tested.
- **call site** — `if (isRemotelyHandled(outcome, _meshSelfId)) return;` else fall
  through to existing local dispatch (unchanged).

## 1. Over-block

**What legitimate inputs does this reject?** None are dropped. A remote outcome now
returns early (correct — the message was already handled on the owner machine). A
self/local/queued/blocked outcome still falls through to local dispatch exactly as
before. The change only ADDS two remote actions to the early-return set.

## 2. Under-block

**What does this still miss?** It does not address bug #7 (a moved session on a
tokenless standby cannot send Telegram replies). It does not change WHICH machine
`route()`/`PlacementExecutor` chooses — if the pin isn't honored or ownership isn't
released, `route()` returns a LOCAL outcome and this still (correctly) handles
locally; the new route-decision log is what will pinpoint that on the next live run.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The decision is a pure function beside the `RouteOutcome` type
it interprets (testable, reusable). The call site is the single inbound chokepoint
that already consulted the router. `_meshSelfId` mirrors the existing
`_sessionRouter`/`_sessionPoolStage` module-capture pattern.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No new blocking authority. The helper only decides local-vs-already-handled-remotely
for dispatch; it gates nothing user-facing and blocks no message (a not-provably-
remote outcome falls through to local — fail-safe toward handling, never dropping).

## 5. Interactions

Consumes `SessionRouter.route()`'s existing `RouteOutcome`; no router behavior
change. Pairs with the `_tryNicknameRelocation` recognizer (which sets the pin +
releases ownership) — this fix makes the SUBSEQUENT routed message's remote
placement actually short-circuit the stale local session. Gated past `'dark'`, so
inert on single-machine / pool-disabled agents. Idempotent (pure decision per
message).

## 6. External surfaces

No HTTP routes, config, or notifications. One new server-log line per routed inbound
(`[session-pool] route topic N → action=… owner=… self=…`) — log-only observability.

## 7. Rollback cost

Low. Revert restores the `'forwarded'||'duplicate'`-only check (re-introducing the
double-dispatch on remote placement) and drops the helper + log. No schema, no
persisted state, no migration.

## Conclusion

Minimal, additive interpretation fix with a pure unit-tested decision, no new
authority, log-only external surface, cheap revert. Closes the double-dispatch half
of bug #8 and adds the observability to pinpoint the remainder of the live-transfer
cascade.

## Second-pass review (if required)

Not required — pure decision helper, both branches + fail-safe tested, no destructive
op, reversible, pool-gated. Live two-machine re-test is the Tier-3 gate that follows.

## Evidence pointers

- `tests/unit/SessionRouter.test.ts` — `isRemotelyHandled` over all RouteActions +
  self/remote/null-self boundaries.
- `tests/unit/session-pool-activation-wiring.test.ts` — call site uses the helper +
  still fails safe to local dispatch.
- 50 session-pool tests green; `tsc --noEmit` clean.
- Found live 2026-05-31 on throwaway topic 8882: recognizer pinned to mini, but the
  follow-up injected into the local laptop session (`Injecting into
  echo-standby-mode-edits`) — no forward.
- Spec: `docs/specs/session-pool-route-shortcircuit.md` (+ `.eli16.md`).
