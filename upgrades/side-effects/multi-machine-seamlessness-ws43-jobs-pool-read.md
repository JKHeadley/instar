# Side-Effects Review — WS4.3 read-side: GET /jobs?scope=pool + divergence detector

**Version / slug:** `multi-machine-seamlessness-ws43-jobs-pool-read`
**Date:** `2026-06-12`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `workflow adversarial reviewer (CONCUR — 1 LOW fixed)`

## Summary of the change

The read-side of WS4.3 (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.3): `GET /jobs?scope=pool`
merges every online peer's jobs into one view (which machine runs each job),
mirroring the proven `sessions?scope=pool` / WS4.1 `attention?scope=pool` family —
per-peer 5s timeout, `pool.failed[]` markers (never a 500), offline-peer skip, 3s
short-TTL cache, machine tagging. Plus an observe-only F8 placement-divergence
detector. Files: `src/server/routes.ts` (route + `jobsPoolMerge` + `detectJobDivergences`),
`src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` (Agent Awareness +
Migration Parity). The role-guard-at-spawn and journal-lease cutover are SEPARATE
follow-up slices (not in this PR). <!-- tracked: CMT-1416 -->

## Decision-point inventory

- `GET /jobs?scope=pool` merge — **add** — read-only aggregation; never mutates a
  job, never gates; tolerant fan-out.
- `detectJobDivergences` — **add** — observe-only signal in `pool.divergences[]`;
  flags ONLY `declared>0 && running===0` (a machine that should run jobs but isn't).

---

## 1. Over-block
No block/allow surface — read-only. The divergence detector after the LOW fix flags
ONLY the real case (declares N>0, runs 0). A machine declaring 0 jobs is NOT flagged
(was self-noise — fixed: a scheduler-less/dispatcher-only machine legitimately has none).

## 2. Under-block
Capacity carries no declared-job count, so divergence is derived from each machine's
own `/jobs` reply (declared = jobs returned, running = `runsOnThisMachine===true`
count). A machine that is DOWN (no reply) is in `pool.failed[]`, not `divergences` —
so a fully-dark machine's jobs aren't flagged as "running 0" (correct; it's a
reachability failure, surfaced separately). No fabricated counts.

## 3. Level-of-abstraction fit
Right layer — mirrors the sessions/attention pool-scope route code exactly (same
fan-out/timeout/failed/cache/tag shape); the divergence helper is a pure function
over the merged replies.

## 4. Signal vs authority compliance
Compliant — pure read + an observe-only signal. Gates nothing.

## 5. Interactions
- Plain `GET /jobs` is byte-for-byte unchanged (`{jobs,queue}`; no `pool` object, no
  machine tags) — only `?scope=pool` adds them.
- The cache key is fixed (`'jobs'`) and read/written only inside `jobsPoolMerge`;
  there are no status/scope variants to cross-contaminate (stronger isolation than
  attention's status-keyed cache).
- Peers are called WITHOUT `scope` → no recursive fan-out storm.

## 6. External surfaces
- New query mode on an existing route; old callers (no `?scope=pool`) unaffected.
- Calls each peer's `GET /jobs` with the agent bearer (same pattern as
  sessions/attention pool scope). An old peer returns its local jobs → merges fine.

## Framework generality
No framework-launch abstraction touched (this is a read/merge route only; no change
to `frameworkSessionLaunch.ts`). The job model is framework-agnostic; the merge tags
machines, not frameworks. N/A beyond that.

## 7. Multi-machine posture (Cross-Machine Coherence)
**proxied-on-read** — fans out to peers per request (cached 3s), each job tagged with
its owning machine; consults the pool registry's online flag to skip dark peers
cheaply. No replication, no durable cross-machine state in this slice. Phase-C clean:
per-online-peer fan-out, O(jobs) divergence, no 2-peer assumption.

## 8. Rollback cost
Trivial: additive scope branch; reverting restores today's local-only `GET /jobs`.
No durable state; the CLAUDE.md migrator bullet is idempotent (content-sniffed).

---

## Second-pass review

Workflow adversarial reviewer: **CONCUR** (tscClean, testsPass; all 7 audit points
verified incl. tolerant fan-out, back-compat, cache isolation, observe-only +
no-fabricated-count divergence, non-recursive peers, awareness+migration parity,
tests proven failing pre-change). One **LOW**: a scheduler-less/no-jobs machine
self-flagged a "declares 0 jobs while online" divergence (self-noise). **FIXED**:
the detector now flags ONLY `declared>0 && running===0`; the 0-jobs case is dropped
(legitimate, not a divergence), and its test now asserts NO divergence for a
zero-jobs peer.
