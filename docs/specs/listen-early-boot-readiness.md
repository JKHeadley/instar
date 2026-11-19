---
title: Listen early during server boot, and attributed restarts
slug: listen-early-boot-readiness
status: implemented
tier: 1
eli16-overview: docs/specs/listen-early-boot-readiness.eli16.md
owner: echo
date: 2026-11-16
---

# Listen early during server boot, and attributed restarts

## Problem (measured 2026-11-16)

- M5 Pro (Echo, port 4062): at 19:42:11Z `[LiveConfig] Change detected: monitoring` (the only difference: `monitoring.localVerify.operatorGhLogin` absent → `JKHeadley`), then at 19:42:12Z `[ForegroundRestartWatcher] Restart requested by undefined (no version change)`. The new process logged `Server listening on 0.0.0.0:4062` at 19:45:11Z, 2m43s after it started. Peers got 403 (shutting down) then ECONNREFUSED; the Studio's conversation graph stopped at `custody:graph-peer-frontier-reachable-unverified`, and the operator's Accept all (19:43Z) fell inside the gap.
- The writer: session `echo-increasing-throughput` on the Studio, at 19:42:07Z, over ssh: it edited the M5's config.json and hand-wrote `state/restart-requested.json` with `plannedRestart`, `bypassHolds`, `reason`, and no `requestedBy`. Every writer inside instar names itself; a session had no supported way to ask (`instar server restart` refuses inside a session), so it wrote the file.
- Why a restart: Local Verify read `operatorGhLogin` once at boot (`buildLocalVerifyService`, `buildStatusReconciler`).
- Why the port was closed: the boot health beacon (`BootHealthBeacon`, topic 21816) was dev-gated. The M5's config has no `developmentAgent`, so it was dark there; on the Studio it was live but bound only 127.0.0.1, so mesh peers were refused anyway.

## Design

### 1. Listen early

- `BootHealthBeacon` is on for every agent (`monitoring.bootHealthBeacon.enabled: false` turns it off). It graduated from the dev gate on 15 clean dev-agent boots with no error (feature evidence, 2026-11-16) plus this incident.
- It binds the same host the real server will (`resolveMeshBindHost` with the same `meshBindActive` predicate: a machine identity exists and the mesh transport is not off). A single-machine agent stays on 127.0.0.1.
- `src/server/BootReadiness.ts`: a process-wide tracker. Fields: `state` (`starting` | `ready`), `startedAt` (process start), `elapsedMs`, `readyAt`, `earlyListen {at, host}`, `retryAfterSeconds` (while starting), `phase`, `subsystems` (`config`, `instance-lock`, `multi-machine`, `scheduler`, `messaging`, `sessions`, `http`: `pending` | `ready` | `not-started`), `lastBootMs`, and for an authenticated caller `previousRestart`.
- Retry-After: the previous boot's length (persisted at `state/boot-readiness.json`) minus the time elapsed, bounded to 2–30 s; 10 s with no record.
- Beacon answers: every route, `GET /health` included, is a 503 with `Retry-After`, `x-instar-boot-state: starting`, and `{error: "starting", status: "starting", message, retryAfterSeconds, bootReadiness}`. It no longer answers 200 on `/health` (the old dev-only beacon did): install's `serverHealthy`, `test-as-self`, the hook health checks and PostRestartProof all read 200 as "serving", and on the fleet they would have run against a server that could not answer yet.
- ServerSupervisor: `probeHealth()` returns `healthy` | `starting` | `down`; `starting` is the typed 503. Past the startup grace a `starting` probe is not a failure and not "up" (nothing is forwarded into it), bounded by the existing ceiling (3 × grace, 30 min): a boot still starting after that is handled like a down server. This keeps the beacon's original purpose (topic 21816: never restart a slow boot mid-boot) without the 200.
- The real server marks ready in its listen callback; its `/health` carries `bootReadiness` with `state: "ready"`.

**The readiness name: `bootReadiness.state` on `GET /health`.** `"starting"` (with a 503) while the boot beacon answers, `"ready"` (with the 200) once the real server serves. A `/health` 200 therefore still means serving; the field adds what is starting, how long to wait, and who asked for the restart. This is what PostRestartProof's server row reads (docs/specs/machine-self-maintenance.md).

- The conversation graph's peer call treats a 503 marked `x-instar-boot-state: starting` as an unavailable peer (step `graph-peer-call-peer-starting`), not as an unverified answer.

### 2. Attributed restarts

- `src/core/restartRequestAttribution.ts`: `describeRestartRequester` names the requester or says `an unattributed writer (no requestedBy in restart-requested.json)`; `recordRestartRequest` appends each consumed request to `.instar/logs/restart-requests.jsonl` (bounded 256 KB); the next boot reads the last one into `bootReadiness.previousRestart`.
- ServerSupervisor and ForegroundRestartWatcher use it: no more "requested by undefined". An unattributed flag still restarts; refusing it would leave its writer's change unapplied with no one told.
- `POST /server/restart {requestedBy, reason}` (Bearer): both required, one line, bounded (100/300). Writes the same planned-restart flag through `requestSupervisedRestart` (Local Verify holds apply; no `bypassHolds`). 202, or 400 / 503.
- `monitoring.localVerify.operatorGhLogin` is read live (`liveOperatorGhLogin` on LocalVerifyService and StatusReconciler), so the change that caused this restart now needs none.
- Awareness entry `src/data/awareness/server-restart-and-boot-readiness.md` tells agents to use the route and to read `bootReadiness.state`.

## Decision points touched

- Supervisor health: a typed `starting` 503 is alive-and-booting (no failure, not up) up to the grace ceiling; any other non-2xx is unchanged.
- Callers that read a `/health` 200 as serving (install, test-as-self, hooks, Slack lifeline's `status === 'ok'`): unchanged, because the beacon never answers 200. On dev agents this also ends the old beacon's 200, which marked a booting server "up" and let the lifeline forward into it.
- Restart flag consumers: unchanged decisions; only naming and recording.
- Graph peer call: a booting peer is unavailable, not unverified.

## Not in scope

Planned OS restarts, the drain, the plannedRestart advert and PostRestartProof belong to machine self-maintenance (docs/specs/machine-self-maintenance.md); this change only gives them the readiness field to read. No code in the machine-maintenance blocks of `src/commands/server.ts` was touched.

## Tests

- Unit: `tests/unit/boot-readiness.test.ts` (tracker states, Retry-After bounds, persistence, attribution record/read/bound/never-throws), `tests/unit/BootHealthBeacon.test.ts` (typed answers, host binding, handoff), `tests/unit/ForegroundRestartWatcher.test.ts` (unattributed and named flags), `tests/unit/localVerify/LocalVerifyService.test.ts` (live operator login).
- Integration: `tests/integration/server-restart-route.test.ts` (auth, 400 cases, 202 flag shape, 503 unwritable, /health field).
- E2E: `tests/e2e/listen-early-boot-lifecycle.test.ts` (beacon → real server on one port, production order).
