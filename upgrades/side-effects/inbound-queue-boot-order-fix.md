# Side-Effects Review — Inbound-Queue Boot-Order Fix

**Tier:** 1 (latent behavior-correctness fix restoring intended behavior — no new capability, no new config key, no new route, no new authority). **Parent principle:** Structure > Willpower / feature-is-alive — a feature that can never construct is a broken feature; this restores the intended construction path and pins it with a regression guard.
**Files:** src/commands/server.ts, src/core/inboundQueueConfig.ts, tests/unit/resolve-session-pool-stage.test.ts (new), tests/unit/inbound-queue-boot-order.test.ts (new)

## The bug

The Durable Inbound Message Queue (`multiMachine.sessionPool.inboundQueue`, spec `docs/specs/durable-inbound-message-queue.md`) NEVER constructed its engine, regardless of correct config, because of a boot-ordering bug in `src/commands/server.ts`:

- `let _sessionPoolStage: () => string = () => 'dark';` — a module-level stub initialized to always return `'dark'`.
- The inbound-queue engine construction is gated `if (qcfg.enabled && _sessionPoolStage() !== 'dark') { … _inboundQueue = new QueueDrainLoop(…) … }`, running SYNCHRONOUSLY in the mesh boot block (`if (meshIdMgr && meshSelfId)`) inside `startServer()`.
- The ONLY reassignment of `_sessionPoolStage` to the real (liveConfig-reading) impl executes ~350 lines BELOW that construction site, also synchronously, in the same block.

At construction time the stub is still in force → `_sessionPoolStage()` returns `'dark'` → `'dark' !== 'dark'` is false → the engine never constructs. The same gate guards the `else if (_sweptInboundStore)` cleanup branch. Net: the feature has been inert since it shipped (it ships dark/dry-run by default, so nobody on the fleet hit it). `/pool/queue` returns 503 forever even with `inboundQueue.enabled=true` + a non-dark stage.

## The no-deferrals audit — every `_sessionPoolStage()` call site

Grepped ALL uses of `_sessionPoolStage` in `src/commands/server.ts`. Verdict for each:

| Line (main) | Context | Runs synchronously at boot before the ~16045 reassignment? | Verdict |
|---|---|---|---|
| ~443 | `let _sessionPoolStage = () => 'dark'` | n/a (the stub declaration) | the bug SOURCE — left in place by design (runtime handlers legitimately close over it) |
| ~1992 | inside `wireTelegramRouting` (the per-message inbound dispatch handler) | NO — invoked per-message at runtime, after boot; closes over the ref and sees the wired impl | FINE — not fixed |
| ~2000 | inside `wireTelegramRouting` (same handler) | NO — same as above | FINE — not fixed |
| ~14434 | inside the `onAccepted` callback (fires when a forwarded mesh message arrives) | NO — runtime mesh-message handler; closes over the ref | FINE — not fixed |
| ~15694 | the inbound-queue engine CONSTRUCTION gate | **YES** — synchronous boot read, BEFORE the ~16045 reassignment | **BUGGY — FIXED** |
| ~16045 | the `_sessionPoolStage = () => {…}` reassignment to the real impl | n/a (the assignment itself; everything after it sees the wired impl) | FINE — refactored to use the shared helper |

Exactly ONE genuinely-premature boot-time read (15694). No sibling premature read left unfixed. The three runtime-handler reads (1992/2000/14434) are correct as-is — they execute only after boot, by which time the ref is wired; the `session-pool-activation-wiring.test.ts` structural test continues to assert those handlers use `_sessionPoolStage()`, and it stays green.

## What changed

1. **`src/core/inboundQueueConfig.ts`** — added a pure helper `resolveSessionPoolStage(cfg)` that returns the configured `stage` only when the pool is BOTH `enabled` AND carries a `stage`, else `'dark'`. This becomes the single source of truth for the stage decision, eliminating the hand-duplicated logic that let the two readers drift. No config types, defaults, or invariants changed.
2. **`src/commands/server.ts` (construction site, ~15694):** the gate now computes the stage INLINE — `const _sessionPoolStageNow = (() => { try { const live = liveConfig.get('multiMachine.sessionPool', fallback); return iqcMod.resolveSessionPoolStage(live); } catch { return 'dark'; } })();` — mirroring the ~16045 impl exactly (liveConfig override over the static config block), then gates on `qcfg.enabled && _sessionPoolStageNow !== 'dark'`. It no longer consults the not-yet-wired `_sessionPoolStage()` ref.
3. **`src/commands/server.ts` (the real getter, ~16045):** refactored to call the same `resolveSessionPoolStage` helper (dynamic-imported at that site, matching the file's existing dynamic-import pattern) instead of its own inline copy of the logic. Behavior identical; now DRY with the boot gate.
4. **Tests (new):** `tests/unit/resolve-session-pool-stage.test.ts` (5) proves the resolution logic on both sides of the decision boundary; `tests/unit/inbound-queue-boot-order.test.ts` (5) is the structural regression guard — it asserts the construction gate no longer reads the stub, resolves inline before gating, routes both readers through the shared helper, and leaves the stub declaration intact.

## Blast radius (activation, explicit)

- **Fleet = no-op.** The inbound queue ships `enabled: false` (and `dryRun: true` even when enabled) by default. No fleet agent's behavior changes: with the queue disabled, `qcfg.enabled` is false and the gate short-circuits before the stage is even consulted.
- **Any agent with `inboundQueue.enabled=true` AND `sessionPool` stage `!== 'dark'`** will now CONSTRUCT the queue engine where before it silently did not. `/pool/queue` flips from 503 to 200. For **Echo** this is the intended **no-dark-on-dev activation** — the dev agent enabling the feature live is the first real exercise of the construction path, which is exactly the path this fixes.
- **Multi-machine posture:** machine-local construction only. This is a behavior-correctness fix — it changes WHEN an existing local decision is read, not any cross-machine protocol, route, or mesh verb. A single-machine agent that hasn't enabled the queue is wholly unaffected.
- **No new authority surface.** The construction still requires the full existing gate chain (enabled + non-dark stage + the six config-seam invariants validated by `validateInboundQueueInvariants` + dry-run handling). Nothing about WHAT the queue is allowed to do changed.

## Risk + mitigation

- **Risk:** the inline read disagrees with the live getter (the same drift class that caused the bug). **Mitigation:** both now call the single `resolveSessionPoolStage` helper — there is no second copy of the logic to drift. Pinned by `inbound-queue-boot-order.test.ts` (asserts ≥2 helper callsites) + `resolve-session-pool-stage.test.ts`.
- **Risk:** a config-read throw at the inline site crashes boot or builds a half-configured queue. **Mitigation:** the inline resolution is try/caught and fails to `'dark'` (the safe, queue-OFF direction = the shipped default), carrying an in-brace `@silent-fallback-ok` justification. Verified against `tests/unit/no-silent-fallbacks.test.ts` (baseline unchanged at 474).
- **Risk:** the fix accidentally activates the queue on the fleet. **Mitigation:** the `qcfg.enabled` half of the gate is untouched and still defaults false; the fix only corrects the stage half. Fleet default behavior is byte-identical.

## Migration parity

- No agent-installed files changed: no `.claude/settings.json` hooks, no `.instar/config.json` defaults, no CLAUDE.md template section, no hook scripts, no built-in skills. `resolveSessionPoolStage` is a pure code helper consumed only by `server.ts`. No `PostUpdateMigrator` change is needed — existing agents pick up the corrected construction path the moment their server runs the new code.

## Dark-gate line-map

- UNCHANGED. The change touches `src/core/inboundQueueConfig.ts` (a new pure function, no `enabled:` literal) and `src/commands/server.ts` (no `ConfigDefaults.ts` edit). The dark-gate attributor reads `src/core/ConfigDefaults.ts` only and matches `enabled:` lines; no such line shifted. Verified: `tests/unit/lint-dev-agent-dark-gate.test.ts` → 24/24 green, unchanged.

## Rollback

- Revert the two source edits (the inline resolution at the construction site + the helper call at the getter) and delete the helper + the two new test files. The queue reverts to never-constructing (the prior broken-but-inert state). Because the feature ships dark, the revert is a strict no-op on the fleet. No data migration, no durable-state change.

## Tests

- `tests/unit/resolve-session-pool-stage.test.ts` (5) — the stage-resolution logic: enabled+stage→stage; enabled+missing-stage→dark; disabled→dark; empty/null/undefined→dark; non-string stage coerced.
- `tests/unit/inbound-queue-boot-order.test.ts` (5) — the structural regression guard: the construction gate does not call the stub getter; resolves inline; resolution precedes the gate; both readers use the shared helper; the stub declaration is intact. Fails-before/passes-after verified (4 of 5 assertions fail against pre-fix `server.ts`; all 5 pass against the fix).
- Existing coverage already proves feature-alive: `tests/integration/inbound-queue-route.test.ts` (engine present → 200, absent → 503) and `tests/e2e/inbound-queue-lifecycle.test.ts` (boot-sweep → construct → drain → /pool/queue 200).
- Green locally: `npx tsc --noEmit` clean; the two new suites + `session-pool-activation-wiring` + `inbound-queue-route` + `inbound-queue-config` + `no-silent-fallbacks` + `feature-delivery-completeness` + `route-completeness` + `lint-dev-agent-dark-gate` (159 tests) all pass.

## Agent awareness

- No CLAUDE.md change. The inbound queue is already documented in the agent template ("Durable Inbound Message Queue + Hold-for-Stability"); this fix restores the documented behavior rather than adding a capability, so no `generateClaudeMd`/`migrateClaudeMd` change is required (feature-delivery-completeness green — no new tracked section). <!-- tracked: inbound-queue-boot-order-fix -->
