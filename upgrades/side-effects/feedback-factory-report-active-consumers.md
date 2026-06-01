# Side-Effects Review — feedback-factory: normalize the active-set + report-partition consumers

**Slug:** `feedback-factory-report-active-consumers`
**Date:** `2026-05-31`
**Author:** Echo
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved 2026-05-26, topic 12476)
**Builds on:** #651 (canonical status normalization primitives in `transitions.ts` + parity comparator)
**Second-pass reviewer:** not required (two call-site swaps onto an already-merged, already-reviewed primitive; both-sides-of-boundary unit coverage)
**Scope:** Two internal consumers of cluster status that #651 did not touch — `FeedbackStore.getActiveClusters` (the merge-candidate set) and `partitionClustersForReport` (the operator-digest partitioner). Both now key off the canonical `normalizeStatus` / `isTerminalStatus` primitives instead of raw v1 literals.

## Summary of the change

During the Portal→Instar migration three status vocabularies coexist; #651 reconciled them in the parity comparator. Two internal call-sites were still raw:

- `FeedbackStore.getActiveClusters` returned `clusters.filter(c => c.status !== 'resolved')`. `resolved` is a v1 literal; live v2/v3.1 clusters reach terminal as `closed` / `verified` / `wontfix` / `duplicate` / `chronic_escalated` / `legacy_closed`, none of which equal `'resolved'`. Result: every canonical terminal cluster was kept active forever as a merge candidate. (It also missed a raw v1 `resolved`, which is terminal only once projected to `closed`.)
- `partitionClustersForReport` matched `c.status === 'open'` (new-issues bucket) and `c.status === 'fixed'` (fixed bucket). Live clusters born `new` and resolved `fix_applied` never matched, silently emptying those report partitions.

The fix imports `isTerminalStatus` / `normalizeStatus` from `transitions.ts` (single owner, merged in #651) and: (a) active = `!isTerminalStatus(c.status ?? '')`; (b) open partition = `normalizeStatus(c.status ?? '') === 'new'`, fixed partition = `=== 'fix_applied'`. `c.status` is optional, so `?? ''` preserves the prior undefined→active / undefined→excluded behavior. No route, job, or schema change.

## Decision-point inventory

- `FeedbackStore.getActiveClusters` active/terminal filter — **modify** — raw `!== 'resolved'` → `!isTerminalStatus(normalized)`. Excludes the full terminal set; keeps every non-terminal state (incl. legacy `open`/`fixed` → `new`/`fix_applied`).
- `partitionClustersForReport` open/investigating/fixed buckets — **modify** — raw `=== 'open'`/`'fixed'` → normalized `=== 'new'`/`'fix_applied'`; `investigating` unchanged (identity under normalization).
- No new primitives — both reuse the #651 `transitions.ts` exports.

---

## 1. Over-block

Neither call-site is an allow/block surface over user or agent traffic.

- `getActiveClusters` over-inclusion (the real prior bug) was the inverse of a block: it kept terminal clusters as merge candidates, so new feedback could be merged into an already-closed cluster instead of opening a fresh one. The fix REMOVES that over-inclusion; it does not newly exclude any non-terminal cluster (every non-terminal v1/v2 state is asserted still-active in `store.test.ts`).
- `partitionClustersForReport` decides report visibility, not gating. No new suppression: the open/fixed partitions now include MORE (the v2-spelled clusters that were silently dropped), never fewer.

---

## 2. Under-block

**What real signal could normalization now mask?** Only a difference that vanishes under the fixed v1→v2 map (`open→new`, `fixed→fix_applied`, `resolved→closed`; identity otherwise) — the same small bijection reviewed in #651. For the active set: a cluster is dropped from merge candidates only when its normalized status is genuinely terminal; a non-terminal state can never normalize into the terminal set (asserted both-sides in `store.test.ts`). For the report: a `new`/`fix_applied`/`investigating` cluster is bucketed exactly as its v1 synonym would have been — no real "new issue" or "fix" is hidden; the change only stops hiding the v2-spelled ones. `legacy_closed` (terminal-only, not in `V2_STATES`) is correctly excluded from the active set via `isTerminalStatus`.

---

## 3. Level-of-abstraction fit

Correct layer, and an explicit de-duplication: both consumers now call the shared `transitions.ts` primitives rather than re-encoding status semantics inline. This is the single-owner outcome — the vocabulary lives in one module (`transitions.ts`), and the store + report partitioner are pure consumers. No separate `statusVocab` module is introduced (an earlier scratch line that would have duplicated the primitives is deliberately abandoned). No higher-level gate is bypassed; no lower-level primitive is re-implemented.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — neither change has any block/allow authority over user/agent messages or operations.

`getActiveClusters` produces the merge-candidate SIGNAL consumed by the clustering step; the authoritative cluster history remains the curated store, untouched here. `partitionClustersForReport` produces a digest-visibility signal consumed by a human-read operator report. Both become MORE accurate (no stranded terminals, no dropped v2 clusters) without gaining new authority.

---

## Testing

- `tests/unit/feedback-factory/store.test.ts` — getActiveClusters keeps every non-terminal lifecycle state (incl. legacy `open`/`fixed`) active; excludes EVERY terminal state (`closed`, `verified`, `wontfix`, `duplicate`, `chronic_escalated`, `legacy_closed`, raw `resolved`).
- `tests/unit/feedback-factory/reportPartition.test.ts` — canonical `new` surfaces in the open partition; canonical `fix_applied` in the fixed partition; a mixed v1/v2 batch partitions identically.
- Full feedback-factory suite: 165 unit + integration green; `tsc --noEmit` clean.
