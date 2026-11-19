# Side-Effects Review — source-tree guard: runtime-state shortcut scoped to the checkout's own `.instar/` (watch-only)

**Version / slug:** `guard-runtime-state-scope`
**Date:** `2026-11-19`
**Author:** `echo (machine stewardship, topic 144503)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

This change implements spec `docs/specs/guard-runtime-state-scope.md` in `report` (watch-only) mode. The spec was approved by the Chief of Staff (msg 30c7f163) at the round cap. It is not converged; see the spec's `review-convergence` note.

`SafeFsExecutor.guard()` keeps executing today's verdict unchanged. The new policy is evaluated alongside it, inside a catch, and records each difference in an append-only, never-rolled ledger (`.instar/state/guard-scope-diff.jsonl`) with an `incomplete` marker at a 50 MB cap.

The policy has three parts:
- the runtime-state shortcut matches only the enclosing checkout's own `.instar/`;
- the protection walks every enclosing checkout;
- named scopes cover the three callers that rely on the hole.

**New files:**
- `src/core/guardRuntimeScope.ts`: the policy, the ancestor classifier, the scopes and the mode;
- `src/core/guardScopeLedger.ts`: the ledger, dispositions and the reviewed reset;
- `src/core/guardRefusalDegradation.ts`;
- `src/server/sourceTreeGuardScopeRoutes.ts`: `GET /source-tree-guard/scope`, read-only, with `?scope=pool`;
- an awareness entry.

**Changed:**
- `SafeFsExecutor.ts` and `SourceTreeGuard.ts`, whose evidence readers now keep their read errors;
- the callers: the confinement canary, `InstarWorktreeManager`, `GitSync`, skill-learning `Retirer` and `CommitProtocol`;
- config default and types;
- server wiring, `CapabilityIndex` and `FileClassifier`;
- the state-coherence registry;
- `tests/vitest-setup.ts`, which points the ledger at a temp folder in tests.

## Decision-point inventory

- `SafeFsExecutor.guard` destructive-op verdict — **pass-through in `report`** (today's verdict executes unchanged), **modify in `enforce`** (not switched on by this change).
- Named scopes (canary, worktree stale-lock removal, half-made `node_modules` clean-up) — **add**. They are effective only in `enforce`; in `report` they only shape the recorded shadow verdict.
- `safety.sourceTreeGuard.runtimeStateScope` mode switch — **add**, default `report`. `enforce` is the Chief of Staff's decision and needs the floor in spec §4 (14 days, no incomplete marker, every distinct difference dispositioned, spec B merged).

## 1. Over-block

None in `report`: the executed verdict is today's, so nothing newly refused.

What `enforce` would over-block is exactly what the ledger exists to find, before anything is refused. Measured on the Studio (1,739 shortcut rows), only the three named callers relied on the hole.

`nukeAgent`'s whole-home delete has no allowance here. That is why `enforce` is gated on spec B (`nuke-teardown-narrowing`, approved, being built), which adds `nukeAgentHomeScope`.

## 2. Under-block

In `report` the hole stays as open as today; this is the time-limited exposure the Chief of Staff accepted, with the enforce decision due by 2026-12-17.

In `enforce`, recursive removes are judged by their top-level entry (spec non-goal). A recursive delete of an allowed `.instar/` subtree that holds a symlink into source is not followed, as today.

## 3. Level-of-abstraction fit

Right layer. The hole lives in `SafeFsExecutor`'s carve-out, the single funnel for destructive fs operations, so the fix is there and not in each caller. The named scopes are declared at the funnel, not by the callers.

## 4. Signal vs authority compliance

In `report` the new policy is a pure signal: it records and never blocks. The executed authority is unchanged.

`enforce` would give the new rule authority. It is deterministic by design, and the spec classifies the verdict as invariant (irreversible consequence) over an enumerable scope list. The move to authority is gated by the Chief of Staff with the ledger in hand.

## 4b. Judgment-point check (Judgment Within Floors standard)

**report vs enforce** is the judgment point:
- **Floor:** `report` executes today's verdict and records every difference durably.
- **Arbiter:** the Chief of Staff.
- **Fallback:** setting the key back to `report` restores today's behaviour at once.

## 5. Interactions

- **Shadow evaluation in the guard's path.** Any exception, timeout or ledger failure becomes a `shadow-error` row and never changes the verdict. The extra cost is one ancestor walk per guarded call, plus `git ls-files` only for scope-shaped paths and once per new would-deny row (deduplicated per day).
- **Builder deviations from the spec** (the second pass found that item 2 ran before the per-day dedup; fixed, see the second-pass section):
  1. The staging scope's root check reads `.git` worktree records directly rather than `git worktree list`, which is not on SafeGitExecutor's allowed read list. The security list was not widened.
  2. The extra `git ls-files` per new would-deny row, used to classify `source-file`, goes beyond the literal "scope-shaped only" rule. The rows are rare and deduplicated per day.
  3. The route reads the ledger as a stream, because it can reach 50 MB.
  4. `_cloneNodeModulesForTesting` is exported as a test seam.
- **Test isolation:** `tests/vitest-setup.ts` points the ledger at a temp folder so test runs never write the real ledger.

## 6. External surfaces

- **New route:** `GET /source-tree-guard/scope`, read-only and authenticated.
- **New awareness entry.**
- **New durable files:** `guard-scope-diff.jsonl` and `guard-scope-dispositions.jsonl` under `.instar/state/`.

No change visible to users or other agents in `report`.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The route lists undispositioned rows and each machine's mode, so a mixed fleet state is visible. There is no new operator notice: nothing is refused in `report`.

## 7. Multi-machine posture (Cross-Machine Coherence)

`machine-local-justification: hardware-bound-resource`. Each machine's guard protects its own disk, and the ledger is per machine. `?scope=pool` shows every machine's mode and counts.

## 8. Rollback cost

Low:
- revert the PR, or leave the default `report`, which already executes today's verdict;
- the ledger files are inert JSONL and can be left or archived;
- no migration and no data repair.

## Conclusion

The change is safe to ship in `report` mode: it changes no verdict, it records the evidence the enforce decision needs, and it is reversible by revert.

## Second-pass review (if required)

Required (guard). Concern raised, fixed, then concurred; details below.

## Evidence pointers

- **Unit tests:** 4 new files, 72 tests. They run from a temp home whose path contains `/.instar/`, and include a concurrent-writer test (6 processes × 150 rows) and a cap race.
- **Existing related tests:** about 470, passing.
- **Integration:** `tests/integration/guard-runtime-scope.test.ts`, re-run after the async edit (result in the commit).
- **Checks:** tsc and 54 lint steps clean.

## Class-Closure Declaration (display-only mirror)

The class-closure line is written into the trace at commit time.

### Second-pass result (2026-11-19 03:00 PT)

**First pass: concern raised.** The reviewer found three problems:
1. The target classification and a synchronous `git ls-files` ran before the per-day dedup, so every repeated would-deny paid a git spawn in the hot path.
2. Child processes and the CLI resolved the ledger to `process.cwd()/.instar/state`.
3. An unreadable `incomplete` marker counted as complete, which leaned toward allowing `enforce`.

**Fixes:**
1. `recordDiff` checks seen-today first. Classification runs only for a new fingerprint. Test: 1,000 repeats produce one `ls-files` call.
2. `guardScopeStateDir()` resolves in this order: the test override, the boot stateDir, `INSTAR_AGENT_HOME` (if its `.instar` exists), and the cwd only if it holds `.instar/config.json`. Otherwise it returns null and nothing is written.
3. Only ENOENT/ENOTDIR counts as complete.

**After the fixes:** new unit files 71/71, SafeFsExecutor + trash + SourceTreeGuard 80/80, integration 2/2.

**Second pass: Concur with the review.** In report mode the executed verdict is still the old one, and every failure in the shadow path is caught. What remains on each call is one synchronous ancestor walk, plus `ls-files` only for scope-shaped paths, which are rare and allowed by the spec.
