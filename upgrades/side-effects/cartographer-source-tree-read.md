# Side-Effects Review — Cartographer protected-source read declaration

**Version / slug:** `cartographer-source-tree-read`
**Date:** `2026-08-02`
**Author:** `Instar-codey`
**Second-pass reviewer:** `Plato (item11b1_second_pass)`

## Summary of the change

`src/core/cartographerDetect.ts` now passes `sourceTreeReadOk: true` on its two `rev-parse` calls and one streaming `ls-tree` call. These are the existing detector's only Git operations. The option is effective only for verbs already enumerated in `SOURCE_TREE_READ_TIER_VERBS`; no guard implementation or allowlist changes. `tests/unit/cartographer-ls-tree-stream.test.ts` adds a catch-all wiring assertion and a real protected-checkout regression. `docs/eli16/cartographer-source-tree-read.eli16.md` explains the operational defect and boundary.

## Decision-point inventory

- `SafeGitExecutor` source-tree assertion for Cartographer detect — **pass-through** — the hard safety authority remains unchanged; this call site requests its existing narrow read tier.
- Cartographer detect posture (`ok` versus `structural-only`) — **modified input reachability** — a verified Instar checkout can now supply Git object IDs instead of being misclassified as Git-unreadable.
- Paid authoring admission — **passed through** — root verification, exact-revision revalidation, routing, lease, pressure, and cost bounds are unchanged.

---

## 1. Over-block

No new rejection is added. The fixed legitimate input is a verified topic binding whose checkout is the protected Instar source tree; it previously degraded to structural-only despite every Git operation being read-only. Non-allowlisted and destructive Git shapes remain blocked even when this option is present.

## 2. Under-block

The option does not bypass verb or shape classification. `rev-parse` and `ls-tree` are already in the closed read-tier allowlist; changing either call to a destructive verb would fail classification or the source-tree guard. This does not make unverified roots authorable, does not ignore revision drift, and does not permit working-tree writes.

## 3. Level-of-abstraction fit

This is the existing per-invocation declaration designed for callers that legitimately read the protected source checkout. Changing `SourceTreeGuard`, adding a global exception, or treating the live refusal as structural-only would be the wrong layer. The Cartographer call site owns knowledge that its three commands are read-only and therefore owns the opt-in.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.

There is no judgment block/allow surface. The underlying safety guard is the documented irreversible-action carve-out: it retains deterministic authority, and this change uses its existing closed read-only floor without adding a brittle judgment rule.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new heuristic or competing-signals judgment point. Git command shapes are an enumerable mechanical domain: the option works only when the verb is already in the fixed read-tier set.

## 5. Interactions

- **Shadowing:** root authority still runs before detect and paid writes still revalidate afterward; the read declaration removes an accidental false block between those existing checks.
- **Double-fire:** no timer, poller, or new caller is added. A one-shot pass remains one engine invocation; the recurring poller remains gated by `freshnessSweep.enabled`.
- **Races:** no new shared state. The detector still streams one `ls-tree`, atomically updates the index, and writes its snapshot through the existing paths.
- **Feedback loops:** authored summaries can now advance on the protected checkout, but existing per-pass node/cost caps, cursor, quarantine, and pressure brakes are unchanged.

## 6. External surfaces

Live `/cartographer/health`, `/cartographer/stale`, and navigation snapshots for a verified Instar checkout change from false `structural-only`/null Git metadata to real Git-backed results. No response schema changes. No external service, user notice, new URL, database, config key, or operator action is added. The only persistent writes are the existing machine-local regenerable Cartographer cache and audit rows.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Root identity, checkout path, HEAD revision, Git object IDs, and Cartographer caches describe one machine's checkout. Each machine must independently resolve and read its own verified root. This change emits no user-facing notice, creates no replicated durable record, and generates no URL.

## 8. Rollback cost

Pure call-site code change. Revert and ship a patch; no data migration or state repair. Existing caches are regenerable. Rollback would restore false structural-only reporting and block authoring on protected Instar checkouts until the next fix.

## Conclusion

The fix is deliberately limited to the three read-only commands the live failure exposed. The safety allowlist, destructive-operation guard, root authority, recurring-sweep gate, cost bounds, and navigation ceiling do not move. The change is ready for validation and an independent safety review.

## Second-pass review (if required)

**Reviewer:** Plato (item11b1_second_pass)
**Independent read of the artifact:** concur

The reviewer confirmed the diff grants the narrow option only to two literal
`rev-parse` reads and one literal streaming `ls-tree` read; command/shape
classification still precedes the bypass, so destructive operations remain
blocked. Focused Cartographer and guard validation passed 56/56, with typecheck
and diff checks also green. The reviewer identified one limitation: the live
regression relied on `process.cwd()` remaining guard-recognized without asserting
that precondition. The test now explicitly asserts `isInstarSourceTree(cwd) ===
true` before exercising the read, closing that ambiguity.

## Evidence pointers

- Live v1.3.1115 root: verified topic-bound checkout at revision `cb6f8fd07941a566178eb630b1de0fca66eb998f`, `paidAuthoringAllowed: true`.
- Live pre-fix population: 2,142 scaffolded nodes, detect refused/degraded because protected-source Git reads lacked the narrow opt-in.
- Red test: two failures before the code change — catch-all call-site wiring and a real protected-checkout `SourceTreeGuardError`.
- Green test: `tests/unit/cartographer-ls-tree-stream.test.ts`, 9/9 after the three call-site declarations.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller change — not applicable.
