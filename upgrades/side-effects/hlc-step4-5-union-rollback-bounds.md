# Side-Effects Review — HLC Foundation Step 4 (union-reader + origin-tags + rollback-unmerge) + Step 5 (aggregate bounds)

**Version / slug:** `hlc-step4-5-union-rollback-bounds`
**Date:** `2026-06-13`
**Author:** `echo`
**Second-pass reviewer:** `not required`
**Spec:** `docs/specs/multi-machine-replicated-store-foundation.md` §7 + §8 (review-convergence tagged)

## Summary of the change

Implements Components 6 + 7 of the multi-machine replicated-store foundation on top
of the merged Step 1–3 substrate (HLC, the replicated-record envelope, single-origin
snapshot-then-tail). FIVE new pure/DI'd `src/core/` modules + the operator-facing
HTTP surface, all dark behind `multiMachine.stateSync.<store>` (default false); a
single-machine agent (empty kind registry) is a strict no-op.

- **UnionReader.ts** — the no-clobber union merge rule + the SOUND last-writer-witness
  concurrency detector (closes BLOCKER-4). `classifyPair` decides concurrency via the
  `observed` witness (`compare(w2.observed[K], w1.hlc) >= 0`), NEVER via a scalar
  `compare(w2.hlc, w1.hlc)` (the unsound test the spec replaces). Missing/below
  witness ⇒ flag, never resolve. High-impact concurrent ⇒ append-both-and-flag with a
  stable `conflictId`; low-impact ⇒ HLC-wins WITH a divergence flag.
- **ConflictStore.ts** — the durable open-conflicts ledger: idempotent on conflictId
  (no third copy on re-discovery), recurrence → forced-resolution, ONE deduped
  attention item, operator resolution (winner / merged), auto-resolve on origin-drop.
- **RollbackUnmerge.ts** (+ DroppedOriginRegistry) — §7.4 deterministic un-merge: the
  dropped origin is registered FIRST (union recomputes live → zero dangling refs),
  its replica streams + meta + snapshot-cache are quarantined-aside (rename, bounded-
  retain; the prune leg through SafeFsExecutor — never a destructive delete),
  conflicts referencing it auto-resolve. Reversible via reMerge.
- **ReplicatedStoreReader.ts** — the LOWEST store-access funnel; every read routes
  through the union (the wiring-integrity boundary). Consults the dropped-origin set
  live and records high-impact conflicts as a side-effect.
- **ReplicationBudget.ts** — Step 5 bounds: coalescing (latest-per-key/interval),
  the aggregate cross-kind fair-share throttle (anti-starvation, surfaced never
  silent), Phase-C budget scaling (perPeer × online-count, hard ceiling, rise-
  hysteresis), and the tombstone-horizon forced full-snapshot re-join.

Operator surface: `GET /state/conflicts`, `GET /state/quarantine`,
`POST /state/resolve-conflict` (503 when dark). CLAUDE.md awareness ("One Memory")
in both the new-agent template and the existing-agent migrator + shadow markers.

## Decision-point inventory

Two genuine decision boundaries, both surfaced + bounded, neither a user-action gate:
1. **Concurrency verdict** (sequential-after vs concurrent) — decided by the witness,
   provably err-toward-flag. The foundation NEVER picks a conflict winner.
2. **Conflict winner** — delegated UP to the operator via `POST /state/resolve-conflict`
   (Signal vs Authority). The route is Bearer-authenticated; the resolution writes a
   normal replicated record.

## 1. Over-block

**What legitimate inputs does this change reject?** Nothing user-initiated is blocked.
The only refusals are: a malformed resolve-conflict body (400, exactly-one of
winner/merged), an unknown conflictId (404), and a truncated snapshot at cutover
(inherited from Step 3). The witness detector deliberately OVER-flags toward "concurrent"
when a witness is missing — a clean sequential edit with NO `observed` witness is
flagged as a conflict rather than silently resolved. This is the spec's mandated safe
direction: a surfaced, operator-resolvable flag is strictly better than a silent
clobber. A concrete store (WS2.1) that stamps `observed` correctly will not see false
conflicts on its own sequential edits.

## 2. Under-block

**What does this still miss?** The foundation ships the registry EMPTY — no concrete
store replicates yet, so on every current install this is inert. The union reader's
per-origin record loader is a seam the WS2.1 consumer supplies; until then there is no
real data flowing through. The bounds machinery (retention/rate-cap/budget) is wired
but only binds when a real kind is registered. These are intentional — this PR is the
substrate, not a consumer.

## 3. Level-of-abstraction fit

**Right layer?** Yes. UnionReader is pure logic (HLC + crypto only) — the merge rule
lives in ONE place, unit-testable against an adversarial clock. ReplicatedStoreReader
is the single funnel (the §7.2 "no caller can bypass it" boundary). Rollback's
destructive prune routes through SafeFsExecutor (the existing destructive-fs funnel,
mirroring JournalSyncApplier.pruneQuarantine). Persistence uses
SafeFsExecutor.atomicWriteJsonSync. Construction sits next to the Step-3 substrate in
server.ts; the routes sit in the existing `/state/*` family.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

This foundation is MECHANISM, not a gate. It orders (HLC), unions (read), flags
(conflict), and un-merges (rollback) — it NEVER actuates and NEVER decides a conflict
winner. The one mutating authority (`POST /state/resolve-conflict`) is operator-
authenticated and writes a normal replicated record — the operator's authority,
surfaced, not the foundation's. The witness detector's err-toward-flag is the
signal-vs-authority discipline made structural: ambiguity becomes a surfaced flag for
the operator, never a silent machine decision.

## 5. Interactions

- **ConflictStore persistence performance:** recordConflict fires on EVERY union read
  of an open conflict. A naive persist-per-call was a disk-write storm (measured 34s
  for a 5000-read burst). Fixed: a pure recurrence-count bump is IN-MEMORY only; the
  ledger persists only on a real state transition (new entry, forced-resolution
  crossing, resolution, eviction). The count is advisory; losing the exact count
  across a restart is the documented safe direction.
- **Snapshot cache + rollback:** un-merge calls SnapshotCache.dropOrigin (the existing
  §7.4 hook from Step 3) — no new cache surface.
- **No new config keys under multiMachine** (no per-store `enabled` — those belong to
  WS2.1). The dark-gate line-map is therefore UNCHANGED (verified: the test passes
  unedited). The stateSync foundation knobs already in ConfigDefaults (Step 2) are
  backfilled by applyDefaults.

## 6. External surfaces

Three new HTTP routes (`/state/conflicts`, `/state/quarantine`,
`/state/resolve-conflict`) in the existing `/state/*` family, Bearer-gated, 503 when
dark. No new MCP tools, no new mesh verbs (the snapshot/tail verbs from Step 3 are
reused). Two durable state files: `.instar/state/state-sync/conflicts.json` and
`.../dropped-origins.json` (atomic writes, under the gitignored runtime-state
carve-out).

## 7. Rollback cost

Low. Every module is dark behind `multiMachine.stateSync.<store>` (default false) and
the kind registry ships empty, so on any current install the code path is never
entered — reverting the PR is a clean removal with no migration to undo. The CLAUDE.md
awareness section and config migration are idempotent and additive. The durable state
files only appear once a store is enabled.

## Conclusion

The change is mechanism, dark by default, single-machine no-op, and every decision
boundary is either surfaced (conflict flag), operator-delegated (resolve), or
provably safe (witness err-toward-flag). The destructive leg is funnelled through
SafeFsExecutor. No user action is blocked.

## Second-pass review (if required)

Not required — additive, dark-by-default foundation; no operator-surface quality
regression; the operator routes are observe + operator-authority-only.

## Evidence pointers

- Unit: `tests/unit/UnionReader.test.ts` (incl. §12 #5 adversarial-clock witness),
  `ConflictStore.test.ts`, `RollbackUnmerge.test.ts` (§12 #6 zero-dangling-refs),
  `ReplicatedStoreReader.test.ts` (§12 #11 wiring-integrity),
  `ReplicationBudget.test.ts` (§12 #9/#15 cross-kind starvation, §8.1 Phase-C, #13).
- Integration: `tests/integration/state-sync-routes.test.ts` (503-dark / 200-alive),
  `state-sync-burst-invariant.test.ts` (§12 #10 ONE attention per conflictId).
- E2E: `tests/e2e/state-sync-union-alive.test.ts` (feature-alive: union conflict
  open→resolvable over HTTP + rollback auto-close, 503 when dark, Bearer auth).
