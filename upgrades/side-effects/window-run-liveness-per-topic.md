# Side-Effects Review — window-run liveness holds one binding per topic

**Version / slug:** `window-run-liveness-per-topic`
**Date:** `2026-11-01`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

`WindowRunLivenessAuthority` kept ONE binding for the whole agent in `window-run-liveness/state.json`. It was built for one W32 window at a time (September); on 2026-10-09 ordinary autonomous runs were admitted into the same slot without making it per-topic. So a live run in one topic refused every other topic's registration with `window-run-liveness-active-binding-exists`. On 2026-11-01, after PR 2561 fixed the field names, topic 131439's register was refused at 21:13 because the quota topic's run held the slot, and its run stayed `preparing`. CLAUDE.md says up to 5 autonomous runs can run at once (one per topic); the slot contradicted that. It was not a deliberate limit.

Changes:
- `src/core/WindowRunLivenessAuthority.ts`: `WindowRunLivenessStore` keeps each topic's binding at `window-run-liveness/topics/<topicId>/state.json` with its own mutation lock. The pre-split root `state.json` is moved (atomic rename) into its topic's directory on first read; if that topic already has a file, the old one is set aside as `state.json.pre-split-<ms>`, never merged. Terminal-window markers stay shared. The root store's `load()` returns the primary binding (newest registered live one, else newest) for single-binding readers; `save()` routes by `state.topicId`. The authority's `register`, `recordWorkAdvance`, `tick(topicId?)`, `freeze(reason, status, topicId?)` and `status(topicId?)` act per topic; `status()` adds `states` (every topic). `tick()` with no topic evaluates every topic, each under its own lock and serializer; one topic's failure does not stop the others (the first error is rethrown after all ran). New refusal: one window cannot be live in two topics (`window-run-liveness-window-bound-elsewhere`). Within a topic the old rules are unchanged.
- `src/core/WindowRunCadenceExecutor.ts`: same per-topic layout and migration for the cadence clock; `tick()` advances a clock for every topic's liveness binding (new optional dep `getLivenessAll`).
- `src/core/AutonomousStartAdmission.ts`: start admission reads THIS topic's binding; the preparing watchdog accepts every bound run (`boundRuns`), so each bound run gets its first-receipt allowance.
- `src/server/AgentServer.ts`, `src/server/routes.ts`: wiring; `?topicId=N` on `GET /window-run-liveness`, `POST /window-run-liveness/tick`, and the cadence routes. Every W32 lifecycle proof reader (freeze, `runLivenessPayload`, `deterministicPayload`, cadence-report requery and materialization) now selects the binding matching the ledger's window and lifecycle run, and embeds it in the pre-split snapshot shape `{enabled, dryRun, config, state}`, so another topic's run neither hides the window's binding nor changes a recorded proof hash.
- `src/core/PostUpdateMigrator.ts`: the register awareness sentence now says one binding per topic; a content-sniffed migration replaces the old sentence in existing agents' CLAUDE.md once.

Tier 1 declared (see trace reasoning; the risk floor may flag the state-layout move). 6 source files, 6 test files. No spec. Two review passes: 4 concerns in the first, all resolved; the second concurred.

## Decision-point inventory

- `register()` refusal — **modify**: the "another binding is live" check is now scoped to the same topic; a new cross-topic refusal covers only the same window id.
- `decideAutonomousStartStatus` — **modify**: reads this topic's binding instead of the agent-wide one.
- `findStuckPreparingRuns` — **modify**: honours several bound runs.
- Recovery/freeze/notify logic — **pass-through**: unchanged, now applied per topic.

## 1. Over-block

No new over-block. The only new refusal (`window-bound-elsewhere`) rejects the same window id live in two topics, which would give one window two sets of receipts. Ordinary runs use a window id unique per run.

## 2. Under-block

While a W32 window is open, a run registered in a topic with no binding of its own now starts `preparing` (before, a run in any other topic started `active` only because the single agent-wide slot was taken). Such a run must register its own binding, as the CLAUDE.md register line says; if it never does, the preparing-run watchdog still tells its topic. Outside an open W32 window (the normal case since 2026-09-08) every run starts `active`, unchanged. Two topics can now each run an executor and recovery at the same time; each still gets exactly one recovery attempt, bounded by the recovery ceiling. The cap on concurrent autonomous runs remains `autonomousSessions.maxConcurrent` (default 5), enforced at `/autonomous/can-start`, not here. A legacy file whose topic already has a file is set aside rather than merged; nothing reads the set-aside copy. An unreadable legacy file is moved to `state.json.unreadable-<ms>` with a warning instead of blocking every topic.

## 3. Level-of-abstraction fit

The store is the right layer: the "one slot" was a property of the file layout, and every consumer already carried `topicId`. Fixing it in the store keeps each topic's lock independent, so a slow tick in one topic does not hold another.

## 4. Signal vs authority compliance

Reference: `docs/signal-vs-authority.md`. No new blocking authority based on brittle logic. The authority already owns run liveness; this removes an accidental agent-wide block. The new same-window refusal is an identity check on an exact id, not a judgment.

## 5. Interactions

- Root-store `save()` delegates by `state.topicId`, so every existing `this.store.save(state)` inside recovery/stall/fail/notify lands in the right topic file.
- `TickSerializer` is per topic; an HTTP tick for one topic coalesces only with a background tick for that topic.
- The cadence executor reads liveness once per tick to list topics and again under each topic's lock (fresh read, as before).
- The preparing watchdog previously exempted only the one bound run; it now exempts every bound run for its longer allowance.

## 6. External surfaces

`GET /window-run-liveness` gains `states` and accepts `?topicId=`; `state` without a topic is the primary binding (same shape as before). `POST /window-run-liveness/tick` and the cadence routes accept `?topicId=`; a non-numeric value is a 400. Error string `window-run-liveness-window-bound-elsewhere` is new. On-disk layout changes under `.instar/window-run-liveness/` and `.instar/window-run-cadence/`.

## 7. Multi-machine posture

Machine-local by design, as before: the binding and cadence files live in this machine's state dir. The cadence executor's existing `canAct` ownership check (topic owner == this machine) still gates actuation per topic, now for each topic independently.

## 8. Rollback cost

Revert the release. Caveat: after the migration the binding lives under `topics/<id>/state.json`; the old code reads only the root `state.json`, so after a revert a live run's binding is invisible until moved back (`mv .instar/window-run-liveness/topics/<id>/state.json .instar/window-run-liveness/state.json`, same for `window-run-cadence`). The feature is Echo-only and dev-gated, so no fleet agent is affected.

## Evidence

Unit: two topics register and both go active in one `tick()`; each reads by topic; freezing one leaves the other active; a second window in the same topic is still refused; the same window in two topics is refused; a pre-split root file moves into its topic and reads identically. Cadence: two topics each get a clock and a checkpoint request. Watchdog: two bound runs both get the long allowance. Migration: old sentence replaced once, idempotent, and the template carries the new one. Integration: second topic registers over HTTP alongside the first; `?topicId=` reads each; `?topicId=abc` is 400; same window in a second topic is 409; per-topic tick returns that topic.

## Second-pass review

First pass (independent subagent): **Concern raised**, four items: (1) W32 proof readers in `routes.ts` still read the primary binding, so a second topic's run would hide the W32 binding and break proofs; (2) proof payloads embedded `states`, so any topic's tick changed the payload hash; (3) admission now starts other-topic runs `preparing` during an open W32 window; (4) a corrupt legacy file would block every topic. Lock scoping, migration races, terminal markers and signal-vs-authority were confirmed correct.

Resolution: (1)+(2) fixed with `windowLivenessStatus`/`windowCadenceStatus`, which select by window and keep the pre-split shape; (3) kept on purpose and documented under Under-block; (4) fixed, with a unit test.

Second pass on the fixes: **Concur.** One minor note, also fixed: the set-aside applies only when the legacy file fails to parse or validate. A failure while moving a readable file is rethrown, so a valid live binding is never set aside because of EACCES or ENOSPC.

## Follow-up: fallback-ratchet tags

Local Verify failed `tests/unit/no-silent-fallbacks.test.ts` (496 over the 494 baseline). No new catch was counted. The new `windowRunTopicQuery` helper's `return undefined;` fell inside the scanner's 20-line window for two existing catches (`/window-lifecycle/rollback` and `/window-lifecycle/reenable`). Both return the error as HTTP 409, so they now carry `@silent-fallback-ok` like the waiver route next to them. Comment-only change; behaviour unchanged. The scanner reports 494 again.

## Follow-up: test doubles and the start-status test

Six integration and two e2e tests failed on this branch and passed on main. Seven came from hand-written liveness doubles that still returned the old `status()` shape (`state` only). The window-close proof helpers now read `states`, so those doubles now return `states` as well. The real authority always returned it; production code is unchanged. The eighth was `autonomous-register-start-status`, which still expected the old agent-wide rule (a run starts active when another topic holds the window). It now asserts the per-topic rule from §2: a topic with no binding of its own prepares, and a topic whose binding is live starts active. Promotion for such a run comes from registering its own binding, admitted through `ordinaryRunLifecycle`, which is on for Echo.
