# Side-Effects Review — Threadline §4.5 commit 1: triggeredBy plumbing through SpawnRequest → spawnSession

**Version / slug:** `threadline-cooldown-sec4.5-triggeredby-plumbing`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (additive optional field; default `'spawn-request'` preserves prior behavior verbatim)

## Summary of the change

First commit of §4.5 (observability). Adds `triggeredBy?: 'spawn-request' | 'spawn-request-drain'` to `SpawnRequest`, plumbs it through `evaluate` into `spawnSession` callback options, and updates the server's `spawnSession` callback to honor the value when constructing the actual session.

This unblocks distinguishing drain-spawned sessions from inline-spawned ones in:
- Session logs (`triggeredBy` is already a field on the `Session` interface)
- Future DegradationReporter breadcrumbs
- Future operator dashboards filtering by spawn provenance

The drain-loop consumer wiring (the `onDrainReady` callback that synthesizes a SpawnRequest with `triggeredBy: 'spawn-request-drain'`) is not yet in place — that's a follow-up (effectively §4.4 commit 2). Once wired, every drain-spawned session will be tagged automatically.

Default behavior unchanged: omitted `triggeredBy` defaults to `'spawn-request'` at the manager level AND at the server's `spawnSession` callback, so no caller sees a difference.

Files touched:
- `src/messaging/SpawnRequestManager.ts` — adds `triggeredBy` to `SpawnRequest`; widens `spawnSession`'s `options` type with `triggeredBy?:`; forwards `request.triggeredBy ?? 'spawn-request'` into the spawnSession call inside `evaluate()`.
- `src/commands/server.ts` — uses `opts?.triggeredBy ?? 'spawn-request'` instead of the prior hardcoded literal.
- `tests/unit/spawn-request-manager.test.ts` — 2 new tests (forwards explicit value, defaults when unset). Adjusts one prior test to use `expect.objectContaining` because the spawnSession options object now has a third field.

## Decision-point inventory

1. **Default to `'spawn-request'` at every layer.** Manager fills in default if SpawnRequest doesn't carry one; server's callback fills in default if options doesn't carry one. Belt-and-suspenders so any consumer that bypasses one layer still gets the right tag.
2. **Union type with literal members, not an open string.** Two known producers (`spawn-request`, `spawn-request-drain`); future tags can be added by widening the union. Type checker catches typos.
3. **No additional fields on `SpawnRequest` for observability beyond `triggeredBy`.** Spec mentions `requestNonce`, `originatingMessageId` — those would help correlation but require consumer changes everywhere SpawnRequest is constructed. Defer to follow-up.
4. **Test using `expect.objectContaining` for partial matches.** The exact-object assertion broke because options now has three fields. `objectContaining` is more robust to future additive changes.
5. **No PATCH endpoint for runtime config in this commit.** Still deferred. The drain loop is now wired with the kill switch (§4.4 commit 1); PATCH is a nice-to-have but not load-bearing.

## Blast radius

- **Existing callers of `evaluate(request)` without `triggeredBy`:** zero behavior change. Defaults applied transparently.
- **Existing callers of `evaluate(request)` with `triggeredBy`:** new field is honored.
- **Server's `spawnSession` callback:** now reads `opts?.triggeredBy` instead of hardcoding. Fallback to `'spawn-request'` preserves identical pre-commit behavior when the manager doesn't pass anything.
- **Session logs:** start to differentiate spawn provenance once callers tag drain-path requests with `'spawn-request-drain'`.

## Over-block risk

None — purely metadata; no gating decision involved.

## Under-block risk

None.

## Level-of-abstraction fit

Tag is a flat enum on the request type. Adding a separate "Provenance" type for one enum field would be over-engineered.

## Signal-vs-authority compliance

Pure observability metadata. Not a signal-vs-authority concern.

## Interactions

- **§4.4 commit 1 (kill switch):** the drain loop is now started at server boot. Once §4.4 commit 2 wires `onDrainReady`, drain-spawned sessions will carry the `'spawn-request-drain'` tag automatically.
- **§4.5 future commits:** DegradationReporter integration, clock injection (already largely in place via `nowFn` from §4.2), per-tick metrics.
- **`Session.triggeredBy` field in core/types.ts:** already accepts a string; no schema change needed downstream.

## Rollback cost

Revert. Field disappears; server reverts to hardcoded literal. Tests revert to exact-object assertion.

## Tests

- 2 new tests under `describe('§4.2 drain loop', ...)`: forwards explicit triggeredBy; defaults to spawn-request when unset.
- 1 prior test updated from exact-object to `objectContaining` for forward-compat.
- All other 62 prior tests pass unmodified.
- `npx tsc --noEmit`: clean.

## Rollout

Ships on `feat/threadline-cooldown-queue-drain`. Substantive value lands when §4.4 commit 2 wires `onDrainReady` and the drain loop starts emitting `'spawn-request-drain'`-tagged sessions. Without that wiring, this commit is a no-op pre-positioning.
