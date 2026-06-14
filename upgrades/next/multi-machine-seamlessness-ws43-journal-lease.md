# Multi-machine seamlessness — journal-lease cutover (WS4.3)

## What Changed

- **Scheduled-job claims can upgrade from the best-effort AgentBus broadcast to a
  durable, epoch-fenced lease over the replicated journal.** The decision is made by
  a single pure gate (`JobLeaseCutoverGate.decideClaimPath`): the journal-lease path
  engages ONLY when the flag is on AND the pool is flag-coherent — every ONLINE peer
  advertises the `ws43JournalLease` capability in its heartbeat. An older peer (no
  flags field) or a peer with the flag off keeps the WHOLE pool on the legacy bus.
- **The cutover guarantees the two claim mechanisms are NEVER both live for the same
  job set** — the named migration hazard the spec's "Cutover discipline" rule closes
  (one machine leasing via the journal while a peer broadcasts via the bus). Each
  scheduler evaluation returns exactly one path; the release seam idempotently closes
  whichever store took the claim.
- **Epoch fencing** (`JobLeaseClaimStore`): a claim carries the coordinator's lease
  epoch; a stale-epoch peer record is rejected on apply and a same/older-epoch peer
  lease fences our claim out — so a demoted machine's late claim can't steal a job
  from the current lease-holder, and a partition double-run is structurally prevented
  when the journal is reachable. Claim records store METADATA ONLY (machine, slug,
  epoch, timestamps) — never job payloads.
- Ships **dark** behind `multiMachine.seamlessness.ws43JournalLease` (default false)
  with `ws43JournalLeaseDryRun` default true — the first rollout rung logs intended
  journal claims while the legacy bus path still runs, so a dry-run pool never
  half-migrates. Flag-off / mixed-pool / single-machine = byte-for-byte today's
  behavior (the bus path). The advert is only `true` when the flag is on AND not
  dry-run. Plain seamlessness booleans (read live at the claim boundary), so absence
  yields the safe default without a migration — no migrateConfig entry needed.

This completes the WS4.3 workstream alongside the merged jobs read-side (#1104) and
role-guard-at-spawn (#1147). <!-- tracked: CMT-1416 -->

## Evidence

- `tests/unit/job-lease-cutover-gate.test.ts` (9): the full decision matrix —
  flag-off → bus; single-machine / all-peers-offline → no-op bus; coherent →
  journal; ONE non-advertising peer → whole pool on bus; older peer (absent flags)
  counts as non-advertising; an offline incoherent peer does NOT block coherence;
  dry-run → bus with journalDryRun flagged; and the explicit "NEVER returns both
  mechanisms" invariant.
- `tests/unit/job-lease-claim-store.test.ts` (8): take/idempotent-reclaim; a peer's
  live lease blocks our same/older-epoch claim; our strictly-newer epoch supersedes;
  applyRemote rejects a stale-epoch record; no self-spoof; completion releases;
  expired peer lease no longer blocks; durable round-trip across restart.
- `tests/integration/scheduler-journal-lease-cutover.test.ts` (6): the scheduler
  routes through the gate — coherent→journal (bus NOT called), mixed→bus (journal
  NOT taken), dry-run→bus, single-machine no-op, remote-journal-lease→skip, and a
  live flag flip at the boundary changing the path immediately.
- `tests/e2e/scheduler-journal-lease-cutover-alive.test.ts` (4): the EXACT server.ts
  provider closure (real config + real MultiMachineCoordinator epoch + real
  MachinePoolRegistry fed by a real heartbeat) drives a real triggerJob — coherent
  takes the journal lease and never the bus; mixed takes the bus and never the
  journal; flag-off no-op; single-machine no-op. Proves the wiring is live, not a stub.
- `tsc --noEmit` clean; no-silent-fallbacks, the dev-agent dark-gate line-map (+18
  recompute via the attributor), and feature-delivery-completeness all green;
  docs-coverage class floor improved (new symbols documented in under-the-hood.md +
  multi-machine.md).

## What to Tell Your User

This is internal multi-machine plumbing that ships turned off, so you will not
see a change. When it is eventually enabled on a fleet where all your machines
support it, your scheduled jobs get a more reliable way to avoid two machines
running the same job at once — a durable, fenced claim instead of a best-effort
broadcast. Until then, and on any single-machine setup or a mixed fleet, job
scheduling behaves exactly as it does today. There is nothing to configure and no
action needed.

## Summary of New Capabilities

- WS4.3 journal-lease cutover: scheduled-job claims can upgrade from the AgentBus
  broadcast to a durable, epoch-fenced lease over the replicated journal, engaged
  only when every online peer advertises the capability (flag coherence). A single
  gate guarantees the two claim mechanisms are never both live for one job set.
  Ships dark behind multiMachine.seamlessness.ws43JournalLease (dry-run default);
  single-machine and mixed-pool installs are a strict no-op.
