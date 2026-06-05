# Side-Effects Review — Secret-Sync push opt-in (receive-only default)

**Version / slug:** `secret-sync-push-guard`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `not required` (Tier 2; single-author, safety-tightening change)

## Summary of the change

Adds an anti-clobber safety guard to cross-machine secret-sync (PR #771 / v1.3.258). Previously
`multiMachine.secretSync.enabled` activated BOTH receive and push, and a boot best-effort
push fired unconditionally — so a machine whose local secret store is stale/divergent would
auto-push its stale set to peers and overwrite their good secrets. This change splits push out
behind `multiMachine.secretSync.pushEnabled` (default **false**): `enabled` alone is now
RECEIVE-ONLY; outbound (boot push + `POST /secrets/sync-now`) requires `pushEnabled: true`,
set only on the machine whose store is authoritative. Files: `src/commands/server.ts` (gate +
handle field + boot-push guard), `src/core/SecretSync.ts` (`SecretSyncHandle.pushEnabled`),
`src/core/types.ts` (config field), `src/server/routes.ts` (sync-status reports `mode`;
sync-now 409s when receive-only), `src/scaffold/templates.ts` + `PostUpdateMigrator.ts`
(agent awareness, incl. a migration for agents that already have the section).

Earned live: 2026-06-04 the mini's store drifted (keychain↔file master-key); enabling the
original (push-on) secret-sync there would have clobbered the laptop's authoritative secrets.

## Decision-point inventory

- `multiMachine.secretSync.pushEnabled` gate (server.ts) — **add** — splits outbound from inbound.
- Boot best-effort `provisionAll()` (server.ts) — **modify** — now gated on pushEnabled.
- `POST /secrets/sync-now` (routes.ts) — **modify** — returns 409 when receive-only.
- `GET /secrets/sync-status` (routes.ts) — **modify** — now reports `pushEnabled` + `mode`.

## 1. Over-block

The guard "blocks" outbound push when `pushEnabled` is false — that is the intended behavior, not
over-block. A user who genuinely wants push must set `pushEnabled: true` (one config line). No
legitimate RECEIVE is blocked. The 409 response names the exact remedy.

## 2. Under-block

The guard does not validate that the push-enabled machine's store is ACTUALLY authoritative — it
trusts the operator's `pushEnabled: true`. A misconfiguration (pushEnabled on a stale machine)
could still clobber. Mitigated by: default-off (you must deliberately opt in) + the doc guidance
("set only on the machine whose store is authoritative"). A value-hash reconciliation (only push
keys the peer is missing/older) is a sound follow-up but out of scope here.

## 3. Level-of-abstraction fit

Right layer: a config flag + a wiring gate, consistent with the rest of secret-sync. It reuses the
existing provisioner/handle; no new primitive. The default-off posture matches the project's
"dark by default" rollout discipline for risky features.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over user messages. (It gates an internal
  outbound sync action behind an explicit config flag — deterministic, not a heuristic gate.)

## 5. Interactions

- **Shadowing:** none — `pushEnabled` only narrows when the existing push path runs.
- **Double-fire:** reduces it — the boot push no longer fires on receive-only machines.
- **Races:** unchanged — same SecretStore read-modify-write as before; receive path untouched.
- **Feedback loops:** none. A receive-only machine that gets corrected by an authoritative push
  does NOT re-push (it can't), so no ping-pong.

## 6. External surfaces

- **Peers:** strictly safer — a receive-only machine no longer sends to peers at all.
- **Config:** new optional field `multiMachine.secretSync.pushEnabled` (absent ⇒ false ⇒ no push).
  No migrateConfig default needed (absence = safe default).
- **API:** `/secrets/sync-status` gains `pushEnabled` + `mode` fields (additive); `/secrets/sync-now`
  can now return 409 (receive-only) in addition to its prior 200/503/500.
- **Persistent state:** none changed.

## 7. Rollback cost

Pure code change. Revert = secret-sync returns to push-on-enable (the less-safe prior behavior).
No persistent state to unwind. Because push was never enabled on any real machine between #771 and
this change (the mini incident is exactly why), there is no in-the-wild push to reconcile.

## Conclusion

A small, safety-tightening change with a default-off posture; it closes the divergent-store clobber
risk that the 2026-06-04 mini incident exposed and makes laptop→mini the safe reconciliation
direction for the live verification. The one residual (operator opts pushEnabled on a non-authoritative
machine) is documented and a value-hash reconciliation is the natural follow-up. Clear to ship.

## Evidence pointers

16 tests green: 8 unit, 5 integration (incl. the new receive-only guard test: sync-now 409s + peer
vault untouched), 3 e2e. tsc + lint clean. Spec updated (Guarantees → "Push is opt-in"). Related: the
SecretStore keychain-drift repair that surfaced this (re-key file→keychain).
