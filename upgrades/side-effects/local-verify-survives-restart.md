# Side-Effects Review — Local verify survives lifeline restarts; interrupted runs counted and resumed first

**Version / slug:** `local-verify-survives-restart`
**Date:** `2026-10-26`
**Author:** `echo`
**Second-pass reviewer:** `GPT-6 Astra (codex) and Gemini 4 Argon (gemini), code review rounds in docs/specs/reports/local-verify-survives-restart-code-r*.md`

## Summary of the change

Tier 1 (reversible by revert; no migration). Spec: `docs/specs/local-verify-survives-restart.md`. On 2026-10-26 06:23Z the lifeline's drift auto-promote restart stopped the server (quiesce → `supervisor.stop()`), killing PR 2350's 23-minute local verify; the verify's restart hold only guards AutoUpdater restarts. Three changes:

- `src/lifeline/RestartOrchestrator.ts`, `src/lifeline/TelegramLifeline.ts`, `src/lifeline/ServerSupervisor.ts`: `RestartRequest.keepServer`, resolved by bucket (`restartKeepsServer`: versionSkew + plannedUpgrade keep; watchdog stops); quiesce settles its synchronous teardown first and calls `ServerSupervisor.detach()` (fences every path to the server) instead of stopping it; a competing stop request during that window still stops the server (`stopServer` dep). The successor's `start()` adopts an alive session even when it is not answering yet; only a gone session spawns.
- `src/localVerify/LocalVerifyService.ts`: `shutdown()` keeps the killed run's attempt, increments a persisted `interruptions`, sets `resumeFirst`, audits `interrupted`; an unclean exit found at boot does the same. `decideStarved` also raises at 2 interruptions (`reason: 'interrupted'`); `checkStarved` looks at every interrupted entry. `decideStart` starts a `resumeFirst` PR ahead of `main` unless `main` is red (`FairShareState.mainRed`); `resumeFirst` clears at start.
- `src/localVerify/localVerifyWiring.ts`, `src/commands/server.ts`: the starved signal (previously never wired; audit-log only) goes to `hooks.signal` as `local-verify:starved:<pr>:<head12>` and becomes a plain-language attention item.

Size: 7 source files, 10 test files, ~750 LOC with tests. Effort: two review rounds (spec + code, two external reviewers each: 8 reports, 35 findings, 34 accepted). In line with the size for a change that touches the restart path: the reviews caught three real safety gaps the first draft missed (successor killing a busy server; a swallowed stop request; the exit timer beating the stop).

## Decision-point inventory

- `LifelineDriftPromoter` → `RestartOrchestrator` quiesce — modify — a drift restart detaches from the server instead of stopping it.
- `ServerSupervisor.start()` — modify — alive-but-busy session adopted, never killed from start; gone session spawns (P1 race kept).
- `RestartOrchestrator.requestRestart` — modify — a suppressed stop request's server policy overrides an in-flight keep-server restart.
- `decideStarved` — modify — second trigger (interruption count) for an existing signal; also evaluated at the end of restore and over the in-flight entry.
- `decideStart` (fair share) — modify — ordering: an interrupted PR first unless `main` is red.
- Local-verify attention signal mapping in `server.ts` — modify — starved key gets a plain title/summary.

---

## 1. Over-block

No block/allow surface — over-block not applicable. Nothing is refused; the changes only keep a process running, reorder a queue, and raise a signal earlier.

---

## 2. Under-block

- Other server stops still kill a running verify: a manual `instar server restart`, an external SIGTERM to the lifeline (`bucket: 'watchdog'`, which still stops the server), a lifeline watchdog trip, a crash. Those now at least COUNT (interruption + early starved alarm + first in line after), which is the honest floor: a deliberate operator restart should win over a verify.
- A successor that adopts an alive-but-silent server hands the decision to the health loop; if the server really is wedged, the loop's process-alive threshold (plus the CPU-starvation defer) restarts it later than `start()` would have — the designed behaviour for a running server, a few minutes slower in the worst case than killing on arrival.
- The supervision gap between the old lifeline's exit and the successor's `start()` is not a fixed ten seconds: launchd's throttle and the successor's own boot steps precede `supervisor.start()`. The server runs unsupervised for that gap; nothing new there (every lifeline restart had it), stated rather than implied away.
- `keepServer` relies on the server's tmux session surviving the lifeline's exit. Verified on the Studio: the session lives in the shared tmux server (own process group, started independently), not in the lifeline's launchd job process group, and the plist sets no process-group kill. If a platform ever tied the tmux server to the lifeline's group, the server would die as before (today's behaviour), not worse.
- The early starved alarm needs two interruptions of the SAME head; a new push resets the count (a new head is new work).

---

## 3. Level-of-abstraction fit

The kill happened because the drift restart stopped a server that did not need stopping; fixing it at the lifeline's quiesce (keep the server for a lifeline-only restart) removes the cause instead of adding a second hold check to the drift promoter's clean-window predicate. The counting and ordering live where the queue already decides (`decideStarved`, `decideStart`), reusing the existing starved signal and the existing `hooks.signal` → attention path rather than a new notifier.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The starved change feeds the existing signal path (attention item, signal only). `decideStart` orders work; it refuses nothing. `keepServer` narrows what an existing restart does.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The interruption threshold (2) is a deterministic trigger for a signal, not a gate; the `resumeFirst` rule is an ordering invariant ("the restart, not the PR, lost its place") bounded to once per interruption and yielding to a red `main`.

---

## 5. Interactions

- **Restart hold** (`registerLocalVerifyRestartHold`): unchanged; still guards AutoUpdater restarts.
- **Rule (b) update pause**: unchanged. An interrupted PR obeys it like any entry.
- **Merge line hold / verifier hold / orphan reap**: `pump()` checks them before `decideStart`; `resumeFirst` changes order only after they allow a start.
- **Fair share**: with `resumeFirst`, a PR may run before an overdue `main` once per interruption; `main` red keeps priority. Bounded: `resumeFirst` is cleared at start.
- **Unclean-exit error retry**: kept; the interruption count is added beside it (it still stops with a `server-restarted` error record past one retry).
- **Lifeline successor**: `ServerSupervisor.start()` adoption path handles "server already running" (planned-exit marker checks, grace period), now also when it is not answering yet. A lifeline-only restart writes no planned-exit marker, so the new lifeline adopts without maintenance wait — correct, nothing is restarting.
- **Orchestrator single-flight**: unchanged (one restart at a time); only the server policy of a suppressed stop request is carried into the in-flight restart.
- **`handleRestartRequest` / sleep / wake paths** in the supervisor: fenced by `detached` like every other path; after detach the supervisor is inert until the process exits.
- **Self-action registry** (`src/testing/selfActionRegistry.ts`) models `decideStarved`/`decideStart` without the new optional fields; its behaviour is unchanged (the new branches need `resumeFirst`/`interruptions`).

---

## 6. External surfaces

- A new attention item kind, `local-verify:starved:<pr>`, one signal per PR per stay in the queue ("PR #N cannot finish its check"), UPSERTED so a later episode reopens the item. Previously no such item existed at all.
- `GET /local-verify` queue entries may carry `interruptions` and `resumeFirst`.
- The server stays up across a lifeline drift / version-skew / planned-upgrade restart: the server.log no longer shows a shutdown/boot pair at that moment, and sessions are not interrupted by it either (a side benefit: the 06:23Z restart also re-injected/resumed 6 sessions).
- `instar lifeline restart` and a watchdog trip behave as before (server restarted).

---

## 6b. Operator-surface quality

No dashboard/approval/grant surface touched — not applicable. The attention item text is plain language, one sentence of what happened and its effect.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: the local-verify queue, journal and in-flight run live on the lease holder only (existing posture, unchanged), and each machine's lifeline supervises only its own server. The starved attention item is raised by the machine running the verify, which is the only one with the queue.

---

## 8. Rollback cost

Revert the PR and release. No data migration: `interruptions` and `resumeFirst` are optional `queue.json` fields an older server ignores (its reader spreads unknown fields but never acts on them). A reverted lifeline goes back to stopping the server on drift restarts.

---

## Conclusion

Ship. The root cause (a lifeline-only restart bouncing the server) is removed for the path that fired tonight, and every remaining way a verify can be killed is now counted, alarmed and put back first.

---

## Second-pass review (if required)

**Reviewer:** GPT-6 Astra + Gemini 4 Argon (external code review); results recorded in Evidence pointers.

---

## Evidence pointers

- Incident: `.instar/logs/local-verify.jsonl` 2026-10-26T06:23:53Z `cancel … reason: shutdown`; `.instar/logs/lifeline-launchd.log` `[Lifeline][DriftPromoter] firing self-restart: diff=20, reason=drift-auto-promote`; `logs/server.log` 06:23:53 `Shutting down...`; `.instar/state/auto-updater.json` `pendingUpdate: null`.
- Tests: `tests/unit/localVerify/LocalVerifyService.test.ts` (interrupted runs, decideStarved), `tests/unit/localVerify/mainHealth.test.ts`, `tests/unit/lifeline/RestartOrchestrator.test.ts`, `tests/unit/lifeline/drift-restart-keeps-server.test.ts`, `tests/integration/local-verify-routes.test.ts`, `tests/e2e/local-verify-lifecycle.test.ts`.
- Commit 2 (2026-10-26 06:10): the first local verify (12:01Z) was red on ONE test, the silent-fallback ratchet (495 > 494) — a new bare `catch {}` in the quiesce teardown; both catches now carry `@silent-fallback-ok` with their reason. The e2e adoption test no longer `skipIf`s on tmux (it was the record's `skipsAdded`); a missing tmux fails loudly. Gate attempts: 3 (self-action declaration, then this).
- Reviews: `docs/specs/reports/local-verify-survives-restart-{spec,code}-r1-{astra,argon}.md` — round 1: Astra spec "ready with changes" (6), Astra code "not ready" (6), Argon spec "ready with changes" (5), Argon code "ready with changes" (6); every finding accepted and fixed except the e2e-through-production-seams shape (declined with reason in the spec's Review changes). Round 2 (`*-r2-*`): Argon spec ready; Astra spec ready-with-changes (5), Astra code not-ready (4), Argon code ready-with-changes (3) — all accepted and fixed (stop-phase budget, telemetry-window stop, post-wait `detached` re-checks, `resumeFirst` without `main`, upsert for the starved item, wording).

---

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts (registry entry local-verify-interrupted-resume in src/testing/selfActionRegistry.ts), howCaught: "control-loop edge: a server stop increments a PERSISTED interruptions count and sets resumeFirst on the killed entry; steady-state bound: the starved notify fires at most once per entry per queue stay (starvedRaised, persisted the moment it flips) and the entry jumps the line at most once per interruption (resumeFirst consumed on start) — 48 modelled restarts ⇒ ≤ 1 notify per entry, attempts never decremented; settling brake: the keep-server restart removes a kill and adds no spawn, and the orchestrator's stop-phase override fires at most once per process (the process exits)" }`. No agent-authored-artifact defect is fixed by this change.
