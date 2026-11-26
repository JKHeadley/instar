# Side-Effects Review — refetchPr asks gh for `mergeCommit`, not the unsupported `mergeCommitOid`

**Version / slug:** `greenpr-refetch-gh-field`
**Date:** `2026-10-24`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (small, reversible): 2 source/test files plus artifacts, ~100 LOC. Effort: one build round, one commit attempt.

The green-PR watcher re-reads a pull request immediately before acting (`refetchPr`, `src/monitoring/greenPrAutomergeWiring.ts`). Its `gh pr view --json` field list named `mergeCommitOid`, which is not a field gh's PR JSON has (gh 2.97.0 answers `Unknown JSON field: "mergeCommitOid"` and exits 1; the real field is `mergeCommit`, an object with `.oid`). The seam read every non-zero exit as "the PR vanished" and returned null, so `GreenPrAutoMerger` audited `skipped:vanished` for EVERY pull request at act time and armed or merged nothing (found 2026-10-24 while PR #2334 sat green and unmerged; `logs/green-pr-automerge.jsonl` shows the events).

Fix: the projection asks for `mergeCommit` and maps `mergeCommitOid: mergeCommit?.oid ?? null`, so the returned shape (and every consumer) is unchanged. Both `--json` projections in the file (`refetchPr`, `listOpenPrs`) are now constants (`REFETCH_PR_JSON_FIELDS`, `LIST_PR_JSON_FIELDS`) pinned by a unit test to `GH_PR_JSON_FIELDS`, the set gh 2.97.0 prints for `gh pr view --json` — a constant check, no network. And a non-zero exit whose stderr says `Unknown JSON field: "<name>"` is now reported once per field per process through `DegradationReporter` (feature `GreenPrAutoMerger.refetchPr.unknownJsonField`) and the wiring logger, naming the field, before the read still returns null.

Scope check requested by the coordinator: every other `mergeCommitOid` in `src/` (InitiativeTracker, ProjectRound*, StageTransitionValidator, routes.ts, FeedbackExecutorService, FailureAttributionEngine) is an internal Initiative field name; none is passed to a `gh --json` call. The three other gh reads of the merge commit (`StageTransitionContext`, `commands/server.ts`, `executorPorts.ts`) already use `mergeCommit`. Nothing else needed the fix.

## Decision-point inventory

- `GreenPrAutoMerger` act-time pre-arm gate (`refetchPr` null → `skipped:vanished`) — pass-through — the gate's rule is unchanged; the read that feeds it now returns real data instead of a false null.
- `reportUnknownGhJsonField` — add — a signal only (degradation report + log line). It blocks nothing, allows nothing.

---

## 1. Over-block

No new block/allow surface. Before the fix the watcher over-blocked everything (every PR read as vanished); after it, a PR is skipped as vanished only when gh genuinely cannot read it. A truly deleted PR still returns null and is still skipped.

---

## 2. Under-block

The pin covers the two multi-field projections in this file; the five single-field literals (`state,mergedAt`, `state`, `autoMergeRequest`, `state,headRefName`, `title`) are valid gh fields but un-pinned. The drift REPORT is emitted only by the `refetchPr` seam; `listOpenPrs` already throws on a failed read, which feeds the watcher's tick-failed breaker (loud in its own way). A future `--json` call written elsewhere with a literal field list is outside both. A gh release that REMOVES a field from this set would make `GH_PR_JSON_FIELDS` stale; the unit test would still pass, but the runtime report would name the field within one tick. A gh that changes the wording of its unknown-field error would silence the report (the read still fails toward null, never toward merging).

---

## 3. Level-of-abstraction fit

Right layer: the wiring is the one place the watcher's gh projections live, so the pin and the drift report sit beside the calls they protect. The merger's decision (`null → vanished`) is untouched; it was correct given an honest null.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.

The field-drift report is a signal (DegradationReporter + logger). The only authority in the path, safe-merge at act time, is untouched, and the merger's null-handling still fails toward NOT merging.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The unknown-field match is a deterministic reading of gh's own error text, and it decides nothing.

---

## 5. Interactions

- **Shadowing:** none. The report runs only on a non-zero exit, before the existing `return null`.
- **Double-fire:** the merger may call `refetchPr` for several PRs per tick; the report is deduped per field per process, so one drift produces one report, not one per PR per tick. DegradationReporter's own per-feature cooldown applies on top.
- **Races:** none; the dedupe set is in-process and the seam is read-only.
- **Feedback loops:** none. The report feeds observability only.

---

## 6. External surfaces

GitHub is read with one changed field name; nothing is written. One new degradation feature key (`GreenPrAutoMerger.refetchPr.unknownJsonField`), one new audit-visible console/log line. No config, routes, dashboard, or operator-facing action — "No operator-facing actions."

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the watcher runs only on the serving-lease holder, and the drift report describes THAT machine's installed gh. GitHub is the shared truth being read. No user-facing notice is added (the degradation reporter's own routing is unchanged), no durable state, no URLs.

---

## 8. Rollback cost

Revert the commit and ship a patch. No persistent state, no migration. Reverting restores the broken read, so the rollback itself would re-create the incident.

---

## Conclusion

A one-field read error silently disabled the whole merge watcher because a bad exit was indistinguishable from a vanished PR. The fix corrects the field, pins the projections so a bad field fails a unit test, and makes the runtime failure loud instead of silent, while every failure still lands on "do not merge". Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (Claude), 2026-10-24
**Independent read of the artifact: concur**

The reviewer independently compared `GH_PR_JSON_FIELDS` against the installed gh (2.97.0, `gh pr view --json` with no field list): the two sets are identical, 46 for 46, and every `--json` list in `src/monitoring/greenPrAutomergeWiring.ts` — the two pinned constants plus the five un-pinned literals (`state,mergedAt`, `state`, `autoMergeRequest`, `state,headRefName`, `title`) — uses only fields in that set, so leaving the single-field literals un-pinned is an acceptable minimal-fix scope (one correction to the artifact's wording in §2, applied above: only the `refetchPr` seam emits the drift report; `listOpenPrs` still throws into the tick-failed breaker, which is loud in its own way). The change cannot cause a merge that would not have been intended before: `GreenPrAutoMerger` reads `mergeCommitOid` only into the `merged-at-unexpected-head` audit row, while the head-pin comparison at both consumer sites remains `autoMergeRequest.expectedHeadOid ?? headRefOid`, and a null `refetchPr` still lands on `skipped:vanished` / `armed-reconcile-read-failed` (never arm, never merge). The report is deduped by a module-level per-field Set before the logger and `DegradationReporter.report()` are reached, so a drift yields one report per process rather than one per PR per tick, with the reporter's own per-feature alert cooldown on top; both calls are try/catch-wrapped, and the import adds no cycle. The test is a real pin — re-adding `mergeCommitOid` to `REFETCH_PR_JSON_FIELDS` fails three assertions (not in `GH_PR_JSON_FIELDS`, `not.toContain('mergeCommitOid')` on the live call, and the exact-projection `toEqual`), and the file passes (23/23) in the worktree. Multi-machine and rollback posture are as stated: the Set is per-process on the lease holder (a lease move re-reports once, acceptable), and a revert simply reinstates the broken read.

---

## Evidence pointers

- `tests/unit/green-pr-automerge-wiring.test.ts`: `mergeCommit.oid` mapping; `mergeCommit: null` → `mergeCommitOid: null`; both projections ⊂ `GH_PR_JSON_FIELDS` and `mergeCommitOid` ∉ it; the live calls carry exactly the pinned lists; an `Unknown JSON field` exit reports once (feature + field named) and still returns null; an ordinary non-zero exit reports nothing.
- Live confirmation (gh 2.97.0): `gh pr view 2334 --json mergeCommitOid` → `Unknown JSON field: "mergeCommitOid"`, exit 1; `--json mergeCommit,headRefOid` → `{"headRefOid":"35f24dad…","mergeCommit":{"oid":"4c881706…"}}`.
- `logs/green-pr-automerge.jsonl`: `skipped:vanished` for PR 2334 at 2026-10-25T02:05:15Z and earlier ticks.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in a gh projection; the field pin in `tests/unit/green-pr-automerge-wiring.test.ts` is the regression guard).
