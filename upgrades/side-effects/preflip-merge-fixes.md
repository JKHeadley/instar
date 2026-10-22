# Side-Effects Review — safe-merge latest-run checks + installed safe-merge for the watcher

**Version / slug:** `preflip-merge-fixes`
**Date:** `2026-10-22`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent, two rounds — concur (see below)`

## Summary of the change

Two fixes found before switching the merge floor to local-verify (spec `docs/specs/local-verify-merge-authority.md`).

**ACT-149.** `scripts/safe-merge.mjs`'s settle loop and its any-red-check refusal read every row of `gh pr checks`, which still lists a failed run that a newer rerun on the same head superseded. GitHub judges a required context by the latest run per check name, so safe-merge refused `refused:red-checks` on PR 2289 while GitHub showed green. The rule "latest run per check name" now lives in one dependency-free module, `scripts/latest-run-per-check.mjs`, used by both safe-merge (`latestCheckRows`, applied inside `classifyChecks`) and the watcher (`src/monitoring/greenPrLogic.ts` `latestRunPerCheck`). The rule: later run time wins (startedAt, else completedAt; ties to the later row); a run with no time that is still open (a queued rerun) wins, so the loop waits. `fetchChecksRows` now requests `startedAt,completedAt`. An empty, non-array or unparseable checks response is read up to two more times (5 s, 10 s) before the existing `refused:contexts-unverifiable`.

**ACT-150.** `src/commands/server.ts` built the watcher with `safeMergePath = <cwd>/scripts/safe-merge.mjs` — the agent-home checkout, which on 2026-10-22 sat on an old branch with 279 uncommitted changes and a pre-local-verify safe-merge. A shared helper `src/core/installedSafeMerge.ts` (`installedSafeMergePath()`, `<package>/scripts/safe-merge.mjs`) now supplies the path through `resolveGreenPrPaths(cwd)` in `greenPrAutomergeWiring.ts`; `repoPath` stays the cwd. `loadSafeMergeFloor` in `src/localVerify/localVerifyWiring.ts` uses the same helper (the change PR #2294 proposes; this branch supersedes or conflicts with it — land one). `isAnalyzableGreenPrRepo` still requires the source checkout: `.git` and `scripts/safe-merge.mjs` in the checkout (now only a marker that this is instar) plus the installed copy. safe-merge's `resolveAgentHome` now derives the home from an installed path (`<home>/.instar/shadow-install/…`) before trying git.

Files: `scripts/safe-merge.mjs`, `scripts/latest-run-per-check.mjs` (+ `.d.mts`), `src/monitoring/greenPrLogic.ts`, `src/monitoring/greenPrAutomergeWiring.ts`, `src/monitoring/MergeRunner.ts` (one read-only getter), `src/core/installedSafeMerge.ts`, `src/localVerify/localVerifyWiring.ts`, `src/commands/server.ts`, tests.

## Decision-point inventory

- `safe-merge classifyChecks` (settle loop + `refused:red-checks`) — modify — judges the latest run per check name instead of every row.
- `safe-merge settle loop checks read` — modify — retries a transient empty/unparseable response twice before `refused:contexts-unverifiable`.
- `greenPrLogic.latestRunPerCheck` — modify — delegates to the shared rule; a queued (untimed, open) rerun now wins over an older timed run (before, gh's `0001-01-01` placeholder parsed as a negative time and lost).
- `server.ts green-PR wiring safeMergePath` — modify — installed copy instead of the cwd copy.
- `isAnalyzableGreenPrRepo` — modify (semantics kept) — checkout `.git` + checkout `scripts/safe-merge.mjs` marker + installed copy.
- `safe-merge resolveAgentHome` — modify — installed-path rule first, git second.
- `loadSafeMergeFloor` — modify — installed copy (same as #2294).
- `PROTECTED_PATH_PREFIXES` — modify — adds `scripts/latest-run-per-check.mjs` and `src/core/installedSafeMerge.ts` (both decide what the merge path runs or judges).

---

## 1. Over-block

The change removes an over-block: a PR whose failed check was superseded by a passing rerun was refused. New over-block risk: an empty checks list is now refused `contexts-unverifiable` after retries; before, an empty list fell through to `refused:e2e-missing-or-red`. Both refuse; only the result code differs, and an open instar PR always has checks. Adding the protected paths routes a PR touching the two new files to the operator instead of auto-merging — intended.

---

## 2. Under-block

- A superseded failure is no longer counted. If GitHub ever counted a superseded failure against a required context, safe-merge would now be more lenient than GitHub; it is not (GitHub uses the latest run per name), and the producer-bound required-contexts cross-check (`fetchCheckRunsWithProducers`, check-runs API with its default latest filter) still runs after this, unchanged.
- Same-named checks in different workflows do NOT collapse (corrected after second-pass review). The first draft grouped by name only, so a passing `e2e` in workflow B hid a failing `e2e` in workflow A — an under-block. GitHub supersedes a run only within one workflow, so the shared rule now groups on workflow + name: safe-merge requests `workflow` from `gh pr checks`, the watcher reads the rollup's `workflowName` (or `checkSuite.workflowRun.workflow.name`). A row with no workflow identity keys on the name alone and never supersedes a row that has one; both are kept, so a red stays red.
- Rows with no times at all collapse within the same workflow + name to the later-listed row — same as the watcher's prior behaviour.

---

## 3. Level-of-abstraction fit

The latest-run rule is a pure primitive shared by the watcher (signal) and safe-merge (act-time authority), so the two cannot drift. The path choice is wiring, now a named, testable function (`resolveGreenPrPaths`) instead of inline server code. The home-resolution rule stays inside safe-merge, where it was.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.
- [x] Deterministic safety guard on an irreversible action (merge), unchanged in kind: safe-merge's refusal is a structural check of GitHub's own check state, and this change makes it read that state the way GitHub does. No new heuristic gains authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. "Latest run per check name" is an enumerable invariant (GitHub's own definition of a required context's state), and safe-merge is a deterministic safety guard on an irreversible action by design.

---

## 5. Interactions

- **Shadowing:** the latest-run filter runs before the any-red refusal and the e2e check; the required-contexts cross-check after it is unchanged and still refuses a missing or red required context.
- **Double-fire:** none; one spawn path.
- **Races:** the merge runner's probe-time import-closure hash now covers the installed safe-merge and its closure, including `latest-run-per-check.mjs`. An auto-update that replaces the installed package between probe and exec changes the hash → the existing refusal (no merge). The installed copy changes far less often than the checkout did.
- **Feedback loops:** none.
- **`loadSafeMergeFloor`'s parameter changed from a repo path to a safe-merge FILE path** (default: the installed copy). Callers are updated: `buildStatusReconciler` calls it with no argument, and `tests/e2e/local-verify-lifecycle.test.ts` passes either nothing or a file path. **PR #2294** makes the same change; the two conflict textually, and this branch's version wins on rebase (#2294's helper is re-exported here under the same name).
- **The checks-read retry stops at the merge deadline:** once `Date.now()` is past it, no further retry or sleep — refuse `contexts-unverifiable` at once.
- **Installed-location home** requires `<home>/.instar/config.json`; without it (a user-level `~/.instar/shadow-install`) resolution falls through to the git rule, so it can never resolve to `~`.

---

## 6. External surfaces

- GitHub: one more pair of JSON fields requested from `gh pr checks`; up to two extra reads only on an empty/garbled answer.
- Other agents / install base: the watcher is repo-gated and off by default; on a plain install nothing is constructed (the checkout marker is still required).
- Persistent state: none added.
- **Operator surface:** no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine's watcher runs the safe-merge from that machine's own install and resolves that machine's agent home; the watcher already runs only on the lease holder. No notices, no durable state, no URLs added.

---

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state. During the rollback window the old behaviour returns (superseded failures refuse; the watcher runs the checkout's safe-merge).

---

## Conclusion

Both fixes are small and close the two pre-flip findings. The review added the checkout-marker requirement to `isAnalyzableGreenPrRepo` so moving the script path does not widen where the watcher runs, and moved the queued-rerun case into the shared rule so the watcher and safe-merge agree on it. Second-pass review found the name-only grouping (blocking), a retry that could outlive the merge deadline, and a too-loose installed-home rule; all three are fixed with tests that fail without them. Clear to ship after operator approval (protected paths). Follow-up: reconcile with PR #2294 (this branch wins on rebase).

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (two rounds)
**Independent read of the artifact: concur (after fixes)**

Round 1 raised (blocking): grouping latest runs by check name alone let a passing same-named job in another workflow hide a failure, including the e2e check; now grouped by workflow + name, and a row with no workflow identity never supersedes one that has it. Also: the checks-read retry could overshoot the deadline (now skipped past it); `installedAgentHome` could resolve a user-level shadow install to `~` (now requires `<home>/.instar/config.json`); the artifact misdescribed the name-only collapse and omitted the `loadSafeMergeFloor` parameter change (corrected). Round 2 verified each fix and concurred.

## Evidence pointers

- `tests/unit/safe-merge-latest-run.test.ts` (27 tests): PR 2289 shape, two workflows with one name and one red (refused), both directions, order independence, running and queued reruns, watcher/safe-merge agreement over the same histories, retry/refusal, installed-location agent home (including a non-git home, which resolved to `…/node_modules/instar` before the fix).
- `tests/unit/green-pr-automerge-wiring.test.ts`: MergeRunner receives `installedSafeMergePath()`; checkout requirement kept.
- `tests/e2e/local-verify-lifecycle.test.ts`: status loop loads the installed safe-merge.
- Targeted: safe-merge-*, merge-runner, green-pr-*, local-verify lifecycle; `npx tsc --noEmit` clean; `npm run lint` exit 0.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (code defects in a merge script and server wiring; no prompt, hook, config, skill or standards text; no self-triggered controller added or modified).
