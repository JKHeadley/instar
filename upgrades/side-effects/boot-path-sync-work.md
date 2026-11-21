# Side-Effects Review — less synchronous work at server start

**Version / slug:** `boot-path-sync-work`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Split out of pull request 3598 (conversation-list freeze, fb-52447f16-7d3) at the operator's request, so that PR covers only the conversation-list, chat-history and message-save paths. Files: `src/core/CartographerTree.ts` (scaffoldChunked writes a node file only when its bytes change; read, compare and write stay in one synchronous turn so `setSummary` cannot be overwritten), `src/commands/setup.ts` (`probeNodeNativeCompat`: async candidate resolution and ABI probes, at most 4 at once, a 10 s deadline that kills and settles; `assembleNodeCandidates` shared by sync and async; `ensureStableNodeSymlink` accepts pre-probed answers and candidates), `src/commands/server.ts` (boot awaits the async probe and passes its answers). Tests: `tests/unit/cartographer-scaffold-incremental.test.ts`, `tests/unit/node-symlink-async-probe.test.ts`. Tier 1.

## Decision-point inventory

No decision point is added or changed; the same node is selected from the same probe answers.

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable.

## 3. Level-of-abstraction fit

The probe runs where the symlink step runs; the scaffold change is inside the existing yielding scaffold.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Probe concurrency 4 and the 10 s deadline (the existing per-probe timeout) are resource brakes.

## 5. Interactions

The lifeline and `instar setup` call `ensureStableNodeSymlink` without pre-probed answers and probe synchronously as before. A path the async probe did not answer is probed synchronously. Known limit: a node binary replaced on disk between the async probe and selection is judged by the earlier answer; the next boot re-probes.

## 6. External surfaces

None beyond the local machine: fewer node-file writes at boot, child processes run in the background.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the node symlink and the Cartographer files are per-machine files; nothing replicated, no notices, no URLs.

## 8. Rollback cost

Pure code change; revert and ship a patch.

## Conclusion

Clear to ship as a small, reversible boot-path improvement, reviewed separately from 3598.

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action`: n/a. The node probe is a one-shot boot step over a bounded candidate list, not a self-triggered loop.
