# Side-Effects Review — mesh hand-back rope-health wiring

## Change and defect class

Production now injects a server-scoped adapter over `PeerEndpointResolver.snapshot()` directly into the U4.4 hand-back reconciler. The defect class is **synthetic-only dependency injection**: tests supplied an authority input manually, but the production composition root never supplied it, allowing an action-bearing feature to appear complete while remaining permanently inert.

Class-level correction: an adapter converts the resolver’s single-authority rows into a per-peer verdict with explicit three-valued and temporal semantics. No row or only never-dialed rows is `undefined`; a successful dial is `true` only when it is newer than that rope’s latest failure and fresher than one lease TTL; observed rows with no current successful rope are `false`. The focused test exercises all three states through the same exported adapter production uses.

## Signal versus authority

The adapter is a signal source, not transfer authority. The existing hand-back reconciler still requires every independent gate: holder status, preferred identity, heartbeat freshness, lease eligibility, quota, continuous health window, clean boundary, no split-brain, no churn latch, valid signed consent, and successful fenced claim. Missing or throwing health input remains fail-closed.

## Over-fire and under-fire

- Over-fire is bounded by requiring a real successful dial (`lastOkAt > 0`) newer than the rope’s last failure and fresher than one lease TTL. Merely advertising an endpoint, allocating a resolver row, retaining an old success, or remaining below the resolver’s three-failure demotion threshold is not health.
- Under-fire remains possible until real mesh traffic produces a result; this is deliberate. The lease holder keeps serving rather than transferring on inference.

## Cross-machine and rollout posture

The provider is scoped directly to one server’s hand-back reconciler and reads that server’s per-machine resolver authority. It is not installed into the module-global synthetic-test seam, so an embedded restart or second server lifecycle cannot inherit another resolver. Nothing new is replicated and no new route or credential surface is added. Single-machine installs have no peer rows and therefore remain a no-op. Hand-back remains controlled by its existing enable/dry-run chokepoint and requires live poll-follows-lease.

## External effects and rollback

The only new effect is that an already-enabled hand-back reconciler can progress past its health gate using real evidence. Disable `multiMachine.leaseSelfHeal.preferredCaptainHandback` to return to sticky leases. Removing the provider registration returns to the prior fail-closed inert posture; there is no migration or durable state.

## Verification

- `tests/unit/LeaseHandbackReconciler.test.ts`: 27/27 pass.
- `npm run build`: TypeScript and generated-manifest build pass.
- Real two-host proof is the release acceptance gate: paired baseline, laptop drop, bounded Mini takeover, real served reply, laptop rejoin, clean preferred hand-back, and no paired-read double-serving.

## Second-pass review

**Reviewer:** independent lease-handback reviewer

The first pass raised two concrete concerns: historical success could remain healthy indefinitely or survive newer sub-threshold failures, and a process-global provider could leak across server lifecycles. Both were folded before commit: health now requires strict success-after-failure ordering plus a one-lease-TTL freshness bound, with old-success, newer-failure, and same-millisecond ambiguity tests; production now injects a server-scoped adapter directly into its reconciler. Upgrade wording was also narrowed until the live pair proof passes.

**Independent verdict:** Concur with the review. The folded implementation fails closed on never-observed, stale, newer-failure, and same-millisecond ambiguity; repeated reads cannot manufacture continuous health; production authority is server-scoped; and the live two-host proof remains the release gate.
