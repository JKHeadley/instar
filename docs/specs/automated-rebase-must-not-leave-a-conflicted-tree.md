---
title: "Automated rebase must not leave a conflicted tree — a swallow that is non-fatal to the caller can still be fatal to the repository"
slug: automated-rebase-must-not-leave-a-conflicted-tree
author: "echo"
parent-principle: "Bounded Blast Radius (an operation that fails must not leave the substrate in a state the next operation cannot enter)"
sibling-principles: "Structure > Willpower (the post-condition must be asserted, not remembered by the next author); Verify at the Consumer (the produces/repairs loop this spec was proposed to fix is refuted at the consumer — see §2); Signal vs Authority (the fix restores state, it never resolves a conflict on the author's behalf); Report the State I Can Evidence (a rebase strategy that returns 'conflicts' must say WHICH cleanup verb applies)"
eli16-overview: automated-rebase-must-not-leave-a-conflicted-tree.eli16.md
source-proposal: "EVO-019 (approved 2026-08-26) — scope note: item 1 is built as specified; item 2 (shared helper) is DEFERRED with reasons in §5; item 3 (ancestry precondition) is DEFERRED with item 2"
status: draft
review-convergence: pending
approved: false
depends-on: "SafeGitExecutor (src/core/SafeGitExecutor.ts:73 — already the single funnel and already lists 'rebase'); SyncOrchestrator.gitExecSafe (src/core/SyncOrchestrator.ts, the callsite's executor); BranchManager.git + MergeResult (src/core/BranchManager.ts); tests/unit/no-empty-catch-blocks.test.ts (the existing guard that passes this code — see §4)"
---

# Automated rebase must not leave a conflicted tree

## 0. One-paragraph summary

Three shipped callsites run `git rebase` inside a `catch` that swallows the
failure and returns. A conflicting rebase does not abort itself, so the swallow
does not end the operation — it ends the *reporting* of the operation and leaves
the repository sitting in a conflicted rebase for whoever arrives next. GitSync
already learned this from production and carries the remedy in two places; its
siblings do not. This spec adds an abort on the failure path at the two callsites
where nothing consumes the conflict, and — at the third, where conflicts *are*
consumed by tiered resolution — adds the one field that tells the resolver which
cleanup verb applies instead of aborting the resolution surface out from under
it. It changes no success path.

## 1. What is actually in the tree (read 2026-08-27)

| site | code | on failure |
|---|---|---|
| `src/core/GitSync.ts:268-311` | preflight: detects `rebase in progress`, runs `rebase --abort`, sets `rebaseJustAborted` | recovers |
| `src/core/GitSync.ts:314-320` | `pull --no-rebase` when `rebaseJustAborted` | avoids recreating the conflict |
| `src/core/GitSync.ts:408-432` | aborts, retries pull in merge mode | recovers |
| `src/core/SyncOrchestrator.ts:550-556` | `rebase main` in `try` / `catch { /* comment */ }` | **leaves rebase in progress** |
| `src/core/BranchManager.ts:246-251` | `rebase origin/<base>` in `try` / `catch { /* comment */ }` | **leaves rebase in progress** |
| `src/core/BranchManager.ts:428-437` | `rebase <branch>` under `mergeStrategy: 'rebase'` | returns conflicts; **leaves rebase in progress** |

GitSync's two comments state the reason in the tree: *"use merge instead of
rebase if we just aborted a stuck rebase, to avoid recreating the same
conflict"* (`:314`) and *"Use merge (not rebase) to avoid recreating the same
stuck rebase"* (`:423`). That is LRN-013's remedy, reached independently from
production failures.

The distinguishing property is not that the siblings ignore the error. It is
that **`git rebase` is the one verb here whose failure is a persistent state
change.** `git merge` leaves a conflicted worktree the caller can see in
`git status`; a failed `git rebase` additionally leaves a sequencer directory
and, typically, a detached HEAD, so the *next* operation on that repository —
including a `checkout` by an unrelated caller — fails or silently operates
somewhere the caller did not intend. Swallowing is safe for verbs whose failure
is a no-op. It is not safe for this one.

## 2. The premise correction this spec makes to its own proposal

EVO-019 proposed that `SyncOrchestrator` is "very likely the upstream producer
of the stuck-rebase state GitSync.ts:268 exists to clean up", and honestly
flagged that as inferred from code shape, naming the confirming measurement:
grep runtime logs for `[GitSync] Pre-flight: stuck rebase detected` and check
whether occurrences follow sync cycles. That measurement was run before this
spec was written, and it refutes the inference:

- `logs/server.log` (1.4 MB, current window): **0** occurrences of
  `stuck rebase`, **0** of `[GitSync]`, **0** of `SyncOrchestrator`.
- Wiring, checked rather than assumed: across `src/`, `SyncOrchestrator` appears
  only as a re-export from `src/index.ts:255-259`. **No production code
  constructs it.** `new SyncOrchestrator(` and `new BranchManager(` appear only
  under `tests/`. `GitSyncManager`, by contrast, is constructed at three real
  callsites (`init.ts:529`, `machine.ts:961`, `server.ts:5236`).

So the loop is real as a *code* relationship and absent as a *runtime* one on
this agent: the repairing half runs, the producing half does not. Two consequences
this spec adopts:

1. **Impact is re-graded from high to medium.** These are latent defects in code
   shipped on the public API surface (`src/index.ts` exports `SyncOrchestrator`
   and its config types), not the cause of an active incident. A consumer that
   constructs the orchestrator gets the defect; nobody on this agent does today.
2. **Fix 1 does not wait on the measurement**, exactly as EVO-019 said. It is
   correct independent of who calls it, and it gets cheaper to make now than
   after a consumer exists.

Recording this because the proposal's own framing — "one module manufactures the
condition, another repairs it, and neither knows about the other" — would have
been carried into the spec as established fact. It is not established. It is a
plausible reading of two files that share no runtime.

## 3. Design

### 3.1 Abort on the failure path where nothing consumes the conflict

`SyncOrchestrator.ts:550-556` and `BranchManager.ts:246-251` are both *cleanup*
rebases: the caller wants the branch freshened, and on failure proceeds without
it. Neither returns the conflict to anyone. At both sites the catch becomes:

```ts
} catch {
  // A conflicting rebase does not abort itself — leaving it in progress makes
  // the next checkout by any caller fail. Restore the pre-rebase state; the
  // freshen was best-effort and its failure stays non-fatal to this cycle.
  try { this.gitExecSafe(['rebase', '--abort']); } catch { /* @silent-fallback-ok — abort of a non-existent rebase is itself a no-op */ }
}
```

The inner swallow is genuinely safe and is annotated as such: `rebase --abort`
against a repository with no rebase in progress exits non-zero and changes
nothing, which is the state the outer catch wanted anyway.

`BranchManager` uses `this.git(...)`; `SyncOrchestrator` uses
`this.gitExecSafe(...)`. Both already funnel to `SafeGitExecutor`, so the abort
inherits the audit trail with no new plumbing.

### 3.2 The third callsite is different, and must not get the same fix

`BranchManager.performMerge` (`:428-437`) returns `{ success: false, conflicts }`
to `completeBranch`, which deliberately **leaves the tree conflicted** —
`:255-259`, "Conflicts detected — leave branch intact for tiered resolution".
The conflicted state is the product, not the accident. Aborting there would
delete the surface the resolver is about to work on.

What is wrong at that site is narrower: `MergeResult` says *that* there are
conflicts and never says *how the tree got that way*, so a resolver that
finishes cannot know whether to finalize with `git rebase --continue` or
`git merge --continue`, nor whether to clean up with `rebase --abort` or
`merge --abort`. The fix is one additive field:

```ts
export interface MergeResult {
  success: boolean;
  conflicts: string[];
  error?: string;
  /** Which operation left the tree conflicted — selects the resolver's
   *  continue/abort verb. Absent on success. */
  conflictState?: 'merge' | 'rebase';
}
```

Set from `this.mergeStrategy` on the failure branch. Additive and optional, so
every existing consumer and every existing test stays valid.

### 3.3 What this deliberately does not do

- **It does not resolve conflicts.** Both changes restore or describe state.
- **It does not change any success path.** No behavioural change when the rebase
  succeeds, which is the overwhelmingly common case.
- **It does not touch GitSync.** GitSync already carries the remedy; changing
  a live, production-wired module to serve a symmetry argument is risk without
  a defect.
- **It does not add a `--no-rebase` retry** at the two cleanup sites. GitSync
  retries because its pull is *required*; these freshens are best-effort and a
  retry would spend a second conflict-prone operation on work the caller has
  already agreed to skip.

## 4. Why the existing guard does not catch this

`tests/unit/no-empty-catch-blocks.test.ts` exists precisely to stop silent
swallows, and it **passes on all three callsites** — its rule is that a catch
must have any non-empty body, and "a single comment counts" (test header,
line 32). Each of these catches carries a comment. The guard asked "did you
think about why?" and got a written answer; the answer is just wrong.
`// Rebase conflict on task branch — non-fatal for periodic sync` is true about
the sync and false about the repository.

That is the argument for a **post-condition**, not a stricter catch lint: a lint
over catch bodies cannot tell a correct rationale from a confident one. The new
guard asserts the outcome instead (§6, tier 2).

## 5. Deferred from EVO-019, with reasons

- **Item 2, lift the merge-instead-of-rebase decision into a shared helper.**
  Deferred. The anti-duplication argument assumes three peer consumers; §2 shows
  one production consumer and two that are constructed only by tests. An
  abstraction extracted to serve two unwired callers is speculative
  generalization, and the helper's interesting behaviour (retry in merge mode)
  is explicitly *not* wanted at those two sites (§3.3). Revisit when a second
  production consumer exists.
- **Item 3, guard on `git merge-base --is-ancestor`.** Deferred with item 2 — it
  is the precondition that helper would own. Recording the shape now so it is
  not re-derived: the machine-checkable form of LRN-013's "unmerged base" is
  `git merge-base --is-ancestor <base> <target>` returning non-zero.

Deferring rather than dropping: both remain correct, and both cost more to
build well than fix 1 costs to build at all. Fix 1 does not depend on either.

## 6. Test plan (Testing Integrity Standard — all three tiers)

**Tier 1 — unit.** In `tests/unit/sync-orchestrator.test.ts` and
`tests/unit/branch-manager.test.ts`, over a real temp git repo:
1. Construct a genuine rebase conflict (two branches editing the same line),
   drive the cleanup path, assert the call returns AND
   `git status --porcelain=v2 --branch` reports no rebase in progress and HEAD
   is attached to the expected branch.
2. Assert the success path is byte-identical to today (no abort issued when the
   rebase succeeds) — spy on the executor and assert `rebase --abort` was never
   called.
3. Assert `conflictState: 'rebase'` on a failed `performMerge` under the rebase
   strategy, `'merge'` under `no-ff`, and absent on success.

**Tier 2 — the post-condition guard (this is the structural piece).** A test
that, for every `git rebase` invocation in `src/`, requires the enclosing
failure path to issue `rebase --abort` **or** carry an explicit
`@rebase-state-consumed` annotation naming the consumer that owns the conflicted
tree (`BranchManager.performMerge` is the sole current holder of that
annotation). Baselined at the three known sites, ratcheted like
`no-empty-catch-blocks.test.ts`, so a fourth callsite cannot be added silently.

**Tier 3 — E2E.** Drive `SyncOrchestrator.sync()` end to end against a temp repo
whose task branch conflicts with main; assert the cycle completes, reports
success for the phases that did succeed, and leaves a repository a subsequent
`git checkout` can enter.

## 7. Rollback

One revert. Both changes are additive on failure paths only; the `conflictState`
field is optional, so reverting it cannot break a consumer that was reading it
(there are none at merge time). No config flag, no migration, no dark-ship
ladder — a state-restoring fix that only runs where the tree is already broken
has no posture to be wrong about.

## 8. Live example to verify against

After the change, in a scratch repo:

```
git checkout -b task && echo a > f && git commit -am a
git checkout main && echo b > f && git commit -am b
# drive the orchestrator's sync cycle
git status --porcelain=v2 --branch   # must NOT contain a rebase-in-progress marker
git checkout main                    # must succeed
```

Before the change, the final `checkout` fails.
