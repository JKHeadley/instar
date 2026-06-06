# Convergence Report — Pool-Wide Parallel-Work Awareness (P4)

Spec: `docs/specs/POOL-WIDE-PARALLEL-WORK-SPEC.md`
Converged: 2026-06-06 (2 rounds)
Reviewers: 1 combined internal deep pass (integration + adversarial +
lessons — sized to the smallest phase) + cross-model `codex-cli:gpt-5.5`.

## Round summary

| Round | Material findings | Outcome |
|-------|-------------------|---------|
| 1 | 6 (combined) + 2 (codex) | All folded |
| 2 | Fold-verify (author-checked; all folds were reviewer-prescribed text) | **CONVERGED** |

## Headline catches

- Row-shape contract: the local and remote rows barely overlapped — now a
  DISCRIMINATED union (`kind: 'local'|'remote'`) with named-null absent
  fields, and the `running` PROVENANCE ASYMMETRY stated (local = live
  in-memory truth; remote = replica-derived, staleness-tagged).
- The fold is NET-NEW code on raw `query()` — `readOwnAutonomousRuns` is
  own-stream-only by construction and no lifecycle helper exists; the
  "sibling of the P3 fold" framing was aspirational and is corrected.
- Gapped-replica false `running:true`: staleness measures recency, not
  completeness — `lowConfidence` rides the bound-hit flag TODAY; the full
  streamStatus qualifier names its P1.3 reader dependency explicitly.
- `possibleOverlap` would have cried wolf on EVERY routine transfer (the
  ~2-reaper-tick closeout window) — now annotated `recentMove: true` via
  the answer-complete placement stream; and the pairing covers
  remote↔remote double-running, not just local↔remote (codex).
- Per-instance running derivation (per sessionId/runId, then any-active
  aggregation) — a later terminal for session B never masks a
  still-running session A (codex).
- The intent-text-replication deferral was mis-filed under the P3
  machine-swap marker — re-homed to its OWN registered item (P4.2 row
  added to the project plan's Tier 5 table).

## Approval

Standing directive (Justin, topic 13481, 2026-06-06 ~03:05 PDT). ELI16
sent to 13481 with the convergence note.
