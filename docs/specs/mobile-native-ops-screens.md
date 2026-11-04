---
title: "Native Schedule, Promises and Machines screens for the Instar iPhone app (read-only)"
slug: "mobile-native-ops-screens"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "mobile-native-ops-screens.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under Justin's request (Telegram topic 134088, 2026-11-03 22:01 and 22:55 PST: the app should do every feature natively); approval applies because the three read-only routes expose no more than the console already shows the owner"
review-convergence: "2026-11-04T07:25:15.895Z"
review-iterations: 6
review-completed-at: "2026-11-04T07:25:15.895Z"
review-report: "docs/specs/reports/mobile-native-ops-screens-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 1
contested-then-cleared: 0
---

## 1. Problem

Operator request (Justin, Telegram topic 134088, 2026-11-03 22:01 and 22:55 PST): the Instar iPhone app should do every feature natively instead of opening dashboard pages. The plan of record (`.instar/lanes/app-native-coverage-plan.md`, build-order rows 3-5) names the next three: **Schedule** (jobs), **Promises** (commitments), and **Machines plus Health** as one "is everything up" screen.

Today a paired phone signs every request with its Secure Enclave device key, and `deviceAuthenticator` admits only routes listed in `DEVICE_ALLOWLIST` (`src/server/mobilePairingRoutes.ts`). `GET /health` is listed. `GET /jobs`, `GET /commitments` and `GET /pool` (what the console's Schedule, Promises and Machines pages read) are Bearer-only, so the app can only show these through a PIN-gated web view.

This change is read-only: nothing the phone sends can change a job, a promise or a machine.

## 2. What exists (instar main 7df9eeea6)

- `GET /jobs?scope=pool` (`routes.ts` `buildLocalJobs` + `jobsPoolMerge`): every job definition spread whole (`execute` = the job's prompt or script, `resolvedPath`, `bodyHash`, `recentOutputs`, `lockTrust`, ...), its state, merged across online peers with a short-TTL cache.
- `GET /commitments?scope=mesh`: the full commitment records (`configPath`, `behavioralRule`, `verificationPath`, `correctionHistory`, `escalationDetail`, ...), own plus replicas.
- `GET /pool`: each machine's capacity row (hardware including `hostname` and `cpuModel`, `sshEnrollment`, quota state, rope condition, liveness and the server-rendered `livenessLine`).
- `GET /health` (device-allowed): unauthenticated callers already get `status`, `uptimeHuman`, `degradations` and `degradationSummary` (plain-language narratives).
- The console's view models (`dashboard/console/schedule-model.js`, `promises-model.js`, `machines-model.js`) turn those into the plain words the owner sees.
- People and roles (`docs/specs/mobile-app-people-and-roles.md`): every device resolves to a person with role `owner` or `msp`; `devicePersonOf(req)` exposes it after the device check.

## 3. Design

### 3.1 Three purpose-built routes, not the raw ones

New module `src/server/mobileOpsRoutes.ts`, mounted inside `createRoutes` so it reads the SAME server-side functions the console's routes use:

| Route | Reads | Answers |
|---|---|---|
| `GET /mobile/jobs` | `jobsPoolMerge(buildLocalJobs())` (the `/jobs?scope=pool` payload) | `{ schemaVersion: 1, generatedAt, schedulerRunning, poolEnabled, jobs: MobileJob[], truncated, unread: { count, names }, stale? }` |
| `GET /mobile/commitments` | `commitmentsMeshRows(false)` (the `/commitments?scope=mesh` merge) | `{ schemaVersion: 1, generatedAt, enabled, commitments: MobileCommitment[], truncated }` |
| `GET /mobile/machines` | `poolView()` (the `/pool` payload) | `{ schemaVersion: 1, generatedAt, poolEnabled, single, inventoryKnown, headline, machines: MobileMachine[] }` |

`poolView()` and `commitmentsMeshRows()` are extracted from the existing `/pool` and `/commitments?scope=mesh` handlers with no behaviour change to them.

Each route maps the raw rows through an explicit allow-list of fields (pure summarizers, unit-tested):

- **MobileJob** (`unread.count` can exceed `unread.names.length`: a peer with no verified name is counted, never named; the app words both cases): `slug, name, description, schedule (cron text), scheduleWords, enabled, status, statusLine, needsLook, lastRunAt, lastResult, nextRunAt, consecutiveFailures, machines` (verified machine nicknames only). Status rules copy the console: `late` = runs here, recorded next run more than 10 minutes past, not running; `failing` = consecutive failures > 0 (a retry running after failures stays `failing` until a run succeeds); `running`, `next-unknown`, `ok`, `elsewhere`, `off`. One row per slug across machines: the worst status wins (failing > late > running > next-unknown > ok > elsewhere > off, so a status on a machine that runs the job beats "elsewhere"), and among entries with that status the one with the soonest recorded next run decides the row. Every time on the row (`lastRunAt`, `nextRunAt`) is that deciding entry's own, so a late row shows its overdue time, never another machine's future run. Placement decides first: an entry from a machine that does not run the job is `elsewhere` before its failures or running state are read, so a non-running machine's old failures never outrank the machine that runs it. A peer row without `runsOnThisMachine` (an older peer) is not counted as running there, so it can never read "late"; a local row without it (an older scheduler) is. Order: failing, late, running, next-unknown, ok (soonest next run first), elsewhere, off; ties by name. Cap 300 rows (`truncated`). A row's slug must be an identifier (`[A-Za-z0-9][A-Za-z0-9._-]{0,79}`) or the row is dropped; `schedule` and `scheduleWords` (which returns the raw cron text for shapes it does not recognise) pass through the same scrub and cap as other text. "Late" is an estimate against this server's clock: a peer's recorded next-run time is compared with it directly, so clock skew between machines can move a job across the 10-minute line near the boundary. The grace makes that rare; it does not rule it out.
- **MobileCommitment**: `id, text (agentResponse, else userRequest), request (userRequest), status, open, dueAt (soonest of hardDeadlineAt / checkInAt / nextUpdateDueAt / softDeadlineAt), overdue (open and hardDeadlineAt passed), waitingOn ('you' | 'your answer' | 'your approval' | 'something outside' | null), atRisk, createdAt, resolvedAt, machine` (verified name of the holding machine for a replica row), `stale` (a replica row whose last update is older than 15 minutes or of unknown age, the console's `REPLICA_FRESH_MS`; own rows never). Open promises first (overdue, then soonest due, then newest); promises closed in the last 7 days after them; older closed ones are left out. Cap 200.
- **MobileMachine**: `key` (a stable opaque row key: the first 16 hex of sha256 of a fixed prefix and the machine id, so rows keep their identity across refreshes and re-sorts), `name (verified nickname), isSelf, leading, state ('live' | 'struggling' | 'unreachable' | 'stale' | 'unknown'), statusLine, loadVerdict, loadPerCore, sessions, maxSessions, version`. State comes from the server's liveness block when present (live with a `saturated`/`impaired` verdict reads as struggling); otherwise `online` is an estimate and the line says "estimated"; when any peer's state is estimated, an all-answering headline says "appear to be answering (estimated from heartbeats)" instead of a flat claim. Only a pool that is explicitly switched off (`enabled: false`) proves a single machine: it gets one "This machine" row, "One machine, answering." A pool that is on, or a view that does not say, with no usable rows answers the same row with `inventoryKnown: false` and the headline "This machine is answering, but I can't read the list of your other machines right now." — never a claim of one machine. A pool with rows shows what the pool registry knows, as the console does. The self row's `key` is the same hashed key in both cases (the literal `self` only when this server has no machine id at all). `single` is true only for a pool switched off; a pool that is on and lists one machine says "One known machine, answering." The app words an unknown inventory from `inventoryKnown`, not from `poolEnabled`. Unreachable machines first. The status line is the server-rendered `livenessLine` (fixed wording plus verified machine names and ages, `formatLivenessLine`), scrubbed again.

Never returned (as fields): a job's `execute` (prompt/script), any file path field, `bodyHash`, script outputs, commitment config/verification/rule fields, correction history, hostnames, CPU model, SSH enrollment, quota detail, tokens, peer error text, or any machine id (machines are named by verified nickname only; each row carries `key`, a one-way identifier derived from the id, which lets the app tell rows apart and keep their identity across refreshes; SwiftUI identifies rows by `key`). Free prose that the console already shows (job name and description, promise text) is shown as the console shows it — it can mention a path the way the console can — and passes through `scrubSecrets` (the shared deterministic redactor) and is whitespace-folded and length-capped (name 80, description 200, promise 280). Machine names pass through `verifiedEntityName` (no id is ever shown as a name).

The machine screen's health half is the existing device-allowed `GET /health` (status, uptime, degradation narratives). No new health route.

Job names and descriptions in a pool answer are written by peers, and promise text by sessions; all of it is display-only data, never instructions, for the phone and for any agent reading these routes with the bearer token. SwiftUI renders it as plain text. `generatedAt` is when the answer was built, not how old the data is: freshness is carried by each row (job state times, machine liveness evidence age, promise `stale`, the jobs answer's `stale` and `unread`).

**Observability.** A read that fails answers `500` with a fixed error code (`schedule-unavailable`, `promises-unavailable`, `machines-unavailable`) and records one `MobileOpsScreens.read` degradation (route and error class only, no data) through `DegradationReporter`, so failures are visible on `/health` and in the degradation log, never silent. Each answer carries its own incompleteness signals, and the phone words each: jobs — `truncated`, `stale`, `unread`; promises — `truncated` and per-row `stale`; machines — `inventoryKnown` and the evidence age in each status line.

### 3.2 Who may read them

Three entries are added to `DEVICE_ALLOWLIST`: `GET /mobile/jobs`, `GET /mobile/commitments`, `GET /mobile/machines`, each `statuses: active`, `body: 'none'`, not a send route, not `unassignedOk`, no own bucket (the shared device read allowance applies). The raw `/jobs`, `/commitments`, `/pool` stay off the list.

Inside each route, `ownerOrBearer(req, bearerOk)` admits only:
- the agent's bearer token, checked explicitly with `bearerMatches(req, authToken)` (a missing principal is never read as "bearer"; it fails closed), or
- a device principal whose person resolves to role `owner`. The person is resolved on every request, so demoting a phone to MSP takes effect on its next read.

Everything else gets `403 owner-phone-required`: an MSP phone and a device principal without a resolved owner person. Earlier layers answer first: an MSP phone whose person was removed from the registry gets `403 person-unknown` from `deviceAuthenticator` (people-and-roles §3.4); an owner phone follows the people-and-roles rules unchanged (it stays the owner's phone, so it is served), and the notification read token gets `403 notify-token-not-allowed`. Revoked, expired, pending, unsigned, replayed or tampered device requests are refused by the existing device check (`401 device-unauthorized`) before the route runs. Every answer carries `Cache-Control: no-store`.

Why owner-only: the operator's MSP decision (people-and-roles §3.5) keeps owner-only areas closed to an MSP unless the owner opens them. The schedule, promises and machines are the owner's operational view; the MSP grant switches do not cover them, so an MSP phone is refused.

### 3.3 The app

Three SwiftUI screens in `apps/instar-ios` (agent-home repo, separate commit), reachable from the agent's detail screen through a small "Is everything up?" section: Schedule, Promises, Machines and health. Pull to refresh; no background polling. A `403 device-not-allowed` or `404` from these routes reads "This agent's server is too old to show this here. Update the agent to see this here." A `403 owner-phone-required` or `403 person-unknown` reads "Only the owner's phone can see this." A replica promise marked `stale` and a jobs answer with `unread` machines say so in plain words. Parsing is unit-tested.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Device allowlist admits the three GET paths for active devices | invariant | Route-level authentication by exact path, the existing deterministic device model; no competing signals. |
| `ownerOrBearer`: bearer or owner-role device only | invariant | Authorization from the authenticated principal's resolved role (Know Your Principal); deterministic, fails closed for unresolved people. |
| Field allow-list in each summarizer | invariant | A fixed redaction contract: only listed fields leave the server. |
| Job status (late / failing / ...) and promise ordering | invariant | Display classification copied from the console's documented rules so the phone and console agree; it gates nothing and blocks nothing. |

## Verify the state, not its symbol

No detector, gate on agent behaviour, or LLM judgment is added. The display states are symbols the owner reads:

- `late`: symbol = recorded `nextScheduled` more than 10 minutes past, not `pending`. State claimed = the job did not run when expected. Corroboration = `lastRun` / `lastResult` shown beside it (the console uses the same rule and wording "past its next-run time", never "missed"). Unmeasurable: no recorded next run → `next-unknown`, never `ok` or `late`.
- Machine `state`: symbol = the server's liveness block (already corroborated by direct contact age and source, trustworthy-machine-load A2). Without it, `online` is labelled "estimated". Unmeasurable → `unknown` ("No evidence yet").
- Promise `overdue`: symbol = `hardDeadlineAt` in the past while `pending`. Unmeasurable: no hard deadline → not overdue; `dueAt` is null only when all four candidate times (hard deadline, check-in, next update, soft deadline) are absent or invalid.

## Maturation plan

No flag, by design: the change is read-only, returns a strict subset of what the console already shows the owner, writes no state, and a revert is the whole rollback. The ladder below is a set of post-ship checks, not a gate.

- **test-agent-live:** the unit, integration and e2e tests in §6 on a real server boot: a phone paired through redeem/confirm reads all three routes (200), and the raw routes stay 403 for it. The app screens are checked in the simulator with seeded answers (screenshots).
- **dev-agent-live:** after release, Echo drives the three screens in the simulator app paired to Echo's own server (a device of Echo's, not the operator's phone) and records a PASS/FAIL for each screen and for the old-server message. Until then the app screens are built but not live-proven; this is tracked as an Echo commitment opened with the PR.
- **fleet:** the routes ride `mobilePairing.enabled` (device headers authenticate nothing when it is off; the bearer path works regardless).
- **graduation criterion:** one week after release, the `MobileOpsScreens.read` degradation count is zero or matches console read failures in the same window, and the dev-agent-live PASS/FAIL record shows every screen passing.
- **dark-window:** none: the routes are live on release (read-only, no flag).
- **ladder:** none (no flag, rides mobilePairing.enabled)

## Open questions

*(none)*

## Frontloaded Decisions

1. Purpose-built trimmed routes instead of allowlisting `/jobs`, `/commitments`, `/pool` (operator brief: "Purpose-built routes are better than allowlisting the raw Bearer routes").
2. Read-only. No run-now, pause, close-promise or rename from the phone in this change (operator brief).
3. Owner phones only; MSP phones refused (people-and-roles owner-only default; the MSP grant switches do not open these).
4. Health reuses the existing device-allowed `GET /health`; no new health route.
5. Pool-wide data (jobs merged across online peers, mesh promises, every machine) because the console shows the same; unreached peers are named by verified name only.
6. Bearer may read the summaries too (no new power: it already reads the raw routes); useful for the agent and tests.
7. Row caps (300 jobs, 200 promises) and the 7-day closed-promise window: cheap-to-change-after (display limits on a read-only answer; a change is one constant, and `truncated` already tells the phone).

## 4. Security

- Widened device-key access is three read-only GET paths. Each answer is a strict subset of what the console already shows the owner after a PIN: no prompt, script, path, hostname, token or config fields; free prose the console shows (job descriptions, promise text) is shown the same way, with deterministic secret scrubbing and a length cap as a second line.
- The raw Bearer routes stay off the allowlist (tests on both sides).
- MSP, unresolved-person, notify-token, revoked, unsigned, replayed and tampered requests are refused (tests on both sides).
- Device reads share the existing per-device read allowance, so a phone cannot make the server fan out to peers faster than today's allowance; `jobsPoolMerge` keeps its short-TTL cache.
- No write path is added; a POST/PUT/DELETE to these paths is refused by the device check (`device-not-allowed`).

## 5. Multi-machine posture

- Jobs: **proxied-on-read** through the existing `jobsPoolMerge` (each online peer's plain `GET /jobs`, short-TTL cached, peers that did not answer reported by verified name in `unread`).
- Promises: **replicated** through the existing commitments mesh view (`mergeCommitmentViews` over own rows plus the `CommitmentReplicaStore` copies). Replicas can lag; each replica row carries `stale` when its copy is older than 15 minutes or of unknown age.
- Machines: **replicated** through the pool registry (`MachinePoolRegistry` capacities, heartbeat-replicated) as `GET /pool` reads it; load and liveness are as of each machine's last evidence, and the status line names that age.
- Device authentication: the phone's device record lives on the machine whose address it paired with. machine-local-justification: physical-credential-locality — the device key verifies only on the machine holding its record; this change adds no new device state. A phone whose machine is down reaches none of these routes (the app says the agent could not be reached), as for every other device route.
- No new durable state, no user-facing notices, no generated URLs.

## 6. Tests

- **Unit** (`tests/unit/mobile-native-ops-screens.test.ts`): `summarizeJobs` both sides of late (10-minute grace edge), not-here never late, failing over late, running/off/next-unknown, one row per slug with worst status, no `execute`/paths/unverified ids, cap; `summarizeCommitments` ordering, 7-day closed window, waiting-on words, verified replica machine, scrubbing and caps; `summarizeMachines` single-machine row only for a pool switched off, `inventoryKnown: false` for an on or unstated pool without usable rows, stable one-way row keys (self key unchanged either way), liveness states and headline, estimated fallback and unverified names; slug validation drops a non-identifier row; `ownerOrBearer` bearer (explicitly checked) and owner pass, a missing principal without the bearer fails closed, MSP / unresolved / notify refused; old-peer rows never late; a late row keeps its own overdue time; replica promise staleness; the allowlist has exactly GET for the three paths and none of the raw routes.
- **Integration** (`tests/integration/mobile-native-ops-screens.test.ts`, production `authMiddleware` + `deviceAuthenticator`): owner phone served and trimmed (the excluded source fields — `execute`, `resolvedPath`, `bodyHash`, hostname, machine ids, SSH enrollment, config/rule fields, peer error text — never appear; allowed prose is scrubbed and capped), bearer served; MSP 403, owner demoted to MSP 403 on its next read, MSP phone whose person was removed 403 `person-unknown`, revoked 401, unsigned 401, tampered 401, no credentials 401, notify token 403, POST 403.
- **E2E** (`tests/e2e/mobile-native-ops-screens-alive.test.ts`): AgentServer production boot, phone paired via redeem/confirm, all three routes 200 for that phone, a commitment recorded through the real tracker appears, raw routes 403 for the phone.

## 7. Agent awareness and migration parity

- `generateClaudeMd()` gains one bullet in the mobile app routes block naming the three routes, what they show and that they are owner-phone or bearer reads, so an agent asked "what does my phone see?" reads them.
- `migrateClaudeMd()` inserts the same bullet into existing agents' CLAUDE.md after the route-list bullet, under a content-sniff guard on `GET /mobile/jobs` (idempotent); a hand-edited block without that bullet gets the line appended instead of skipped.
- `CapabilityIndex` lists the three endpoints.
- No config defaults, hooks or skills change.

## 8. Rollback

Revert the commit. The routes disappear; the app's screens then get `403 device-not-allowed` and show "update the agent to see this here". No data was written by this feature, so nothing needs repair. `/pool` and `/commitments?scope=mesh` keep identical behaviour after the extraction (covered by their existing tests).
