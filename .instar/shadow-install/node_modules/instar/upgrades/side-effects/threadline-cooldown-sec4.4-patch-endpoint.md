# Side-Effects Review — Threadline §4.4 commit 3: runtime tunable PATCH endpoint

**Version / slug:** `threadline-cooldown-sec4.4-patch-endpoint`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (additive endpoints; auth handled by upstream middleware; field validation rejects malformed input atomically)

## Summary of the change

Third and final commit of §4.4. Adds GET + PATCH endpoints under `/messages/spawn/config` for inspecting and updating the runtime-tunable subset of the SpawnRequestManager config without restarting the server.

GET returns resolved config (defaults filled in). PATCH accepts any subset of `{ cooldownMs, maxDrainsPerTick, maxEnvelopeBytes, maxGlobalQueued, degradedMaxQueuedPerAgent }` and applies them atomically — any invalid field rejects the entire patch with a clear reason.

The PATCH response flags `tickIntervalChanged: true` when `cooldownMs` change shifts the computed tick interval (which only takes effect after a `dispose()` + `start()`), giving operators clear feedback that a server restart is needed for the new tick rate.

Files touched:
- `src/messaging/SpawnRequestManager.ts` — adds `getRuntimeConfig()` (returns resolved values for all five tunables + computed `drainTickMs`) and `updateConfig(patch)` (atomic apply with per-field validation).
- `src/server/routes.ts` — adds `GET /messages/spawn/config` and `PATCH /messages/spawn/config` routes. Unknown body fields are rejected; non-number values are rejected.
- `tests/unit/spawn-request-manager.test.ts` — 5 new tests: getRuntimeConfig defaults, updateConfig atomic apply, validation rejection without partial mutation, tickIntervalChanged flag on cooldown change, empty-patch no-op.

## Decision-point inventory

1. **Atomic patch (validate-then-apply).** A `PATCH { cooldownMs: 5000, maxDrainsPerTick: -1 }` rejects EVERYTHING — no partial application. Operators should never have to wonder which fields landed.
2. **Per-field validators inline in `updateConfig`.** Could extract to a Zod schema; one-screen of validators is less ceremony for five fields.
3. **`tickIntervalChanged` flag, not auto-restart.** Restarting the timer mid-tick has correctness pitfalls (drop in-flight work, race with `dispose()`). Flagging the change and leaving the restart to operators is honest about the tradeoff. The kill-switch + restart cycle is well-tested.
4. **GET returns resolved values, not raw config.** Operators want "what's the system currently using" — defaults filled in.
5. **Unknown-field rejection on PATCH.** Avoids silent typos like `maxQueueGlobal` instead of `maxGlobalQueued`. Better to fail loud.
6. **No auth check in the route handler.** All `/messages/*` routes are protected by upstream auth middleware. Adding a per-route check would be redundant and inconsistent with the rest of the file.
7. **Configurable subset, not the whole config.** Callbacks (`spawnSession`, `getActiveSessions`, `onDrainReady`, etc.) are NOT runtime-tunable — they're load-bearing references to live functions. Exposing them via PATCH would invite confusion (does setting `null` disable spawning?). Keep the surface minimal and honest.

## Blast radius

- **Existing routes:** unchanged.
- **Existing PROGRAM startup behavior:** unchanged.
- **Operator workflow:** can now retune knobs at runtime. Previous workflow (config file edit + restart) still works.

## Over-block risk

A bad PATCH (e.g., `maxEnvelopeBytes: 1`) would refuse all subsequent envelopes. The same risk exists for the config file. Operator responsibility; the validators only catch type errors and obviously-wrong values (negative, non-finite, non-integer where required).

## Under-block risk

Operators with raw API access could set `maxGlobalQueued: 1_000_000` and effectively disable the global cap. That's the intended escape hatch — auth is the gate, not the validators.

## Level-of-abstraction fit

`getRuntimeConfig` and `updateConfig` live on the manager next to the state they read/write. Routes live in `routes.ts` next to the related `/messages/spawn-request` route. Both placements obvious.

## Signal-vs-authority compliance

PATCH is an authority surface — it mutates manager config. Auth middleware controls who can call it. Validation enforces structural constraints. Compliant.

## Interactions

- **§4.4 commit 1 (config plumbing):** the same fields are now both startup-configurable (via `config.threadline.spawn.*`) AND runtime-tunable (via PATCH). Symmetric.
- **§4.4 commit 2 (drain consumer wiring):** unaffected — the runtime-tunable knobs don't touch the callback wiring.
- **§4.2 drain loop:** runtime cooldown changes affect `cooldownRemainingMs` immediately. Tick interval lags until restart (flagged in response).
- **§4.3 caps:** runtime envelope/global cap changes affect future enqueues immediately; existing queued entries are unaffected.

## Rollback cost

Revert. Routes disappear; manager helpers disappear. Operators lose the runtime-tuning ability and fall back to config-file + restart.

## Tests

- 5 new tests under `describe('§4.2 drain loop', ...)`: getRuntimeConfig defaults, atomic apply, validation rejection without partial mutation, tickIntervalChanged flag, empty-patch no-op.
- All 65 prior tests pass unmodified.
- `npx tsc --noEmit`: clean.

## Rollout

Ships on `feat/threadline-cooldown-queue-drain`. With this commit, §4.4 is complete: config plumbing (commit 1), drain consumer wiring (commit 2), runtime PATCH endpoint (commit 3). The whole spec is now operationally complete except §4.5 follow-ups (DegradationReporter integration), which are observability nice-to-haves with no behavior dependency.
