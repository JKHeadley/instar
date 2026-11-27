# Side-Effects Review — the ladder calls a read cut only when rows were dropped; child flags read their parent switch

**Version / slug:** `ladder-evidence-cut-only-when-dropped`
**Date:** `2026-11-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1 (small, read-only, fully reverted by a revert). Five files plus docs: `src/monitoring/LadderEvidenceReader.ts`, `src/monitoring/MaturationLadder.ts`, `src/data/feature-ladders.json`, and two unit test files. About 115 lines.

1. `segmentsOf()` now reports `dropped`. For a file in `SEGMENT_NUMBERED_FILES`, it is true when a `.gz` segment exists or the lowest kept numbered segment is above 1. The set currently holds only `logs/feature-evidence.jsonl`, written by `FeatureEvidenceLog` through `maybeRotateJsonlSegment`; 535 of the registry's jsonl metrics read it. That writer numbers segments monotonically from 1 and unlinks those at or below `nextSeq - keepSegments`, so for it a missing segment 1 is exact proof of dropped rows, for any keep limit. For every other file the old rule stands: any segment means rows may be gone. Several other writers use a shift scheme where `.1` is always the newest segment: `LocalVerifyService`, `ClaimObservation`, `peerDark`, `OverloadShedPlanner`, the resume queue and `foldShadowLog` (found by the second pass). `finish()` calls a read cut only when `dropped` holds and the oldest row is newer than the window start. A young shared log (nothing dropped, oldest row inside the window) returns its numbers and carries `coverageDays`. Before, `coverageDays` was carried only on a cut read; the field is display-only. A ratchet test pins the set's contents and that `FeatureEvidenceLog` still calls `maybeRotateJsonlSegment` on that file.
2. Ladder flags gain an optional `requires: <parent path>`. `readFlag` returns not-on when the parent's `enabled` (object or bare boolean, through the same `resolveDevAgentGate` used for live config, and plain `=== true` for shipped defaults) is off. The registry sets it on `monitoring.growthAnalyst.darkFlagInventory` and `monitoring.growthAnalyst.blockedDigestEscalation`. Both are constructed in AgentServer only when the growth analyst is gate-resolved on. The parser validates the field: a dotted path, and not the flag's own path.

Effort: one review round. The second pass raised one concern (the shift-rotation writers), which was fixed by scoping. There was one commit attempt at the time of writing.

## Decision-point inventory

- `LadderEvidenceReader.finish` "evidence-cut" — modify — narrows when a read is withheld as incomplete.
- `deriveLadderRung` / `readFlag` — modify — a child flag can be read as off because of its parent.
- Ladder state (`collecting` / `ready-to-advance` / needs-attention) — pass-through — consumes the readings. Moves still go through `applyMove` and its existing floors and taps.

---

## 1. Over-block

The change narrows a withholding rule. Fewer metrics are withheld, so over-block falls. One residual remains: a log that rotated through the older read-filter-rewrite `maybeRotateJsonl` would never have segments, so it is not affected either way. Old behavior is unchanged for it.

## 2. Under-block

- Other segment-numbered logs (for example `swap-ledger.jsonl` via `SwapLedger`) stay on the old, careful rule until their writer is verified and added to the set. They over-withhold exactly as before, which is the safe direction.
- If something other than the writer deletes segment 1 while leaving segment 2 (manual cleanup), `dropped` is true. That is correct, because rows are missing.
- If an operator renamed segments so a gap appears in the middle (1, 3) but 1 remains, the reader would not call it cut. The writer never produces middle gaps, and manual renames of evidence logs are out of model. Accepted.
- `blockedDigestEscalation` also needs `digestDelivery !== 'off'` (the publisher is only built then). `requires` reads a boolean `enabled`, so that string condition is not modelled. The ladder can still call it dry-run or live while the publisher is not built. This is the same as before this change, and the entry is better than it was (the analyst-off case is now right). It is queued to the feedback queue as fb-0a0fd534-1d6 (improvement), not added here.
- A truncated-by-age log (no rotation, rows trimmed in place by `maybeRotateJsonl`) is not detected as cut. This is unchanged from before. `feature-evidence.jsonl` uses segment rotation, so it is not affected.

## 3. Level-of-abstraction fit

The rotation format lives in `jsonl-rotation.ts`, and the reader is the only consumer that judges completeness, so the reader is the right place. Inferring "dropped" from the segment numbers uses the writer's own invariant. It avoids a parallel keep-limit constant that could drift from `FeatureEvidenceLog.KEEP_SEGMENTS`. The inference is scoped by an explicit allowlist of files whose writer is verified, because writers in this repo use two rotation schemes. The parent-switch dependency is declared per entry rather than inferred from path prefixes. 37 registry entries have a dotted parent that is itself a flag, and several of those do not gate on the parent (for example stage-style `multiMachine.sessionPool.stage`), so a blanket rule would mislabel them.

## 4. Signal vs authority compliance

The ladder is a signal surface: it reports rungs, readings and readiness. Advancing a feature goes through `applyMove`, with its own floors and the operator or agent decision. This change holds no blocking authority. It makes the signal more accurate in both directions: real harm numbers appear, and a child whose parent is off stops looking ready.

## 4b. Judgment-point check

There is no competing-signals heuristic. "Was segment 1 deleted" and "is the parent switch on" are facts, not judgments.

## 5. Interactions

- With real numbers, at-most harm bars can now pass on a young log where before they read null and could not pass. That is the intended behavior of an honest read: for the shared log, every row ever written in the window is counted. Files written by other rotation schemes keep the old withholding, so they cannot falsely pass. Equally, failing harm bars now surface (the six regressions named in CMT-2215). The blocker-lifecycle "ready features" summary and D7 contract evaluation read the same readings, so their counts will shift, which is the point.
- `minSamples` still applies, so a very young log with few rows stays `collecting`.
- D7 soak: changed readings may start or restart soaks. The soak logic is unchanged.
- No interaction with the writer: the reader is read-only.

## 6. External surfaces

`GET /maturation/ladder` shows numbers where it showed `reason: "evidence-cut"`, and shows `coverageDays` on young-log readings. The board and the Needs-you list reflect the new states. Nothing else is visible to other agents.

## 6b. Operator-surface quality

No dashboard or approval file is touched. Not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design, as before: each machine reads its own `logs/feature-evidence.jsonl` and its own config, and the route already labels the machine. This change adds no state, no notices and no URLs.

**Status surfaces:** `GET /maturation/ladder` only (existing route, same shape, one optional field now appears more often).

## 8. Rollback cost

Revert the commit and ship a patch. There is no state, migration or config to repair. `requires` in the registry is ignored by older code (the parser copies the flag object, and older readers ignore unknown keys), so a partial rollback is also safe.

## Conclusion

Ship. It narrows an over-broad withholding rule to the exact case it exists for, using the writer's own numbering invariant. It also fixes a mislabeled rung for two child features via an explicit, validated declaration.

## Second-pass review (if required)

**Reviewer:** independent general-purpose subagent (fresh context, given the diff and the code, not this conclusion)
**Independent read of the artifact:** concern, then resolved.

Concern raised: "lowest kept seq > 1 means dropped" holds only for `maybeRotateJsonlSegment`. `LocalVerifyService.ts:6530`, `ClaimObservation.ts:609`, `peerDark.ts:307`, `OverloadShedPlanner.ts:579`, `server.ts:13146` (resume queue) and `foldShadowLog.ts:48` shift-rotate, so `.1` always exists and is the newest. These logs feed at-most harm bars (peerDarkNotice, resumeQueue, fold shadow, local-verify slices), which could then falsely pass. The reviewer confirmed the `requires` branch is correct and that no consumer treats `coverageDays` as cut.

Resolution: the young-log inference is now limited to `SEGMENT_NUMBERED_FILES` (the shared log only). Every other file keeps the old rule. A test covers a shift-scheme `.1` staying cut, and a ratchet pins the set and its writer.

Re-check after the fix: **Concur with the review.** The reviewer confirmed that all 535 shared-log metrics key on exactly `logs/feature-evidence.jsonl`, that it has one writer (`FeatureEvidenceLog.ts:110`, keep 8), and that other files keep the old rule. The remaining false-pass routes (every segment deleted by hand; logs trimmed in place by `maybeRotateJsonl`) exist equally on main and are not introduced here.

## Evidence pointers

- Studio `GET /maturation/ladder` on 2026-11-27: 196 `evidence-cut` metrics. The `darkFlagInventory` error-rate showed `evidence-cut` with `coverageDays: 7.4` on a log holding only segment 1.
- `tests/unit/LadderEvidenceReader.test.ts`: rotated-once (numbers returned), keep-limit (cut), `.gz` (cut), dropped-but-covered (not cut), shift-scheme `.1` on another file (cut), and the writer ratchet. The rotated-once test fails on the old code.
- `tests/unit/MaturationLadder.test.ts`: the `requires` block. Five of its tests fail on the old code.
- 17 neighbouring test files, 540 tests, all pass.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect: the root defect is in TypeScript reader logic, and the registry field is a new declaration capability. Not applicable.
