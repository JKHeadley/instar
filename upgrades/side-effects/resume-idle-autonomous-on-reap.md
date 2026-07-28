# Side-Effects Review — Resume an idle autonomous run after an age-limit reap

**Slug:** `resume-idle-autonomous-on-reap`
**Date:** `2026-06-14`
**Author:** `echo`
**Spec:** `docs/specs/resume-idle-autonomous-on-reap.md` (converged + approved)
**ELI16 companion:** `docs/specs/resume-idle-autonomous-on-reap.eli16.md`
**Second-pass reviewer:** required (this change makes the resume queue produce
REAL respawns on a dev agent — a Guard/authority surface). Reviewer concurred.

## Summary of the change

The Mid-Work Resume Queue revives a reaped session only when the reap carried
mid-work evidence. An **age-limit** reap fires precisely when an autonomous
session is IDLE between turns (the idle gate requires an idle prompt + no
non-baseline child processes), so its work evidence is empty by construction —
and the run is never queued for revival. An away-operator's autonomous run then
sits dead until the next inbound message.

The fix: when an `age-limit` reap targets a topic that still has an ACTIVE
autonomous run (`autonomousRunRemainingForTopic(stateDir, topicId) != null`),
the `sessionReaped` wiring appends the TRUE `build-or-autonomous-active` strong
signal to the candidate's evidence and tags the reason
`age-limit (active autonomous run)`. The entry then flows through the EXISTING
one-at-a-time, quota-gated, resurrection-capped, lease-gated machinery — no new
respawn path. A drain-time liveness re-check invalidates the entry
(`autonomous-run-finished`, never a spawn) if the run finished or its window
elapsed between enqueue and drain. The resume queue resolves **live-on-dev**
(`dryRun:false`) and stays observe-only on the fleet.

Files touched:

- `src/core/WorkEvidence.ts` — new exported constant
  `AGE_LIMIT_ACTIVE_RUN_REASON = 'age-limit (active autonomous run)'` (the
  evidence-vocabulary home; imported by server.ts + ResumeQueueDrainer.ts).
- `src/commands/server.ts` —
  (1) the resume-queue `dryRun` config resolves
  `rqCfg.dryRun ?? !resolveDevAgentGate(undefined, config)` (live-on-dev) at the
  single consumption site (config + boot log line);
  (2) the `sessionReaped` candidate construction appends
  `build-or-autonomous-active` + the reason tag when `reason === 'age-limit'` &&
  `topicId != null` && `autonomousRunRemainingForTopic(...) != null` (inside the
  existing enqueue try/catch);
  (3) the ResumeQueueDrainer deps gain `autonomousRunFinished: (topicId) =>
  autonomousRunRemainingForTopic(config.stateDir, topicId) == null`.
- `src/monitoring/ResumeQueueDrainer.ts` — new OPTIONAL injected dep
  `autonomousRunFinished?: (topicId, reason) => boolean` + a `validateReality`
  re-check that returns `autonomous-run-finished` for an entry tagged with the
  age-limit-active-run reason whose run is no longer active. Absent dep ⇒ today's
  behavior (back-compat).
- `tests/unit/resume-idle-autonomous.test.ts` — new (15 tests): admission both
  sides, guard short-circuit, fail-open, dryRun-gate resolution (dev/fleet/explicit),
  drain-time re-check both sides + back-compat + throwing-dep.
- `tests/integration/resume-idle-autonomous-wiring.test.ts` — new (8 tests):
  wiring integrity (real helper delegation), double-spawn lens (live-session +
  uuid-stale), lease lens, revival-loop lens (resurrection cap fires once).
- `tests/e2e/resume-idle-autonomous-lifecycle.test.ts` — new (4 tests): feature
  is alive on dev (dryRun:false through the real AgentServer), enters-and-revives-
  once + no double spawn, fleet observe-only (dryRun:true, would-resume, no spawn).

## Decision-point inventory

- **`sessionReaped` candidate construction (server.ts)** — **modify** — the
  wiring layer that OFFERS a reap to the queue. The fix adds a TRUE evidence
  signal at a SECOND origination site DOWNSTREAM of the SessionManager chokepoint;
  `considerEnqueue` re-clamps via `clampWorkEvidence` and the token is a valid
  `STRONG_WORK_EVIDENCE` member, so the enum invariant holds. Authority unchanged:
  the queue's eligibility/cap/lease gates still decide.
- **`ResumeQueueDrainer.validateReality`** — **modify** — adds one reality check
  (a detector). Strictly additive: it can only ADD an invalidation, never wrongly
  drop a legitimate revival (a throwing/absent dep resolves to NOT-finished, the
  SAFE side).
- **resume-queue `dryRun` resolution** — **modify** — flips the queue from
  observe-only to LIVE on a dev agent. This is the authority change (real respawns
  + real quota spend on Echo). An explicit operator `monitoring.resumeQueue.dryRun`
  still wins; the keys stay CODE-defaulted (no ConfigDefaults write) so the fleet
  flip is preserved.
- **`AGE_LIMIT_ACTIVE_RUN_REASON`** — **new** — a code-internal string constant;
  no external/published surface; reversible by changing one string.

---

## 1. Over-block (a gate refuses legitimate work)

The drain-time re-check can only ADD an `autonomous-run-finished` invalidation,
and only for an entry whose run genuinely returned `null` (completed or window
elapsed) — exactly the case the spec wants NOT revived. A throwing/absent
`autonomousRunFinished` resolves to NOT-finished, so a transient state-read error
never blocks a legitimate revival. No over-block on the kill path: the augmentation
sits inside the existing enqueue try/catch and a throw fails toward no-injection
(status-quo no-revive), never toward endangering the reap.

## 2. Under-block (a gate lets through what it should stop)

Double-spawn is the #1 lens: an age-limit entry is an ordinary topic-bound entry
once admitted, so `validateReality`'s `live-session-exists` + `resume-uuid-stale`
catches catch a message-revive that happened between enqueue and drain (named
tests in the integration tier — both ZERO respawn). The resurrection cap reads
`tombstoneFor(stableKey)` (derived purely from topicId), never `workEvidence`, so
the injected evidence CANNOT reset or evade the cap (named test). Only the literal
`age-limit` reason is augmented — watchdog-stuck/idle-zombie/context-wedge/AUP-wedge
and moved-topic reaps stay excluded.

## 3. Reversibility

`dryRun` flips back to observe-only by setting `monitoring.resumeQueue.dryRun: true`
(or via the fleet default). The reason tag + evidence injection is a one-string +
one-evidence-name change. The drainer dep is OPTIONAL — removing it restores prior
behavior. NOTE: flipping `dryRun` back does NOT un-spend quota already burned by a
respawn that already fired — see Frontloaded Decision D1 (classified NON-cheap,
accepted under the named live phase).

## 4. Blast radius / interactions

The augmentation runs ONLY on `age-limit` reaps (the cold-path
`autonomousRunRemainingForTopic` read is behind the `reason === 'age-limit'`
short-circuit), so every other reap pays zero added cost. It reads the LOCAL
autonomous-run state file (same vantage that admitted the entry). Coupling risk
(D2): if a future maintainer narrows `build-or-autonomous-active` to mean strictly
"a live child build process", this reuse silently breaks — flagged here.

## 5. Multi-machine (Phase-C) posture

Machine-local by design: the resume queue is per-machine (single-writer lock), the
age-limit reap is observed on the machine the session ran on, and only the
lease-holder drains it (`validateReality` returns `topic-owner-elsewhere` otherwise
— named test). A run MOVED to another machine reaches the queue as `topic moved …`
(already `eligible:false`), not `age-limit`, so it is never double-revived.

## 6. Migration parity

NONE required — and that is correct. The `dryRun` resolution is a CODE default read
at server boot, not a persisted `.instar/config.json` field, so existing agents pick
it up on their next restart after update. A `migrateConfig` entry would freeze
`dryRun` to disk and break the later fleet flip — the resume-queue keys must stay
un-frozen in ConfigDefaults. No CLAUDE.md template change (internal plumbing, no new
route or user-facing capability).

## 7. Signal vs. authority

The injected `build-or-autonomous-active` is a TRUE assertion about the world
(the run is genuinely in-flight per the un-elapsed state file), supplied from the
one vantage that can observe it — the opposite of lying to a classifier. The
drain-time re-check is a detector that feeds the existing invalidation authority;
it never spawns. The only authority change is the `dryRun` flip, which is bounded
by the existing one-at-a-time / calm-ticks / quota / lease / resurrection-cap gates.
