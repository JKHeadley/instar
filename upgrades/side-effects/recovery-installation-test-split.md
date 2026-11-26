# Side-Effects Review — Recovery installation test split

**Version / slug:** `recovery-installation-test-split`
**Date:** 2026-11-23
**Author:** Instar Agent (echo), delegated helper patch_guard_act 501
**Second-pass reviewer:** /root/main_search_failure_review; final digest binding requested separately.

## Summary of the change

Tier 1, small and reversible: move unchanged recovery installation cases into a second integration file. Preserve all seventeen cases, the three-row identity table, fresh per-case setup, real runtime building and native qualification. Duplicate the original fixture preamble intentionally to preserve file-local hoisted mocks. No production source or verifier configuration changes. One independent source review found no blocking concerns. Executed collection preserved all seventeen case identities. The sole focused run passed seventeen tests with zero skips and zero unhandled errors; no whole-gate performance claim is made.

## Decision-point inventory

No production decision point is changed. Recovery admission, service ownership, rollback and uninstall assertions are passed through unchanged. The existing test-discovery include finds both files.

## 1. Over-block

No block/allow surface — over-block not applicable. No test is skipped or disabled.

## 2. Under-block

No block/allow surface — under-block not applicable. All original test bodies remain byte-identical. Additional regression coverage is not claimed.

## 3. Level-of-abstraction fit

This is a file organization change at the integration-test layer. It uses existing verifier scheduling and does not create a separate scheduler or authority.

## 4. Signal vs authority compliance

This change has no block/allow surface. It complies with [signal versus authority](../../docs/signal-vs-authority.md): it adds no detector or blocking decision.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Historical case timings inform the partition; they do not control runtime admission or override a verifier verdict.

## 5. Interactions

Shadowing: no route, hook or production import is changed. Double-fire: static and executed collection must show every original case exactly once. Races: both files retain independent hoisted mocks, module keys, fresh per-case directories and cleanup. No same-file test concurrency is added. Feedback loops: no new loop is introduced. Duplicated fixture setup can drift in future edits; the paired comments identify the requirement to keep it identical.

## 6. External surfaces

No external surface changes. No user messages, APIs, URLs, live databases, configuration or migration are added. Temporary fixture directories remain owned by their individual cases. Focused tests may build ignored dist outputs through the existing global setup.

## 6b. Operator-surface quality

No operator surface — not applicable. No operator-facing actions are added.

## 7. Multi-machine posture

Machine-local BY DESIGN: test processes and their temporary fixtures belong to the verification host. The committed test layout is portable through normal source checkout; no fixture state needs replication. No user-facing notices, durable agent state, URLs, status, health, capabilities or channels answers are changed.

## 8. Rollback cost

Restore the original test file and remove the added file. No data migration, agent repair, release behavior or user-visible recovery behavior is affected.

## Cold duration-history caveat

The parent ran the production first-part selector offline against saved host duration history. The original filename was charged 821.863 seconds, while the new filename had no history and was charged the default ten seconds. With first-part selection enabled, the new file was selected before parallel rest lanes started. When both historical case sums were supplied only to the offline projection, neither file was selected. No live history or selection policy was edited. The first complete gate may therefore be slower on cold history; focused file timings cannot establish a full-gate improvement. The projection is saved in build-state saved-profile/recovery-split-first-part-projection.json.

## Conclusion

Executed collection matched all seventeen baseline identities exactly once. Focused execution exited zero with seventeen passes, zero skips, and zero unhandled errors. The eight-case file took 39.140 seconds and the nine-case file 47.103 seconds (86.243 seconds total file time). The command spent 1658.974 seconds before admission and 92.655 seconds from admission to wrapper completion. No fresh original unsplit baseline was run, so the older historical timings cannot establish a causal improvement. A normal complete exact-head gate is still required before a shipping claim. File-duration sums cannot establish critical-path savings.

## Second-pass review

**Reviewer:** /root/main_search_failure_review

**Independent read of the artifact:** Final digest-bound concurrence is recorded separately after these bytes freeze. The reviewer independently confirmed all fifteen registration blocks, file-local fixture boundaries, all thirteen frozen hashes, and the cold-history selection caveat. No final digest concurrence is claimed within these bytes.

## Evidence pointers

The ignored build-state recovery-split directory holds static-equivalence.json, focused-manifest.json, collection and execution receipts. The static receipt binds every original registration block and fixture prefix to its source hash. Historical analysis lives in the saved-profile build-state directory and is explicitly separated from fresh measurements.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. This changes test organization and does not add a self-triggered controller.
