# Side-Effects Review — Revoked machines stay revoked across re-register

**Version / slug:** `revoked-peers-stay-revoked`
**Date:** `2026-06-07`
**Author:** `Echo`
**Tier:** 1 (one guard in one registry method; no API/route/config/migration)
**Second-pass reviewer:** `Echo (self) — Tier-1; the "which doors can resurrect a revocation" analysis below is load-bearing`

## Summary of the change

A revoked mesh machine (the stale Mac Mini) came back **active** after an update
(2026-06-07 topic 21816): it kept sending mesh/live-tail chatter. Root cause:
`MachineIdentityManager.registerMachine` rebuilt the entry as
`{ ...(existing ?? {}), status: 'active', ... }` — so a re-register (re-join / re-pair /
post-update self-registration) **clobbered a `revoked` status back to `active`**. The
merge path (`mergeRegistry.mergeEntry`) already keeps revocation sticky; this was the
OTHER door. Fix: `registerMachine` now refuses to resurrect a revoked entry — if the
existing entry is `status === 'revoked'` or has `revokedAt`, it logs loudly and returns
without touching the entry. File: `src/core/MachineIdentity.ts`.

## Decision-point inventory

- `registerMachine` — modify — add a pre-write guard: a revoked existing entry is left
  untouched (no resurrection). The only decision: does a re-register override a
  revocation. It no longer does.
- `ensureSelfRegistered` — unchanged — it already no-ops when ANY entry exists (line:
  `if (registry.machines[id]) return false`), so a revoked self never reaches
  registerMachine through it; the guard is belt-and-suspenders for direct callers.
- `revokeMachine` / un-revoke — unchanged — explicit un-revoke remains the deliberate
  path back to active.
- No message block/allow surface. No new route/config/migration.

## 1. Over-block (refusing a legitimate registration)

The guard fires ONLY when an entry already exists AND is revoked. A brand-new machine
(no entry) and a normal active re-register (idempotent role/nickname/lastSeen refresh)
are unaffected — verified by the "still registers a brand-new machine normally" test and
the existing register/updateRole suite. So no legitimate join is blocked.

## 2. Under-block (a machine that SHOULD come back can't)

A deliberately un-revoked machine: un-revoke clears `status: 'revoked'` / `revokedAt`
(the explicit operator path), after which registerMachine proceeds normally. So intended
restoration still works; only SILENT resurrection-by-re-register is blocked. This is the
requirement ("revoked peers stay revoked across updates").

## 3. Level-of-abstraction fit

Correct layer. The registry is the authority for machine membership; the guard sits at
the single write that was clobbering status. Deterministic, no I/O beyond the existing
load/save, no LLM.

## 4. Blast radius

Single method in a multi-machine-only path (a single-machine agent never revokes/
re-registers a peer). When no revocation exists (the overwhelming common case) behavior
is identical. The guard returns early (void) — callers that ignored the return value
(it was already `void`) are unaffected.

## 5. Rollback

Pure code revert. No state/format/config change. A registry that already has a
correctly-revoked entry stays correct.

## 6. Tests

`machine-identity.test.ts` (new cases): a revoked machine re-registered stays revoked
(status/role/revokedAt/revokedBy preserved, not resurrected); a brand-new machine still
registers active. 75 machine-identity unit tests green; `tsc --noEmit` clean;
no-silent-fallbacks budget unaffected (the guard adds a `return`, no catch).
