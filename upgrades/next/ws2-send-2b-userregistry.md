# Upgrade Guide — WS2-SEND-2b: userRegistry send-side replication

<!-- bump: patch -->

## What Changed

The `userRegistry` store (a PII kind) is now wired into the WS2 send-side. Unlike the
seamed memory stores, there is no single canonical `UserManager` — telegram (send-only +
normal mode) and slack each construct their own long-lived instance. A shared
`attachUserReplication` helper in `server.ts` wires the generic emitter (#1168) to each at
its construction site, and `userRegistry` flips PENDING→WIRED in the ratchet (leaving only
`preferences`). Channel-keyed identity — the local userId never crosses. Dark by default
(`multiMachine.stateSync.userRegistry`). No new route/verb/config-default/migration.

## What to Tell Your User

- **The people I know now travel across machines**: "If you run me on more than one
  machine, a user I learn about on one (from telegram or slack) now shows up in my user
  registry on the others — one shared set of people instead of one per machine. Only the
  profile crosses (name, channels, permissions) — never the local id I use internally, and
  identity is matched by a person's channel set so the same person collapses to one record
  across machines. Importantly, a user record that arrives from another machine is a HINT
  only — it is NEVER how I decide who an incoming message is actually from (that stays a
  local, verified decision). It stays off until you ask me to turn on multi-machine sync."
  ⚗️ Experimental — ships dark.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Cross-machine replication of the user registry (profile metadata, channel-keyed) | Automatic once `multiMachine.stateSync.userRegistry` is enabled (off by default) |
| Same person (same channel set) on two machines collapses to one record | Automatic (read path) |
| Removing a user propagates a channel-keyed tombstone (no resurrection) | Automatic (removeUser path) |

## Known capture-scope (honest)

The in-process emitter captures the dominant server-process user-creation paths (telegram
both modes + slack inbound). Two secondary paths are NOT captured by design and are
documented in the side-effects review: the Slack org-permission admin route (a per-request
UserManager) and the `instar user add` CLI (a separate process). A single canonical-instance
funnel would close both and is a reasonable future refactor.

## Evidence

Verified by a two-instance in-process E2E
(`tests/e2e/ws2-userregistry-cross-instance.test.ts`): a user added on instance A is read
back on B through the bypass-proof union reader as a foreign-origin record (channel-keyed,
local userId confirmed ABSENT); the same user (same channel set) on both machines collapses
to one record key across origins; and a removeUser on A replicates as a channel-keyed
tombstone so B resolves the key to "no record". `tsc --noEmit` clean; the new e2e (3) passes;
the ws2-send-wiring integration ratchet (4) accepts the PENDING→WIRED move.
