# Side-Effects Review — Pool-Wide Parallel-Work Awareness build (P4.1)

**Version / slug:** `pool-activity-view-p4`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (implements the 2-round-converged P4 spec; a read-only fold over already-replicated journal streams; zero new stores/verbs/loops)`

## Summary of the change

POOL-WIDE-PARALLEL-WORK-SPEC (converged 2026-06-06; spec + report + eli16
ride this PR): `GET /parallel-work/activities?scope=pool` answers "what is
every machine of mine working on, and is anything overlapping?" by
composing the LOCAL parallel-work index with the journal replicas P1
already ships.

1. `src/core/PoolActivityView.ts` — NET-NEW fold on the reader's raw
   query() path (round-1: readOwnAutonomousRuns is own-only; no lifecycle
   helper exists). Discriminated union rows (`kind: 'local'|'remote'`)
   with NAMED null absences; remote `running` derived PER INSTANCE
   (sessionId/runId) then any-active aggregated — a later terminal for
   session B never masks still-running session A; `lowConfidence` rides
   the bound-hit flag; `possibleOverlap` pairs EVERY machine combination
   (local↔remote and remote↔remote) and is annotated `recentMove` from
   the answer-complete placement stream within the post-transfer closeout
   window — the settling transient is distinguished, never a wolf-cry.
2. The route: `?scope=pool` composes local + remote under the
   `pool: { selfMachineId, replicasRead, boundHit }` honesty header —
   LOCAL replica files, no peer fan-out (an offline peer's last-replicated
   streams still answer). Default scope byte-identical; a dark replica
   layer degrades pool scope to local rows (200); the pre-existing
   no-index 503 unchanged.

## 1-2. Over/Under-block

Over: none — read-only, never gates. Under: remote intent TEXT
(focus/tags) is machine-local by design (named absence; the P4.2 deferral
is registered in the project plan); the gapped-stream qualifier gains
teeth with the P1.3 reader states (named dependency — lowConfidence is
today's honest signal).

## 3. Fit / 4. Blast radius

A pure module + a query-param branch on the existing route. Provenance
asymmetry (live local truth vs replica-derived remote) is structural in
the row shape. Worst case = a mislabeled advisory row; nothing actuates
off this view (Signal vs Authority).

## Evidence

- tests/unit/PoolActivityView.test.ts — 5 passing: the union shape +
  named absences + honesty header; per-instance aggregation
  (B-terminal-never-masks-A); both kinds feeding one topic +
  artifactsKnown; overlap pairs incl. remote↔remote + the recentMove
  annotation; local-only degradation. Typecheck clean.
