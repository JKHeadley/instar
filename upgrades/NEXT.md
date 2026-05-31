# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Multi-machine: a standby machine can now actually receive a transferred session.**
When you run one agent across two machines, the machines agree on which one is "in
charge" via a lease (a who-is-the-captain token). Cross-machine commands — like
moving a conversation to the other machine — are only accepted from the recognized
captain. A live two-machine test surfaced that the standby machine had no idea who
the captain was, so it refused every hand-off. Root cause: the code that runs the
captain-tracking system was bundled with git backup, and on machines where git
backup is blocked or off (including an agent whose home is the instar source tree),
the whole system silently never started. This change runs the captain-tracking
system over the machines' existing secure connection whenever multi-machine is on,
independent of git — so a standby learns the captain and accepts the hand-off. A
second, latent bug (the standby discarding the captain's announcements due to an
over-strict duplicate check) is fixed too. Single-machine agents are unaffected.

## What to Tell Your User

If you run on one machine, nothing changes. If you run one agent across two
machines, moving a conversation to the other machine now works end to end —
previously the second machine would quietly refuse the hand-off because it never
learned which machine was in charge. Nothing to configure.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Git-less lease coordination | Automatic. A machine with no git medium (a credential-less standby, or an agent home that is the instar source tree) now coordinates the lease over the existing HTTP channel and learns the holder, so cross-machine transfer is authorized. No configuration. |

## Evidence

- New `LocalLeaseStore` (git-less lease store) unit tests:
  `tests/unit/LocalLeaseStore.test.ts` (5 cases — strict-advance CAS, durable
  persistence across instances, refresh/supersede, corrupt-file self-heal).
- Regression: `tests/unit/StandbyLeaseObservation.test.ts` (3 cases — a git-less
  standby resolves the holder from a real HttpLeaseTransport broadcast; the holder
  acquires + broadcasts). This is the gap the mocked suites missed.
- Existing `LeaseCoordinator` (16), `FencedLease` (21), `HttpLeaseTransport` (6)
  suites stay green — no replay-semantic regression. `server` (17) + `middleware`
  (27) green — boot wiring unaffected. `tsc --noEmit` + repo lint clean.
- Live Tier-3: re-run the two-machine "move this to the other machine" transfer
  after deploy; the standby accepts the forwarded message and serves the session.
- Side-effects: `upgrades/side-effects/standby-lease-holder-sync.md`.
