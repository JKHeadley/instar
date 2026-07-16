# Ownership-gated spawn Increment 1.4 — side effects

## Scope

Live operator evidence on 2026-07-15 showed topic 29723, owned and pinned to the Laptop, also cold-spawned on the Mac Mini. The SpawnAdmission callsite was present, but the shipping `dryRun:true` posture converted its `other-alive` refusal into an allowed local spawn.

## Behavioral change

`ownershipGatedSpawn.enforceLiveOwner` defaults true. On a dev-live multi-machine pool, a cached ownership record naming a different, currently-live machine now refuses the local spawn only when the durable inbound queue is live. The handler then uses its existing custody/forward path. The recorded owner still spawns normally.

The change does not graduate the owner-dark ladder: other-dark, registry-error, unowned, queue-dark, pool-dark, fleet-dark, and single-machine paths retain their prior allow/dry-run behavior. This keeps the broader Increment-2 prerequisites intact.

## Risks and containment

- A stale liveness/ownership view could refuse locally. Durable custody is a structural prerequisite, so the message is queued/forwarded rather than lost.
- Flag skew remains coherence-critical and visible through the existing machine-coherence guard.
- Reversal is one config field: `ownershipGatedSpawn.enforceLiveOwner:false` restores full Increment-1 observe-only behavior.

## Verification

Regression coverage pins non-owner refusal, owner allowance, single-machine no-op, custody-dark fallback, and owner-dark non-graduation. Existing admission-table, callsite-wiring, and burst E2E consumers remain required before push.

`GET /pool/duplicate-reconciler` exposes `spawnAdmission.liveOwnerEnforcement` with `configured`, `armed`, and the precise blocked prerequisite, so rollout state is observable rather than inferred from config.

The decision-audit record is generated from this follow-up's staged behavioral file and the same reviewed artifact after the initial worktree lacked an active Husky shim; it is committed rather than bypassed.
