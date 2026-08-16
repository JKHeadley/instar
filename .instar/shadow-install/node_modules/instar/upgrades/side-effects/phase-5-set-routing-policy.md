# Side-Effects Review — Phase 5 install routing policy at server boot

**Cycle:** Phase 5 wiring step 2 — install the CostAwareRoutingPolicy on
the global providers registry at server startup.
**Spec:** `specs/provider-portability/11-cost-aware-routing.md` (approved 2026-05-15)
**Reviewer status:** awaiting fresh second-pass.

## Summary of the change

A single block added to `src/commands/server.ts` right after the agent-
registry heartbeat block: dynamically imports the providers registry +
the routing policies (ChainPolicy / CostAwareRoutingPolicy /
FirstAvailablePolicy) and calls
`registry.setRoutingPolicy(new ChainPolicy([CostAware, FirstAvailable]))`
at boot. Wrapped in try/catch with a `(non-critical)` warning if the
install fails so it never blocks server startup.

The policy itself **decides nothing today** because no adapters are
registered against the providers registry yet — adapter registration
at startup depends on per-machine credential discovery (which Anthropic
adapters can boot? which Codex install is available?) and is tracked
as a separate cycle.

What this commit establishes: **any future caller of
`registry.resolve()`** flows through the routing chain by default,
instead of falling to first-by-registration. When adapter registration
lands, the chain is already in place.

## Files touched (in /instar-dev scope)

- `src/commands/server.ts` — ~30 added lines, no existing lines modified.

## Decision-point inventory

| Decision | Layer | Mode |
|---|---|---|
| Set the global routing policy | Server boot (one-time) | side-effect on `registry` singleton |

## 1. Over-block

- The policy install itself doesn't block anything (no decisions fire
  yet — no adapters registered).
- The try/catch around the install means a failure cannot prevent the
  server from booting.

## 2. Under-block

- **The `readSdkCredit` callback returns `null`** (state unknown). Per
  the spec's matrix, that routes to subscription floor. This is the
  conservative default until Tier 3.C wires a real UsageMeterProvider.
  When adapters land, sessions will route to subscription by default —
  which is correct fail-safe behavior, not a leak.
- **The CostAwareRoutingPolicy throws when no Anthropic candidate is in
  scope** (per spec § "Composition with other policies"). ChainPolicy
  catches and tries the next policy (FirstAvailable). This is the
  documented contract.

## 3. Level-of-abstraction fit

`src/commands/server.ts` is the composition root for server startup.
The agent-registry registration, heartbeat, and configuration loading
all live there. Adding the policy install here matches the existing
pattern.

Dynamic imports (`await import(...)`) avoid coupling the static import
graph of server.ts to the providers module tree — preserves cold-start
modularity.

## 4. Signal vs authority compliance

- The routing policy IS authority — it picks the adapter when multiple
  satisfy a request. Installing it at boot puts that authority in
  effect from the first session-spawn that uses the registry.
- Today, with no adapters registered, the policy has nothing to decide
  on, so its effective authority is zero. The install is forward-
  looking infrastructure.
- No new gates added; the existing `registry.resolve()` contract
  already routes through `routingPolicy` when set.

## 5. Interactions

- **Registry singleton**: this is the first writer of `routingPolicy`
  in production. Anything that previously relied on the "null policy →
  first-by-registration" behavior now flows through ChainPolicy. Since
  no adapter is registered today, behavior is unchanged at runtime.
- **Test code** that already calls `setRoutingPolicy` directly is
  unaffected — tests construct their own Registry instances or override
  the policy.
- **`instar route` CLI**: unaffected. It constructs its own
  FrameworkModelRouter directly and does not consume the providers
  registry.
- **Test-mode HTTP endpoints** (from previous commit `d4c9ac6e`): also
  unaffected. They construct ephemeral CostAwareRoutingPolicy instances
  rather than consuming the registry.

## 6. External surfaces

None changed. Console log line added at boot: `Routing policy installed:
ChainPolicy[CostAware, FirstAvailable]` — visible in server stdout.

## 7. Rollback cost

Revert one commit. The registry returns to "null policy" state at boot;
any future caller of `registry.resolve()` falls to first-by-registration
(the prior default). No data loss.

## Conclusion

Forward-looking infrastructure change. The policy is in place so future
adapter-registration work doesn't need to remember to wire it. The
spec § "Composition with other policies" recommends exactly this
ChainPolicy shape (PinHonoring → CostAware → FirstAvailable) — the
PinHonoring policy isn't in the codebase yet so the chain is currently
two-element; a follow-up cycle adds PinHonoringPolicy.

## Test evidence

- `node_modules/.bin/tsc --noEmit` — clean.
- The previous cycle's 11 scenarios still pass (the test-mode endpoints
  do not depend on the registry's policy state).

## Second-pass review

Independent reviewer (fresh subagent) verdict: **CONCUR**.

Verified: spec-matched chain, `readSdkCredit: null → subscription floor`
correct per matrix, try/catch makes install non-blocking, dynamic imports
preserve static graph, no adapter side-effects.

Three LOW polish items raised; all addressed in this commit:

1. **Comment fixed** — said "Pin → CostAware → FirstAvailable" but Pin
   isn't installed. Updated to "CostAware → FirstAvailable;
   PinHonoringPolicy pending".
2. **Idempotency guard added** — uses a Symbol marker on the registry
   singleton so re-entering `startServer` in the same process (test
   harness, in-proc respawn) doesn't clobber a previously-installed
   policy.
3. **Log line accuracy** — confirmed matches installed chain.

The reviewer noted the idempotency-guard pattern would benefit from
exposing `getRoutingPolicy()` on the registry public surface; tracked
as a follow-up (additive, no behavior change).

**Verdict: CONCUR.**
