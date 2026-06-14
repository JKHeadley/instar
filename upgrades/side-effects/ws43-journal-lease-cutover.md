# Side-Effects Review — WS4.3 journal-lease cutover

**Spec:** `docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md` §WS4.3 ("Cutover discipline")
**Slug:** ws43-journal-lease-cutover
**Tier:** 2 (multi-machine correctness invariant; safety-invariant risk floor)
**Flag:** `multiMachine.seamlessness.ws43JournalLease` (default false), `ws43JournalLeaseDryRun` (default true)

## What changed

Scheduled-job claim deduplication can now upgrade from the legacy best-effort
AgentBus broadcast (`JobClaimManager`) to a durable, epoch-fenced lease over the
replicated journal (`JobLeaseClaimStore`). A single pure decision point
(`JobLeaseCutoverGate.decideClaimPath`) selects which mechanism a job uses, and
the scheduler routes its three claim seams (remote-claim check, claim-before-spawn,
release-on-complete) through that decision. New files: `src/scheduler/
JobLeaseCutoverGate.ts`, `src/scheduler/JobLeaseClaimStore.ts`. Wired into
`JobScheduler` (new `setJournalLeaseCutover` injector + `resolveClaimPath`/
`releaseClaim` helpers) and `server.ts` (the production provider closure reading
the flag + coordinator lease epoch + pool peers' advertised capability). Config
defaults + types + the `seamlessnessFlags` heartbeat advert added.

## Phase 1 — Principle check (signal vs authority)

This IS a decision point (it gates which claim mechanism runs). It is correctly
an **authority** because dedup is a correctness mechanism, not a signal — but the
authority is NARROW and STRUCTURAL: the gate keys ONLY on objective facts (flag
state, online-peer presence, the boolean capability each peer advertises in its
authenticated heartbeat) — never on interpreting message content or any brittle
heuristic. It cannot block a user action; the worst case is "stay on the legacy
bus path," which is byte-for-byte today's behavior. The gate fails toward the
conservative side (bus) on any ambiguity (older peer, offline peer, throwing gate
read). This complies with `docs/signal-vs-authority.md`: a structural ownership/
coherence check, not a brittle content gate with blocking authority.

## Phase 4 — Review questions

1. **Over-block** — The gate never blocks a job; it only chooses a dedup
   mechanism. The journal lease's epoch fence could in principle refuse OUR claim
   if a peer holds a strictly-newer-epoch lease — but that is the correct
   behavior (the newer-epoch holder is the current lease-holder; we must yield).
   A same/older-epoch peer claim is fenced OUT, so we are never wrongly blocked by
   a stale peer. No legitimate run is wrongly rejected.

2. **Under-block** — The journal-lease path relies on the replicated journal
   actually carrying claim records between machines (`applyRemote`). This PR ships
   the gate + the local epoch-fenced store + the cutover wiring; the journal
   EMISSION/APPLY transport for the claim kind is the existing replication
   substrate's responsibility and is gated behind the same flag-coherence advert
   so an older peer that can't apply the kind keeps the WHOLE pool on the bus (it
   never advertises `ws43JournalLease`). Until the flag is flipped on a fully
   coherent pool, dedup behavior is IDENTICAL to today (bus). The dry-run default
   means even a flag-on coherent pool stays on the bus while logging intended
   claims — so under-block risk during rollout is zero (the bus is the baseline).

3. **Level-of-abstraction fit** — Correct layer. The cutover decision lives in
   the scheduler (which owns the claim seams), the gate is a pure function (no IO,
   independently testable), and the durable lease is its own store mirroring the
   existing `JobClaimManager` shape. The flag-coherence read reuses the existing
   `seamlessnessFlags` heartbeat advert + registry the WS1.1/WS4.4 gates already
   use — no parallel coherence machinery.

4. **Signal vs authority compliance** — Compliant (see Phase 1). Structural
   authority keyed on objective facts; fails conservative; no content heuristics;
   cannot block a user action.

5. **Interactions** — The gate guarantees the journal lease and the bus broadcast
   are NEVER both consulted for the same job in the same evaluation (exactly one
   `path` per decision) — the named migration hazard. The release seam calls
   BOTH stores' `completeClaim` idempotently (each is a no-op when this machine
   doesn't own the slug's record), so a mid-run flag flip between claim and
   complete cannot strand a lease. It composes cleanly with the WS4.3 role-guard
   (a separate spawn-boundary refusal that runs BEFORE the claim seam) — the two
   are orthogonal. No double-fire: `resolveClaimPath` is evaluated once at the
   check seam and the result reused at the claim seam.

6. **External surfaces** — Adds one boolean field (`ws43JournalLease`) to the
   `seamlessnessFlags` heartbeat advert. Additive — older peers omit it (read as
   non-participant, the conservative side). No new HTTP route. No user-visible
   message. The advert is only `true` when the flag is on AND not dry-run, so a
   dry-run machine never advertises participation it isn't actually performing.

7. **Multi-machine posture** — This feature IS multi-machine machinery.
   Posture: **machine-local decision fed by a proxied-on-read coherence view.**
   Each machine independently runs the gate over the peers' advertised capability
   (read live from the registry's heartbeat data), and the journal lease store is
   per-machine but its records replicate via the journal. Invariant-5 flag
   coherence is enforced: the cutover engages pool-wide ONLY when every online
   peer advertises the capability — never a window where one machine leases while
   a peer broadcasts. Single-machine (no peers) is a strict no-op (the gate
   returns `bus`/`single-machine` and the journal store is never touched). The
   epoch fence (coordinator lease epoch) carries ownership across a demotion so a
   demoted machine's stale claim can't steal a job. Designed for N machines, no
   2-peer assumption.

8. **Rollback cost** — Trivial. The feature is dark (flag default false). Flip
   `multiMachine.seamlessness.ws43JournalLease` off (or leave it absent) and the
   scheduler reverts to the legacy bus path with no migration, no data repair —
   the journal lease store is just an inert local JSON ledger. Dry-run (default)
   is an additional safe rung: flag on but no real cutover. The off-switch is read
   live at each claim boundary, so a config edit + session restart fully reverts.

## Phase 5 — Second-pass review (high-risk: touches scheduler claim/dedup + a "gate")

Concern lens applied: could the cutover ever let TWO machines run the same job?
- Within ONE machine's evaluation, the gate returns exactly one path — verified by
  the `NEVER returns both mechanisms` unit test and the integration/e2e
  `never-both` assertions (coherent → journal only; mixed → bus only).
- ACROSS machines: the cutover engages pool-wide only under flag coherence (every
  online peer advertises it), so the pool is either all-journal or all-bus for a
  job set — never split. A peer that can't participate keeps everyone on the bus.
- A demotion race is fenced by the lease epoch (stale-epoch applyRemote rejected;
  same/older-epoch tryClaim refused) — covered by the epoch-fence unit tests.

Concur with the review. The load-bearing invariant (no double-run across the
cutover; no stranded timers on a demoted machine) is structurally enforced by the
single-decision gate + epoch fence and is covered at all three test tiers.

## Tests

- Unit: `tests/unit/job-lease-cutover-gate.test.ts` (9), `tests/unit/
  job-lease-claim-store.test.ts` (8) — gate decision matrix incl. never-both +
  flag coherence + single-machine no-op; epoch fencing + durability.
- Integration: `tests/integration/scheduler-journal-lease-cutover.test.ts` (6) —
  the scheduler routes through the gate; coherent→journal, mixed→bus, dry-run,
  single-machine, remote-lease skip, live flag flip.
- E2E "feature is alive": `tests/e2e/scheduler-journal-lease-cutover-alive.test.ts`
  (4) — the EXACT server.ts provider closure (real config + real coordinator
  epoch + real MachinePoolRegistry heartbeat) drives a real triggerJob to take
  the journal lease vs the bus; proves the wiring is live, not a stub.

All 27 new tests pass; tsc clean; no-silent-fallbacks, dark-gate line-map, and
feature-delivery-completeness gates pass; docs-coverage class floor improved.
