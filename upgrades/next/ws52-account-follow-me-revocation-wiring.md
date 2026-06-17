# WS5.2 Account Follow-Me — R12 revocation data-plane WIRING

**Slug:** `ws52-account-follow-me-revocation-wiring`
**Spec:** `docs/specs/ws52-account-follow-me-security.md` (R12; OQ6 per-server model; gap 9 offline deadline)

## What Changed

The pure R12 revocation executor (`src/core/AccountFollowMeRevocation.ts`) was merged but nothing called it. This increment makes it FUNCTIONAL, per the spec's PER-SERVER model (OQ6): the operator revokes the `account-follow-me` mandate on the TARGET machine's OWN dashboard, so the target runs its OWN local revocation — this is local, never a cross-machine wipe-instruction.

- **Server construction.** `AccountFollowMeRevocation` is built once in the server with REAL deps: a real cooperative wipe (`buildCooperativeWipe` — framework logout against the account's `CLAUDE_CONFIG_DIR` + delete the per-account config-home dir via SafeFsExecutor + `SubscriptionPool.remove`, fail-closed per step), a DURABLE JSON pending-wipe ledger (survives restarts), the real attention emitter, and an `enabled()` read LIVE off the same `multiMachine.accountFollowMe` dev-gate as the rest of the feature.
- **Route trigger.** `/mandate/:id/revoke` now detects an `account-follow-me` authority on the revoked mandate and fires the LOCAL data-plane wipe (`cooperative-online` posture), surfacing the honest outcome on the response. Non-account-follow-me revokes are completely unaffected.
- **Deadline sweep.** A periodic (5-min, unref'd) sweep drives `sweepDeadlines()` so an offline-pending wipe past its reconnect-deadline escalates to the LOUD `revocation-FAILED — rotate at provider NOW` HIGH attention item.
- **Config + migration.** `multiMachine.accountFollowMe.revocationReconnectDeadlineMs` (default 6h — hours, not days) ships in ConfigDefaults and lands on deployed agents via an existence-checked, idempotent `migrateConfig` step.

Everything is DARK behind `multiMachine.accountFollowMe` (live-on-dev / dark-fleet). Flag-off / single-machine = strict no-op: the route trigger does nothing for a non-follow-me mandate, and the sweep returns nothing.

**Not wired (deliberate, honest):** the executor's offline / de-paired branches, `onTargetReconnect`, and the dashboard render. Those belong to a future CROSS-MACHINE revoke increment — the per-server model is cleanly local and never enters them, so they are left dormant-but-correct rather than stubbed.

## Evidence

- `npx tsc --noEmit` clean.
- 46 tests green:
  - `tests/unit/account-followme-revocation-wiring.test.ts` (10) — real cooperative wipe (fail-closed per step; the default deleteSlot really removes the config-home dir), durable store survives a restart, corrupt ledger is fail-safe, composed executor + real deps end-to-end.
  - `tests/unit/account-followme-revocation-server-wiring.test.ts` (17) — server.ts constructs with real deps (not the in-memory seam, not no-ops), AgentServer threads it, the route fires it, ConfigDefaults + migrator carry the deadline; migration is idempotent + existence-checked + never clobbers an override.
  - `tests/integration/account-followme-revocation-route.test.ts` (4) — Tier-2: revoking an account-follow-me mandate over the REAL route runs a real local wipe (account gone, `state: 'removed'`); a non-follow-me revoke is unaffected; flag-off and executor-unwired are strict no-ops.
  - No regression: the merged executor's 15 + `ws52-account-follow-me-wiring` (12) + `mandate-routes` (15) still pass.
- Side-effects review (8 questions) + mandatory independent second-pass pending: `upgrades/side-effects/ws52-account-follow-me-revocation-wiring.md`.

## What to Tell Your User

Nothing to do — this is internal multi-machine account-sharing groundwork, shipped off by default (dark on the fleet, live on a development agent). It makes "stop following this account to this machine" actually take effect: when you revoke account sharing on a machine, that machine now really logs the account out, deletes its login slot, and drops it from the pool — and it always tells you the TRUTH (it never claims a credential was destroyed everywhere when it wasn't). No user-facing surface in this release.

## Summary of New Capabilities

Internal: the R12 revocation data-plane is now LIVE-on-dev. Revoking an `account-follow-me` mandate on a machine triggers that machine's own local wipe (logout + slot delete + pool removal), with a durable offline-pending ledger and a bounded `revocation-pending → revocation-FAILED` escalation. The honest-state guarantee from the executor is now reachable through the real route. Dark behind `multiMachine.accountFollowMe`; the cross-machine revoke path and the dashboard render are tracked follow-ons.
