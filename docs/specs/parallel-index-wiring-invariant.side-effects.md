# Side-Effects Review — ParallelActivityIndex wiring invariant (second construction site)

**Version / slug:** `parallel-index-wiring-invariant`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent)`
**Second-pass reviewer:** `not required (Tier 1, read-only scoring input, no authority)`

## Summary of the change

`ParallelActivityIndex.opts.isRunning` is optional and defaults to `false` (`this.opts.isRunning?.(topicId) ?? false`). There are two construction sites. `AgentServer.ts` supplies one (repaired in PR #1870). `src/commands/server.ts:24682` supplied NONE, so its `activities()` reported `running:false` for every topic — and the `WorkQueueRegistry` `topics` source scores `urgency: a.running ? 70 : 40`, pinning every conversation at 40 with 70 unreachable. This wires that site to the same `runningTopicIds` helper, and adds `tests/unit/parallel-activity-index-wiring.test.ts`: a structural invariant asserting EVERY `new ParallelActivityIndex(` in `src/` supplies `isRunning`.

## Decision-point inventory

No decision point added or removed. One is **repaired**: "is this topic live, for urgency scoring?" previously had one reachable outcome (always false); it now has two. The urgency values (70/40), their meaning, and every other WorkQueueRegistry source are untouched.

## 1. Over-block

Could a topic be scored 70 when it should be 40? Only if the resolver wrongly places a session. `runningTopicIds` counts a session only when the registry returns a finite number; `null`/`undefined`/`NaN`/missing tmux name are skipped, each pinned by tests from PR #1870. This is a scoring hint on an advisory queue, so even a wrong 70 reorders a list — it blocks nothing.

## 2. Under-block

The previous behaviour WAS the total under-report. Remaining surface: a live session whose topic the adapter cannot resolve stays at 40 — correct, since no conversation is bound to it.

## 3. Level-of-abstraction fit

The wiring belongs at the construction site (only the bootstrap knows which resolver to supply); the invariant belongs in a test that reads construction sites, because a missing constructor argument is not observable from behaviour — the omitted-argument default and the true answer are the same value. The existing behaviour tests inject a stub `isRunning`, which is exactly why they could not catch either instance.

## 4. Signal vs authority compliance

**Signal only.** `WorkQueueRegistry` supplies an advisory ordered list; nothing here gates, spawns, kills, or routes. No exit code, route, or authority changes.

## 4b. Judgment-point check (Judgment Within Floors standard)

None introduced. A registry lookup plus `Number.isFinite`, and a source-text presence check in a test. No heuristic, model call, or threshold.

## 5. Interactions

Blast radius measured: `runningTopicIds` gains one importer (`src/commands/server.ts`), joining `AgentServer.ts` and the two test files. The `ParallelActivityIndex` constructor signature is unchanged. The only consumer of this instance's `running` is the `topics` urgency expression at `server.ts:24704`. `sessionManager` (declared `:5955`) and `telegram` (`:7276`) are both in scope at the construction site — verified, since both are passed by name to the `AgentServer` construction below it.

## 6. External surfaces

None. No network call, new file at runtime, persisted state, credential, telemetry, or route. The new test reads files from `src/` at test time only.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator-visible text. The invariant's failure message names the offending file (`construction sites without isRunning: commands/server.ts`) so a future violation is actionable rather than a bare assertion diff.

## 7. Multi-machine posture (Cross-Machine Coherence)

No issue identified. Local scoring input; no shared state, lease, or replication.

## 8. Rollback cost

Very low. One source file plus one new test file, one commit, no migration, no persisted state, no config flag, no signature change.

## Conclusion

Ship. It repairs the second instance of a silent optional-dependency default and leaves behind a check that fails for any future construction site that forgets — the structural half, not just the fix.

## Second-pass review (if required)

Not required — Tier 1. `classify-tier.mjs` matched no safety-invariant pattern for `src/commands/server.ts`; no new route, exported class, or config key.

## Evidence pointers

- Defect verified in source before any edit: `server.ts:24682` constructed with `{ stateDir }` only, and its sole consumer at `:24704` reads `a.running ? 70 : 40`.
- Root cause is shared with PR #1870: `isRunning` is optional with a `?? false` default, so an omitted argument is indistinguishable from "nothing is running".
- Negative control executed: reverting the wiring makes the invariant test FAIL and NAME the file (`commands/server.ts`), while its three controls still pass. Source restored byte-identical (sha + size 1,524,401 verified).
- The invariant carries its own controls: the sweep finds construction sites (non-zero), it detects a site missing `isRunning`, and its paren-depth extractor survives nested parens and arrow bodies — so it cannot silently match nothing.
- `tsc --noEmit` exit 0; 16/16 across both parallel-activity suites, in a dedicated worktree on main's dependency set.

## Declared silent fallback (no-silent-fallbacks ratchet)

The `catch` returns `false` and carries `@silent-fallback-ok` with its reason. The ratchet
(`tests/unit/no-silent-fallbacks.test.ts`, BASELINE 495) FAILED on the first CI run at 496 — correctly,
since the change added a swallowing catch. The baseline was NOT raised. `false` is the same value the
omitted optional dependency produced, so this is the pre-existing behaviour for an unresolvable topic
rather than a new hidden heuristic; a DegradationReporter call here would fire every pass for any
non-Telegram session, and a ranking hint must never break the queue it ranks.

## Class-Closure Declaration (display-only mirror)

Class: "an optional dependency whose default is indistinguishable from a real answer." Closed for `ParallelActivityIndex.isRunning` at BOTH construction sites, and future sites are now guarded by the invariant. It does NOT claim closure for other optional-dependency defaults in the codebase (e.g. `?? []` enrichment defaults), which were not audited here.
