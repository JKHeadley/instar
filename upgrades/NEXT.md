# Instar Upgrade Guide — NEXT

> In-flight shipment notes for the **Multi-Machine Session Pool** (active-active,
> per-session placement + transfer). Built track-by-track behind a dark stage
> gate; this guide grows as tracks land and becomes the versioned guide at the
> release cut. Spec: docs/specs/MULTI-MACHINE-SESSION-POOL-SPEC.md (approved).

## What Changed

**Multi-Machine Session Pool — foundation (Track A: Router-Leader Lease).** The
groundwork for one agent identity running across several machines, all awake at
once, with each conversation placed on the best-fit machine and transferable
between machines. This shipment lands the foundation and ships **dark** (the
entire layer is inert unless explicitly enabled and its rollout stage advanced):

- **Clock-jump-proof router lease.** The machine that holds the "who's in charge"
  lease now judges its own lease expiry on a **monotonic clock** instead of the
  wall clock. A wall-clock jump — an NTP correction, a VM pause/resume, a
  sleep/wake, or a CPU-starvation timer slip — can no longer fool a partitioned
  machine into thinking it still holds the lease (or into giving it up early).
  This is the lease-substrate-robustness hardening that the whole session pool
  rests on, and it directly answers the SleepWakeDetector CPU-starvation lesson.
- **Router role.** The existing leader lease is now also addressable as the
  "router" role (the machine that dispatches conversations to machines). On a
  single machine this is a no-op — it is its own router.
- **Dark config block.** A new `multiMachine.sessionPool` config block ships
  turned off (`enabled: false`, `stage: 'dark'`, `dryRun: true`). Existing
  agents receive these dark defaults automatically on update.

**Track B (part 1: machine nicknames).** Every machine the agent is installed on
now gets a friendly, auto-assigned **nickname** (e.g. "Mac Mini", "Justins Macbook
Pro") — the handle you'll use to say "run this on the mini" / "move this to <name>".
Nicknames are unique within the pool, editable, and derived deterministically from
the machine's hostname. Still dark (the Machines dashboard tab + the placement
commands that consume nicknames land in the next part of Track B).

## What to Tell Your User

Nothing changes for you yet — this ships turned off. When the full feature is
ready, your agent will be able to spread conversations across all the machines
it's installed on (and you'll get a Machines tab in the dashboard to name them
and move conversations between them by nickname). For now, this update just makes
the under-the-hood "who's in charge" machinery immune to clock jumps, which makes
everything steadier. A one-machine agent behaves exactly as before.

## Summary of New Capabilities

- Monotonic, clock-jump-proof self-fence for the router/leader lease
  (`LeaseCoordinator`).
- `MultiMachineCoordinator.isRouter()` — router-role accessor (alias of
  `holdsLease()`).
- `multiMachine.sessionPool` dark config block (`enabled`/`stage`/`dryRun`) with
  migration parity for existing agents.

## Evidence

- Tier-1 unit tests: monotonic self-fence (incl. the backward-wall-clock-jump
  immunity proof and the mid-tick `holdsLease` fence), real-monotonic default
  wiring integrity, `isRouter()`, and the dark config defaults + migration parity
  (adds-into-existing-multiMachine, no-clobber, inert, idempotent).
- 155 tests green across the lease/config/coordinator/seamlessness cluster after
  the change; tsc clean. Full suite runs in CI.
- Side-effects review: upgrades/side-effects/session-pool-track-a-router-lease.md
