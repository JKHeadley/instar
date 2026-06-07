<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

A revoked mesh machine (the stale Mac Mini) came back **active** after an update
(2026-06-07, topic 21816) and resumed sending mesh/live-tail chatter. Root cause:
`MachineIdentityManager.registerMachine` rebuilt the entry with `status: 'active'`, so a
re-register (re-join / re-pair / post-update self-registration) clobbered a `revoked`
status back to active. The merge path (`mergeRegistry`) already kept revocation sticky;
this was the other door. Fix: `registerMachine` now refuses to resurrect a revoked entry
— if the existing entry is `status: 'revoked'` or has `revokedAt`, it logs loudly and
leaves the entry untouched. A revoked machine stays revoked across updates; the only path
back to active is an explicit un-revoke.

## What to Tell Your User

If they revoked a machine and it kept coming back after updates: it won't anymore. A
revoked machine stays revoked until they explicitly un-revoke it. Nothing to do.

## Summary of New Capabilities

- `MachineIdentityManager.registerMachine` is now revocation-sticky: re-registering a
  machine whose existing entry is revoked is refused (logged, entry left intact) instead
  of silently flipping it back to active. `ensureSelfRegistered` already no-ops on any
  existing entry; explicit un-revoke remains the deliberate restore path.

## Scope (honest)

Contained Tier-1 guard in one method (`src/core/MachineIdentity.ts`). Multi-machine only
(a single-machine agent never hits this). Normal joins / active re-registers are
unaffected; only resurrection of a revoked entry is blocked. No new API/route/config/
migration. Justin already re-quarantined the Mini live during the incident; this is the
durable code fix so it can't recur.

## Evidence

`machine-identity.test.ts` (new cases): a revoked machine re-registered stays revoked
(status/role/revokedAt/revokedBy preserved); a brand-new machine still registers active.
75 machine-identity unit tests green; `tsc --noEmit` clean; no-silent-fallbacks budget
unaffected (the guard adds a `return`, no catch). causalAutopsy: latent — registerMachine
always rebuilt with `status: 'active'`; only surfaced once a revoked machine re-registered
after an update (the Mac Mini case). Symmetric with the already-sticky merge path.
