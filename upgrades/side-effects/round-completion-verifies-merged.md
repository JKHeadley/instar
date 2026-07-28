# Side-effects review — round completion verifies merged state

**Change:** `runRound`'s `verifyMergedItems` seam no longer defaults to a no-op that reports nothing
verified. It defaults to the real git-backed `verifyMergedItemsViaGit`, the seam carries the
three-state `MergedVerificationResult`, and a new `unverifiable` outcome records **no** round status.

**Decision point touched:** yes — two of them. (a) whether a round is complete; (b) whether to spawn
an autonomous child. Both previously ran on a verifier that could only ever say "nothing verified".

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

The one real risk is stalling a round that should proceed. `verifyMergedItemsViaGit` reports
`unverifiable` for an item with **no `mergeCommitOid`**, which is the ordinary state of a round nobody
has worked yet. A naive "any unverifiable ⇒ don't spawn" would deadlock **every fresh round** — a far
worse defect than the one being fixed.

Handled by splitting on **evidence**: only an item that *records* a merge commit and cannot be checked
counts as genuinely uncheckable. An item with no recorded commit is not-done, and the child spawns.
Pinned by `an item with NO merge commit recorded is NOT-DONE, not unknown — the child still spawns`.

This test earned its place: the first draft applied the evidence rule at the pre-spawn check only,
and the post-exit check kept the old conflation. The test failed, and the predicate is now defined
once and used at both sites.

## 2. Under-block — what does it still miss?

- **CI-green is still not checked.** Verification remains merge-base reachability of a recorded
  commit. An item merged with red CI verifies. Unchanged by this PR; `StageTransitionValidator`
  performs the stronger check on the `/advance` path.
- **No scheduling.** Nothing here makes rounds run; it makes a run able to conclude.
- **`resolveCanonicalMainRef` is best-effort.** If `gh` is absent it falls back to `origin/main`,
  which on a fork-origin home under-verifies (items read as regressed → a spawn, i.e. redoing work).
  That is the pre-existing conservative default, now applied to this path too rather than left to a
  caller to remember.

## 3. Level-of-abstraction fit

`resolveCanonicalMainRef` moved from `src/server/routes.ts` into `src/core/ProjectRoundExecution.ts`
and is imported back. Both consumers — the lazy reconciler and this runner — need identical
resolution, and a core module must not import from `server/`. Net: one definition, two callers,
correct direction. The two source-grep tests in `merged-record-carries-its-evidence.test.ts` assert
the *call* in `routes.ts`, not the definition, and still pass.

## 4. Signal vs authority

The verifier stays a **signal** — it reports three states and holds no blocking authority. `runRound`
is the authority and now consumes all three rather than flattening them. The specific improvement:
the authority can no longer be handed a value ("empty set") that is indistinguishable from a real
negative reading. Per `docs/signal-vs-authority.md`, the failure was not a brittle check holding
authority; it was an authority whose input could not express uncertainty.

## 5. Interactions

- **`/projects/:id/advance`** — untouched. Item-level stage transitions still go through
  `StageTransitionValidator`; this only affects round-level outcome.
- **`ProjectAutoAdvancePoller`** — unchanged; it clears `autoAdvanceAt` and counts unacked advances.
  It now sees rounds that can actually reach `complete`.
- **`ProjectDigestCache`** — unchanged, and this is the visible effect: the session-start
  `N of M done` line can move off zero for the first time via the poller path.
- **Double-fire / races** — none added. `unverifiable` performs strictly *fewer* writes than any
  other outcome (it writes nothing), so it cannot race the tracker's OCC.

## 6. External surfaces

`RoundOutcome` gains `'unverifiable'` — a TypeScript-level addition on an exported union. In-repo
consumers are `ProjectRoundExecution` itself and the tests; `recordOutcome` maps
`Exclude<RoundOutcome,'unverifiable'>` so the compiler enforces the exhaustiveness rather than a
runtime default swallowing it. No route, no config key, no user-visible string.

## 7. Multi-machine posture

**Machine-local BY DESIGN**, `machine-local-justification: hardware-bound-resource` — the check runs
`git merge-base` against a working checkout on local disk, and the round runner already holds a
host-local `ProjectRoundLock` (`.instar/local/round-runner.lock`). Round execution is bound to the
machine holding the checkout; nothing here introduces state another machine would need to read. No
notice, no durable cross-machine record, no generated URL.

## 8. Rollback cost

Low and local. One file's behavior plus a moved helper; no data migration, no config, no persisted
schema. Reverting restores the prior behavior exactly — including the defect. A round left in
`pending` by an `unverifiable` outcome is a normal pending round; nothing to repair.

## Refusals demonstrated (command + output)

Falsification 1 — neutralise the evidence predicate (`ids.filter(() => false && …)`):

```
× an item that RECORDS a merge commit but cannot be checked → no respawn, and NO round verdict
× child exits 0 but the shortfall is entirely uncheckable → unverifiable, NOT partially-complete
  Tests  2 failed | 8 passed (10)
```

Falsification 2 — re-introduce a default returning an unconditional empty verdict:

```
× the seam cannot default to silence again > has no default verifier that returns an unconditional empty set
  Tests  1 failed | 9 passed (10)
```

Restored: `Tests 36 passed (36)` across the four affected files, `tsc --noEmit` exit 0.

Falsification 3 — **a guard I did not anticipate, which changed the code.** The full suite failed on
`lint-sync-subprocess-chokepoint`:

```
src/core/ProjectRoundExecution.ts:569 — raw sync spawn (execFileSync('gh', …)).
A sync blocking op must funnel through withSyncOp() so the in-flight marker sees it.
lint-sync-subprocess-chokepoint: 1 new violation(s).
```

In `routes.ts` that callsite sat on the lint's **frozen baseline** — grandfathered, not blessed.
Moving it into core made it a NEW violation. The refusal is the useful part: `runRound` is called
from the server's auto-advance poller, so a blocking `gh repo view` there stalls the event loop.
Now funnelled through `withSyncOp` so the in-flight marker classes the stall instead of it
presenting as an unexplained freeze. Lint after: `clean — 97 raw sync spawn(s), all grandfathered
(142 baselined)`.

Worth noting the lint is a deliberately **lexical, same-line** matcher (`/\bwithSyncOp\s*\(/`) and
says so in its own header — it cannot prove runtime wrapping, which is the marker's unit test's job.
My first wrap was semantically correct across three lines and still flagged. That is signal-vs-
authority working as designed: a cheap check that names a hazard, not a proof.

## Known-failing locally, verified NOT caused by this change

`tests/e2e/dev-preflight-cli.test.ts` fails in this worktree. The cause is inside preflight's lint
step, which shells out to `pnpm install`; reproduced standalone:

```
pnpm install → PNPM_EXIT=1
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: baileys, better-sqlite3, esbuild, sharp, …
```

That is a dependency build-script approval issue in a worktree installed with `npm ci`, naming only
third-party packages and reading none of the changed files. Not run to completion deliberately —
`pnpm install` would restructure the `node_modules` the 36 passing tests were validated against. CI
installs the project its own way and is the arbiter; flagged here rather than quietly omitted.
