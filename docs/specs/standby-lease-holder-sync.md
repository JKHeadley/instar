---
title: Standby lease-holder propagation (git-less lease coordination)
slug: standby-lease-holder-sync
status: approved
review-convergence: 2026-05-31T03:30:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate. Justin explicitly
  directed building this fix in-session on 2026-05-31 (topic 13481): after the
  live two-machine transfer test surfaced the bug he said "Go", then — when I
  proposed building it in a later fresh pass — corrected that as a non-reason for
  an Instar agent ("there is no long tail of a session, you just continue to
  work; instar handles infinite session length") and directed building it now,
  in-session. The full fix ships in THIS PR. Flagged per cross-agent discipline.
---

# Standby lease-holder propagation (git-less lease coordination)

## Problem

Found live, 2026-05-31, by the real two-machine test-as-self transfer proof
(driving Justin's Telegram via Playwright): a "move this to the Mac Mini"
transfer reached the final hop — the laptop forwarded the message over `/mesh/rpc`
— but the mini **rejected** it with `not-router`. Root cause, verified
empirically (`"Fenced lease active"` logged ZERO times on both machines):

The `LeaseCoordinator` runs on NEITHER machine. The lease setup in
`commands/server.ts` was nested inside a single `try` gated on
`coordinator.enabled && isGitRepo && gitBackupEnabled`, whose first statement is
`new GitSyncManager(...)`. On Echo's laptop that throws — the agent home IS an
instar checkout, so `SourceTreeGuard` refuses `GitSyncManager` — and the `catch`
swallowed the entire block, including the git-LESS `HttpLeaseTransport`. On the
mini, `gitBackup.enabled` is `false`, so the same block is skipped outright.

With no lease coordinator, `coordinator.getSyncStatus().leaseHolder` is null on a
peer. `MeshRpc.checkCommandRBAC` gates the router-only commands
(`deliverMessage`/`place`/`transfer`) on `routerHolder() === sender`, where
`routerHolder = () => coordinator.getSyncStatus().leaseHolder`. So the mini
(leaseHolder=null) rejects the laptop (the real holder) as `not-router`, and
cross-machine session transfer is impossible. Unit/e2e tests mock a
synced-lease state, so they stayed green — only a live two-machine run exposes it.

A second, latent bug was found by the new regression test: even with the lease
coordinator running, the HTTP tunnel-observe path self-rejected every broadcast.
`HttpLeaseTransport.recordObserved` stamps the per-holder nonce watermark to the
observed lease's OWN nonce (by design, for replay-on-receive); `LeaseCoordinator.
effectiveView` then passed that same watermark to `FencedLease.acceptTunnelLease`,
whose replay guard rejects `msg.nonce <= lastNonce` — i.e. it rejected the very
lease it was validating. The path had never worked; it only never mattered
because the coordinator never ran.

## Goal

A machine without a git medium — a credential-less standby, or an agent whose
home is the instar source tree where `SourceTreeGuard` refuses `GitSyncManager`
— still coordinates the fenced lease over the existing authenticated HTTP
channel, so its `leaseHolder` resolves to the real holder and MeshRpc router-only
commands (the cross-machine transfer hop) are authorized.

## Non-goals

- No change to the git-backed CAS path when git-sync IS available — `GitLeaseStore`
  remains the stronger shared-CAS substrate and is used whenever git works.
- No change to `FencedLease.acceptTunnelLease`'s replay semantics (the `<=`
  guard is intentional and unit-tested) or to `HttpLeaseTransport`'s on-receive
  replay watermark (also unit-tested).
- Not strengthening split-brain guarantees beyond the existing tunnel design
  (RTT-bounded acquisition + observe-before-acquire); a git-less mesh inherits
  the tunnel's coordination, not git CAS.

## Design

1. **`LocalLeaseStore`** (new, `src/core/LocalLeaseStore.ts`) — a git-less
   `LeaseStore`: persists THIS machine's own lease view to a local JSON file
   (`<stateDir>/lease-local.json`, durable across restarts) and implements the
   same strict-advance CAS as `GitLeaseStore`. It is NOT a shared substrate;
   cross-machine propagation rides `HttpLeaseTransport` (broadcast/observe), which
   `LeaseCoordinator.effectiveView` folds in. Corrupt file → reads empty
   (self-healing; the lease re-acquires or re-observes).

2. **`commands/server.ts` restructure** — gate the cross-machine block on
   `coordinator.enabled && coordinator.identity` (not `gitBackupEnabled`).
   Git-sync (`GitSyncManager` + `RegistrySyncDebouncer`) becomes an INTERNAL,
   best-effort optional in its own nested `try` gated on `isGitRepo &&
   gitBackupEnabled`; its failure logs and leaves `gitSyncRef` undefined but does
   NOT skip the lease/handoff/live-tail transports. The lease store is then
   `gitSyncRef ? GitLeaseStore : LocalLeaseStore`. `HttpLeaseTransport` +
   `LeaseCoordinator` + handoff/reply-marker/live-tail run regardless.

3. **`LeaseCoordinator.effectiveView` fix** — when validating the tunnel-observed
   lease, exclude its own holder from the nonce floor passed to
   `acceptTunnelLease` (the transport already replay-guarded it on receive; the
   signature + git-floor + epoch-newer checks still run). This stops the
   self-rejection so a genuine standby broadcast is folded in.

## Testing

- Tier 1: `LocalLeaseStore.test.ts` (CAS strict-advance, durable persistence,
  refresh/supersede, corrupt-file self-heal). `StandbyLeaseObservation.test.ts`
  (the regression: a git-less standby with `LocalLeaseStore` + `HttpLeaseTransport`
  resolves the holder from a real `recordObserved` broadcast; the holder side
  acquires + broadcasts). Existing `LeaseCoordinator`/`FencedLease`/
  `HttpLeaseTransport` suites stay green (no replay-semantic regression).
- Tier 3: re-run the live two-machine "move this to the Mac Mini" transfer after
  deploy — the mini must accept the forwarded message and serve the moved session.

## Migration parity

No config defaults, hooks, CLAUDE.md sections, or routes change. The fix is pure
boot-wiring + a new internal store; existing agents get it on update via the new
server build. `lease-local.json` is created on demand.
