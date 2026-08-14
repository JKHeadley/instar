# Side-Effects Review — parallel-work `running` flag: wire it to the real topic source

**Version / slug:** `parallel-work-running-flag-wiring`
**Date:** `2026-08-14`
**Author:** `Echo (instar agent)`
**Second-pass reviewer:** `not required (Tier 1, read-only observability surface, no authority)`

## Summary of the change

`GET /parallel-work/activities` reports a `running` flag per topic. `AgentServer.ts` built the running set as:

```ts
for (const s of options.sessionManager.listRunningSessions() as Array<{ topicId?: number | null }>) {
  if (typeof s.topicId === 'number') ids.add(s.topicId);
}
```

`Session` (`types.ts:45-155`) declares NO topic field, and nothing attaches one at runtime (all 13 `.topicId =` assignments in `src/` are on commitments, jobs, manifests or apprenticeship refs). So the guard was always false, the set always empty, and `running` was false for every topic since the surface shipped — `runningCount` a permanent zero. The topic↔session link lives in the messaging adapter's registry keyed on the tmux session name, which is exactly how `GET /sessions` derives `platformId`. The resolution is extracted to an exported pure helper `runningTopicIds(sessions, resolveTopic)` in `ParallelActivityIndex.ts`; `AgentServer` supplies `options.telegram.getTopicForSession`. The false cast is deleted. Six wiring-integrity tests added.

## Decision-point inventory

No decision point is added or removed. One is **repaired**: "does this topic have a live session?" previously had one reachable outcome (always false). It now has two. The index's own logic, focus derivation, tag extraction and enumeration are untouched.

## 1. Over-block

Could this report running where it should not? The realistic over-report is inventing a topic for an unplaceable session. Guarded: a session is counted only when the registry returns a finite number; `null`/`undefined`/`NaN`/missing tmux name are all skipped, each pinned by a test. A control asserts an empty session list still yields an empty set — a real zero stays zero.

## 2. Under-block

Could it under-report? The previous behaviour WAS total under-report. Remaining surface: a live session whose topic the adapter cannot resolve (e.g. a non-Telegram session) is not counted — correct, since no conversation is bound to it. A resolver that throws for one session no longer blinds the rest (previously moot, since nothing was ever found).

## 3. Level-of-abstraction fit

The helper sits in `ParallelActivityIndex.ts` because that module owns the concept the flag expresses, and because a pure function is the only level at which the WIRING can be tested. The bug was never in the index — its own tests inject a stub `isRunning` and passed throughout — so a test at the index level structurally cannot catch it. `AgentServer` keeps ownership of WHICH resolver to supply.

## 4. Signal vs authority compliance

**Signal only, and read-only.** `/parallel-work/activities` is an observability surface: per CLAUDE.md it "never gates". Nothing consumes `running` to block, spawn, kill, or route. The ParallelWorkSentinel that reads the index is explicitly observe-only and emits an in-process nudge with no listener wired. No authority is created or changed.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point introduced. A registry lookup plus `Number.isFinite` — deterministic, no heuristic, no model call, no threshold.

## 5. Interactions

Blast radius measured, not assumed. `runningTopicIds` is new and has exactly two importers: `AgentServer.ts` and the unit test. The `ParallelActivityIndex` constructor signature is unchanged, so both construction sites keep working — including `src/commands/server.ts:24682`, which never supplied `isRunning` and continues to report `running:false` for its own instance (that instance backs a different consumer and is out of scope here; noted rather than silently changed). Consumers of the flag: `ParallelWorkSentinel` / `ParallelWorkOverlap` (observe-only) and `PoolActivityView` (`?scope=pool`), which recomputes `runningCount` from the same rows and therefore corrects with it.

## 6. External surfaces

None. No network call, no new file, no persisted state, no credential, no telemetry, no new route. The change reads an already-loaded in-memory registry.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new operator-visible text. The visible effect is that `running` and `runningCount` become true when they are true. No paths, no internal field names, no stack traces.

## 7. Multi-machine posture (Cross-Machine Coherence)

The `?scope=pool` view composes local rows with replica-derived remote rows and recomputes `runningCount` from them, so this correction flows through unchanged. A peer still running the old code contributes its own (always-false) rows until it updates — a staleness property of the existing replica design, not introduced here.

## 8. Rollback cost

Very low. Two source files, one test file, one commit; no migration, no persisted state, no config flag, no signature change to any existing export.

## Conclusion

Ship. The change repairs a read-only coherence surface that has reported a false constant since it shipped, adds no authority, and is guarded in both directions by tests that fail against the old wiring and pass against a genuine zero.

## Second-pass review (if required)

Not required — Tier 1. `classify-tier.mjs` matched no safety-invariant pattern for either in-scope file; no new route, no exported class, no config key.

## Evidence pointers

- Defect confirmed on the LIVE server before any edit: `/parallel-work/activities` returned `count: 91, runningCount: 0` with `running:false` for topic 29723 — while that topic's session was confirmed live two independent ways (`GET /sessions` and `tmux ls`).
- Root cause confirmed in source: `Session` declares neither `topicId` nor `platformId` (grep counts 0 and 0 across `types.ts:45-155`); the live API records carry `platformId` with `topicId: undefined`, keys printed rather than assumed.
- Negative control executed: reverting the helper to read `s.topicId` fails 2 of the 12 tests while BOTH controls still pass — proving the controls are checks, not echoes. Source restored byte-identical (sha + size 8,331 verified).
- `tsc --noEmit` exit 0; `tests/unit/parallel-activity-index.test.ts` 12/12 (was 7).
- Note on scope of `tsc`: `tsconfig` excludes `tests/`, so the typecheck says nothing about the test file; the suite run is the evidence for it.

## Class-Closure Declaration (display-only mirror)

Class: "a lookup that can never find what it is looking for, reporting success." Closed here for the parallel-work `running` flag. It does NOT claim the class is closed repo-wide; in particular, other `as Array<{...}>` casts asserting fields a type does not declare were not audited, and that pattern is what allowed this one to ship.
