# Side-Effects Review — Sessions a restart ended are listed (restart-lock-continuity part A)

**Version / slug:** `restart-lock-continuity-a`
**Date:** `2026-11-18`
**Author:** `echo (echo-topic-144503)`
**Second-pass reviewer:** `independent subagent (session lifecycle touched)`

## Summary of the change

Before the boot purge rewrites the records of sessions that died with the previous boot, each agent writes a census of the records that were alive (running or starting, started before this OS boot) to `state/boot-session-census/<bootAt>.json`. It writes once per OS boot; a server restart in the same boot keeps the first file. The census is classified from each session's own record, by id:
- `ended`, `ended (unconfirmed)` or `running`;
- marked `open work`, `autonomous (reconciler)`, `autonomous (reconciler dark)`, `none` or `unknown`;
- labelled by age, with `topicCurrentlyActive`.

It is served at `GET /sessions/boot-census` (with `?since=`), with `POST /sessions/boot-census/reviewed` for the daily reader. Fifteen minutes after start, one degradation per boot names ended sessions with open work that have not come back. Files are kept until reviewed; a backlog over 200 is reported and nothing is dropped. Files: `src/core/BootSessionCensus.ts` (new), `src/commands/server.ts`, `src/server/routes.ts`, `src/data/awareness/boot-session-census.md`, and tests. Spec: `docs/specs/restart-lock-continuity.md` part A, converged in 6 rounds and approved by the Chief of Staff (msg 4f877632).

## Decision-point inventory

- **Census membership.** Invariant: a reading of record status and `startedAt`. It blocks nothing.
- **Open-work mark.** A reading from the existing `commitmentQualifies` predicate, without the 6-hour creation window. It starts nothing.
- **Notice.** Once per boot, through the existing degradation path.

## 1. Over-block

None: nothing is blocked. The census only reads.

## 2. Under-block

- A session whose record was already rewritten before this code runs is not in the census. The census sits immediately before `purgeDeadSessions`, and nothing earlier rewrites a dead session's record.
- A Mac whose boot time cannot be read writes no census, and the route says so.

## 3. Level-of-abstraction fit

- The census lives in the session layer at the purge, the one place every machine passes through at boot. That covers the M5 too, where machine maintenance is off.
- It reuses `parseBootTime`, `commitmentQualifies`, `DegradationReporter` and `SafeFsExecutor`.

## 4. Signal vs authority compliance

Signal only. No decision gains authority; the notice is informational.

## 4b. Judgment-point check

- The open-work mark reuses the existing predicate.
- The 15-minute settle and the 200-file backlog limit are constants from the approved spec.

## 5. Interactions

- **Purge:** runs before `purgeDeadSessions` and only reads.
- **Resume queue:** none in phase 1; the route does not depend on it.
- **Autonomous reconciler:** its topics are marked, never doubled.
- **DegradationReporter:** the feature key includes the boot time, so the per-feature mute cannot hide a later boot's notice.

## 6. External surfaces

- Two new routes, both behind bearer auth: `GET /sessions/boot-census` and `POST /sessions/boot-census/reviewed`.
- One owner-facing degradation at most per boot.
- A new state folder.

## 6b. Operator-surface quality

The notice is one sentence. It names the topics, says what happens now (they resume on the next message), and says that automatic revival is phase 2.

## 7. Multi-machine posture

- **Machine-local by design** (`hardware-bound-resource`): the census describes this machine's own tmux sessions.
- It is readable from any machine through that machine's own route.

## 8. Rollback cost

- Revert the change. The census folder is inert to old code and can be left in place.
- No migration and no config keys.

## Conclusion

Low risk, read-only, and live on release. It fixes item 7's silence and does not try revival.

## Second-pass review (if required)

Concern raised (independent reviewer): (1) POST /sessions/boot-census/reviewed had no try/catch, so a failed write could become an unhandled rejection and restart the agent; (2) the route passed no machine id to the open-work predicate while the notice passed cjOwnMachineId, so a peer-replicated commitment counted on one and not the other. Both fixed: try/catch with operatorError; both paths use the mesh self id. Re-check: see below.

## Evidence pointers

- `tests/unit/boot-session-census.test.ts`: 13 pass locally.
- `tests/integration/boot-census-routes.test.ts` and `tests/e2e/boot-census-wiring.test.ts`: for Local Verify.
Re-check: "Concur with the review. Both fixes are correct, and I found nothing new."
