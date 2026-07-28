---
status: approved
approved: true
approval-provenance: "Justin session pre-approval, topic 13481 (autonomous instar-dev session)"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
review-convergence: "2026-06-14T08:09:22.451Z"
review-iterations: 2
review-completed-at: "2026-06-14T08:09:22.451Z"
review-report: "docs/specs/reports/resume-idle-autonomous-on-reap-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 4
contested-then-cleared: 1
---

# Resume an idle autonomous run after an age-limit reap

## The gap

The Mid-Work Resume Queue (`ResumeQueue` + `ResumeQueueDrainer`) is the durable
session-revival mechanism: a reaped session is queued, and the drainer brings
reaped sessions back ONE AT A TIME, quota-gated, with a loud resurrection cap
(`maxResurrections`, default 2) that gives up after N revivals in a 24h window.

Admission is decided by `ResumeQueue.considerEnqueue` →
`classifyEligibility` → `evidenceEligible(workEvidence, topicBound)`
(`src/core/WorkEvidence.ts`). A reap is resume-eligible only when it carries
≥1 STRONG work-evidence signal (or, for a topic-bound session, ≥2 distinct
WEAK signals). `midWork` is just `isMidWork(workEvidence)` — any non-marker
evidence.

The **age-limit** reap path (`SessionManager`, `terminateSession(id,
'age-limit', …)`, line ~1336) fires precisely when an autonomous session is
**truly IDLE between turns** past its per-session lifetime cap. The idle gate
(`SessionManager` §"truly idle") requires the terminal to show an idle prompt
AND no non-baseline child processes — i.e. at the reap moment there is NO
running build process, NO pending injection, NO active subagent. So the
collected `workEvidence` is empty (or only weak/marker), `evidenceEligible`
returns false, and the session is **NEVER enqueued for revival**.

Consequence: an autonomous run whose session is age-reaped while the operator
is AWAY sits dead until the next inbound message wakes it. The age-limit reap
is a **recycle** of a long-lived session (hygiene — keep sessions from running
unbounded), not a signal that the *work* is finished. The work — the
autonomous run — is still live in `.instar/autonomous/<topicId>.local.md`.
PR #1155 (merged) fixed the misleading user-facing NOTICE for this case; THIS
spec closes the behavioral gap behind it: the run should actually come back.

## The fix

When an `age-limit` reap targets a topic that has an **ACTIVE autonomous run**,
admit it to the resume queue REGARDLESS of `midWork`/evidence — **the live run
IS the work evidence.**

### The `autonomousRunRemainingForTopic` contract (the predicate)

The fix's trigger is `autonomousRunRemainingForTopic(stateDir, topicId)`
(`src/core/AutonomousSessions.ts`, added by PR #1155) returning **non-null**.
Its exact contract — verified against the code, so the predicate's meaning is
unambiguous (codex finding 1):

- Returns `{ active: true, remainingSeconds }` ONLY when the topic's autonomous
  job file (`<stateDir>/autonomous/<topicId>.local.md`) reports `active: true`,
  has a parseable `started_at`, has a `duration_seconds`, AND
  `remainingSeconds > 0` (`duration_seconds − elapsed`).
- Returns `null` — i.e. NOT a continuation, NO synthetic evidence — when: the
  job is absent/`active:false`; `started_at` is unparseable (`NaN`); fields are
  missing; OR **the run is already past its own window** (`remainingSeconds <=
  0`). A run past its window is deliberately NOT revived — the terminal death
  copy stands for it. This is the structural self-expiry that bounds the
  stale-marker residual (below): a genuinely-finished run whose duration window
  has elapsed gets `null` and is never re-admitted, even before the cap.

"Remaining" therefore means **last-known-incomplete within an un-elapsed
duration window** — not "actively producing output this second" (the session is
idle between turns by construction at the age-limit reap). The freshness bound
is the duration window itself.

### Mechanism (minimal, reuse-only)

1. The `sessionReaped` handler in `src/commands/server.ts` already computes the
   topic id and offers every terminal autonomous reap to
   `resumeQueue.considerEnqueue(...)`. We extend ONLY the candidate
   construction there: when `reason === 'age-limit'` AND
   `autonomousRunRemainingForTopic(config.stateDir, topicId)` returns non-null,
   we append a NEW strong-evidence signal — `build-or-autonomous-active` is
   reused (it already exists in `STRONG_WORK_EVIDENCE` and exactly names this
   condition) — to the candidate's `workEvidence`, and tag the reason
   `age-limit (active autonomous run)`.

   **This is a TRUE assertion about the world, not synthetic evidence to game a
   gate.** At the age-limit reap moment the run is genuinely in-flight (the
   state file reports an un-elapsed window); the idle-gate simply cannot observe
   it as a child process — it kills *precisely* when process-based evidence is
   absent by construction. The reaper supplies the missing TRUE signal from the
   one vantage that can observe the run state (the topic id + the state file).
   This is the sanctioned response to an evidence-collection blindspot
   (parent-principle's "record schema is your perception" corollary), the
   opposite of lying to the classifier.

   **Guard ordering + fail-open (load-bearing).** The `autonomousRunRemainingForTopic`
   call sits BEHIND the `reason === 'age-limit'` short-circuit (`&&`), so it
   runs ONLY on age-limit reaps — every other reap (completion,
   recovery-bounce, operator close, watchdog, idle-zombie) pays ZERO added
   cost. The call sits INSIDE the existing enqueue-hook `try/catch` (which
   already wraps `considerEnqueue`): a throw fails toward NOT injecting evidence
   (status-quo no-revive), NEVER toward a spawn and NEVER toward endangering the
   kill path. This mirrors the existing ReapNotifier `autonomousRunActiveFor`
   gate (`server.ts`, `event.reason === 'age-limit'`), which already makes this
   exact call once per age-limit reap — so the cost is an already-paid cold-path
   read on a non-hot event handler.

   **Second evidence-origination site (clarity).** `WorkEvidence.ts` advertises
   a single chokepoint (`SessionManager.terminateSession`) that clamps evidence
   to the enum. This injection adds evidence at the WIRING layer (the
   `sessionReaped` handler) DOWNSTREAM of that chokepoint. The invariant still
   holds: `considerEnqueue` re-clamps via `clampWorkEvidence`, and
   `build-or-autonomous-active` is a valid `STRONG_WORK_EVIDENCE` member, so it
   passes through cleanly with no drift. This is a deliberate SECOND
   origination site, justified by the re-clamp gate — documented here so a
   future reader does not assume the chokepoint is the sole source.

   This makes `evidenceEligible` admit the candidate through the EXISTING
   eligibility path. No new admission branch, no new respawn path: the entry
   flows through the same one-at-a-time, quota-gated, resurrection-capped,
   lease-gated machinery as any other resume-queue entry.

   **Drain-time liveness re-check (structural close of the stale-marker
   window).** Inside `ResumeQueueDrainer.validateReality`, for a topic-bound
   entry tagged with the `age-limit (active autonomous run)` reason, re-read
   `autonomousRunRemainingForTopic(stateDir, topicId)`; if it now returns
   `null` (the run completed OR its window elapsed between enqueue and drain),
   invalidate the entry (`invalidated:autonomous-run-finished`) — never a
   spawn. This is strictly additive (one file read, the same fail-to-safe-side
   pattern as the other `validateReality` checks) and closes the
   window-elapsed/completed subset of the stale-marker residual structurally,
   rather than spending a resurrection slot to discover it (P14 spirit:
   re-verify the cause, don't trust the symptom-reset). It does NOT subsume the
   resurrection cap (a still-open-window stale marker returns the same "active"
   answer) — the cap remains the hard ceiling for that subset.

2. ONLY `age-limit` qualifies (the recycle case). The genuine-death /
   genuine-wedge reaps are explicitly EXCLUDED and stay excluded:
   - `watchdog-stuck` → already `eligible:false` (`watchdog-kill`); resuming
     recreates the wedge.
   - `idle-zombie` → a session proven dead; not a recycle of live work.
   - context-wedge / AUP-wedge respawns → owned by the ContextWedgeSentinel's
     fresh-respawn path, not the resume queue.
   The new evidence is injected ONLY on the literal `age-limit` reason, so no
   other reap reason is affected.

3. **Live-on-dev (no-dark-on-dev directive, topic 13481).** The resume queue
   ships `dryRun: true` (observe-only) fleet-wide so the drainer audits
   `would-resume` and never spawns. To actually EXERCISE this on Echo (a real
   2-machine dev setup), the `dryRun` default resolves to `false` on a
   development agent and stays `true` on the fleet — mirroring the dev-gating
   pattern used for the stateSync stores (#1151/#1153, `resolveDevAgentGate`).
   The resolution happens at the single consumption site
   (`server.ts`, `dryRun: rqCfg.dryRun ?? !resolveDevAgentGate(undefined, config)`),
   so an explicit operator `monitoring.resumeQueue.dryRun` still wins and the
   resume-queue keys stay CODE-defaulted (never frozen into ConfigDefaults,
   preserving the later fleet flip).

   **NOT registered in `DEV_GATED_FEATURES`** (integration finding). That
   registry's both-sides wiring test asserts the gated flag resolves to
   *feature-is-LIVE = true* on dev. This gate is INVERTED — it rides `dryRun`,
   where `true` means observe-only (NOT live). Registering it would make the
   wiring test assert the semantic opposite of every other entry (`true` =
   "dry-run on" rather than "feature live"), poisoning the registry's
   reviewer-checkable contract. Unlike `topicProfiles`/`credentialRepointing`
   (which carry a separate `enabled`-via-gate flag and a SECOND `dryRun` field
   the gate doesn't touch), the resume queue's `enabled` defaults `true` for
   everyone and the gate rides `dryRun` directly. Instead, a **dedicated
   purpose-named unit test** locks the resolved `dryRun` VALUE directly: dev
   config → `dryRun === false`; fleet config → `dryRun === true`; explicit
   `monitoring.resumeQueue.dryRun: true` still wins on dev. This tests the
   actual field semantics, not an inverted proxy.

   **Migration: NONE — and that is correct (Migration Parity).** The resolution
   is a CODE default read at server boot, not a persisted `.instar/config.json`
   field, so existing agents pick it up on their next server restart after
   update. A `PostUpdateMigrator`/`migrateConfig` entry would be actively WRONG:
   it would freeze `dryRun` to disk and break the later fleet flip the
   ConfigDefaults comment protects. The resume-queue keys must stay un-frozen
   in ConfigDefaults.

   **Observe live-on-dev** via `logs/resume-queue.jsonl` (`would-resume` →
   `respawned` / `invalidated:*` events) and `GET /sessions/resume-queue`; the
   `age-limit (active autonomous run)` reason tag distinguishes these entries
   from any other resume-queue entry.

## Frontloaded Decisions

Every fork the building agent would otherwise stop to ask about, resolved here
(operator pre-approval, topic 13481 autonomous session) with its
cheap/non-cheap classification under the closed taxonomy (durable external
side-effects / money / identity / published interface → NEVER cheap).

| # | Decision | Resolution | Class |
|---|----------|------------|-------|
| D1 | Make the resume queue **live-on-dev** (`dryRun:false`) | Yes — operator no-dark-on-dev directive | **NON-CHEAP, accepted under a named live phase.** It produces REAL respawns on Echo (durable side-effects) + REAL quota spend (money). The fleet dark-gate gives ZERO protection on the dev machine — that is exactly where it runs. The mitigations (one-at-a-time, calm-ticks, quota gate, resurrection cap) BOUND the blast radius but do NOT make a respawn-already-fired reversible. Flipping `dryRun` back does not un-spend the quota already burned. Accepted because the operator explicitly authorized live exercise on the dev agent; NOT labeled "cheap because ships dark." |
| D2 | Reuse `build-or-autonomous-active` vs. mint a new evidence signal | Reuse | **Cheap.** Internal code-only label feeding an internal predicate; no external/published surface; reversible by changing one string. (Coupling risk noted: if a future maintainer narrows the token's meaning to "a live child build process," this reuse silently breaks — flagged in the side-effects review's Interactions dimension.) |
| D3 | ONLY `age-limit` qualifies (exclude idle-zombie / watchdog-stuck / context-wedge / AUP-wedge) | age-limit only | **Cheap.** A `reason === 'age-limit'` guard; excluding more is always the safe direction. |
| D4 | A run MOVED to another machine reaches the queue as `topic moved …` (already ineligible), not `age-limit` | Derived (no fork) | n/a — consequence, documented in Phase-C posture. |
| D5 | Accept reviving a logically-finished-but-state-says-"remaining" run | Accept (revive-once) | **Cheap (accepted residual).** Bounded by the drain-time liveness re-check (window-elapsed/completed subset) + the resurrection cap (still-open-window subset); revived session can self-terminate; cost of a wrong call is one capped, quota-gated respawn. |
| D6 | Single consumption-site `dryRun` resolution + keep resume-queue keys CODE-defaulted (out of ConfigDefaults) | As designed | **Cheap.** Code-internal; reversible; preserves the fleet flip (a ConfigDefaults write would freeze it). Same decision as D1 viewed from the config layer. |

## Load-bearing safety invariants

All four are satisfied by EXISTING machinery; this section is the audit that
proves each is covered (and names the test that locks it).

### 1. No double-spawn (THE #1 blocker lens)

If the session already revived via an inbound message before the queue drains
it, the queue must NOT spawn a second one.

- **Enqueue dedup**: `considerEnqueue` refuses a second open entry for the same
  `stableKey` (`duplicate-open-entry`) — one open entry per topic.
- **Drain-time reality validation (R2.6)**: `ResumeQueueDrainer.validateReality`
  runs IMMEDIATELY before any spawn and returns `live-session-exists` (→
  `invalidated`, never a spawn) when `liveSessionForTopic(topicId)` is true.
  A session revived by a message between enqueue and drain is caught here.
- **resume-uuid-stale**: if the topic's resume UUID has moved on since enqueue,
  the entry invalidates rather than spawning onto a stale conversation.

These already cover an age-limit-admitted entry identically to any other entry
(the entry is an ordinary topic-bound entry once admitted). Validation is
co-located with the spawn inside a single serialized drainer tick (the
`ticking` guard), so there is no enqueue→drain→spawn window where a live
session is invisible. **Tests** (two, to lock BOTH catches): (a) admit an
age-limit active-run entry, mark the topic's session live (`liveSessionForTopic
→ true`), drain, assert `invalidated:live-session-exists` with ZERO respawn;
(b) mark the topic's resume UUID moved on (a message-revive saved a new UUID),
drain, assert `invalidated:resume-uuid-stale` with ZERO respawn.

### 2. No revival loop

A run that keeps getting age-reaped-and-revived must hit the EXISTING
resurrection cap and give up LOUDLY.

- `considerEnqueue` consults `tombstoneFor(stableKey)`; a re-reap after a
  successful resume within the 24h `RESURRECTION_WINDOW_MS` increments
  `resurrections`, and at `maxResurrections` returns `resurrection-cap`,
  raising ONE aggregated attention item via `raiseAggregated`.
- An age-limit active-run entry carries the same `stableKey` (`topic:N`,
  derived purely from topicId — independent of evidence/reason), so it shares
  the same tombstone and is capped identically. The synthetic
  `build-or-autonomous-active` evidence touches ONLY `workEvidence`; the cap
  check reads `tombstoneFor(stableKey)`, never evidence — so the injected
  evidence CANNOT reset or evade the tombstone.
- **The manual `requeue` override is the ONLY path past the cap** and remains
  operator-gated: it grants exactly ONE additional revival per invocation and
  is audited, after which the next re-reap re-caps. The cap bounds every
  *automatic* loop; a re-armed loop requires a deliberate, audited,
  one-at-a-time operator action.
- **Test**: drive the same topic through resume → re-age-reap →
  resume → re-age-reap until the cap; assert the final enqueue returns
  `resurrection-cap` and `raiseAggregated('resurrection-cap', …)` fired exactly
  once at the cap.

### 3. Lease-holder-only (Phase-C, N-machine)

Revival happens only on the machine that holds the lease for the topic — never
double-revive across machines.

- `validateReality` returns `topic-owner-elsewhere` (→ `invalidated`, no spawn)
  when `topicOwnerElsewhere(topicId)` is true. Revival therefore proceeds only
  on the owning/lease-holder machine; a standby that enqueued the same reap
  invalidates at drain.
- This is unchanged by the fix (an age-limit entry is an ordinary topic-bound
  entry) and is asserted in the existing drainer suite; the integration test
  adds a `topicOwnerElsewhere → true` case for an age-limit active-run entry.

### 4. Resource pressure

Revival stays gated on the existing quota / calm-machine checks (don't revive
into a starved box).

- `ResumeQueueDrainer.gateBlock` requires `requiredCalmTicks` consecutive calm
  ticks AND a non-critical pressure tier before any spawn; the drainer reads
  pressure and treats an unreadable tier as `critical` (no spawn). An age-limit
  active-run entry is subject to the identical gate. Unchanged by the fix.

## Phase-C (N-machine) posture

**Multi-machine posture: machine-local by design, lease-gated.** The resume
queue is per-machine (single-writer lock on `<stateDir>/state/resume-queue.lock`).
The age-limit reap is observed on the machine the session ran on, and only the
lease-holder for the topic actually drains it (invariant 3). No new
cross-machine state is introduced; `autonomousRunRemainingForTopic` reads the
LOCAL autonomous-run state file (the run lives on the same machine as the
session). A topic whose run was MOVED to another machine reaches the resume
queue as `topic moved …` (already `eligible:false`, `topic-moved`) — not
`age-limit` — so a moved run is never double-revived here.

## Test plan (3 tiers — Testing Integrity Standard)

- **Unit (admission, both sides):** `classifyEligibility` / the candidate-build
  path admits an `age-limit` reap with an active run (synthetic
  `build-or-autonomous-active` ⇒ `eligible:true`) AND refuses an `age-limit`
  reap with NO active run (`autonomousRunRemainingForTopic → null` ⇒ empty
  evidence ⇒ `insufficient-evidence`). Plus: the guard short-circuits — assert
  `listAutonomousJobs`/`autonomousRunRemainingForTopic` is NOT called for a
  non-`age-limit` reap (completion / recovery-bounce), and a throwing state
  read fails toward no-injection (no spawn, kill path intact).
- **Unit (dryRun gate, dedicated — NOT via `DEV_GATED_FEATURES`):** the
  resolved `dryRun` value at the consumption site is `false` under a dev-agent
  config, `true` under a fleet config, and an explicit
  `monitoring.resumeQueue.dryRun: true` still wins on a dev agent.
- **Unit (drain-time liveness re-check):** an entry tagged `age-limit (active
  autonomous run)` whose `autonomousRunRemainingForTopic` now returns `null`
  invalidates `autonomous-run-finished` with ZERO respawn.
- **Integration (real composition):** a real `ReapNotifier` + `ResumeQueue` +
  `ResumeQueueDrainer` + autonomous-run state file. (1) double-spawn lens (a)
  `live-session-exists` and (b) `resume-uuid-stale` — both ZERO respawn;
  (2) revival-loop lens — drive to the resurrection cap, assert
  `resurrection-cap` + exactly one aggregated attention item; (3) lease lens —
  `topicOwnerElsewhere → true` ⇒ `topic-owner-elsewhere`, ZERO respawn;
  (4) operator-stop-after-enqueue ⇒ `operator-stop`, ZERO respawn.
- **E2E (the "feature is alive" test):** the production init path (mirroring
  `server.ts`) with `developmentAgent: true` ⇒ the resume queue boots
  `dryRun:false`; an age-reaped active-run session ENTERS the queue and revives
  exactly ONCE (a second drain after the revive does NOT spawn again). A fleet
  config boots `dryRun:true` (observe-only, `would-resume` audited, no spawn).

## Residual risks (accepted)

- **Idle vs. genuinely-finished autonomous run.** An autonomous run that has
  *logically* completed but whose state file still reads "remaining" would be
  revived at most once. Bounded on BOTH sides now: (a) the **window-elapsed /
  completed-by-drain** subset is closed STRUCTURALLY by the drain-time
  `autonomousRunRemainingForTopic == null → invalidate:autonomous-run-finished`
  re-check — no spawn, no resurrection slot spent; (b) the **still-open-window**
  subset (the state file says "remaining" but the run has logically finished
  while its duration window is genuinely un-elapsed) revives once, the revived
  session resumes via continuation prompt and can observe its own completion
  and stop, and the resurrection cap halts any loop. NOTE for the cap message:
  if the cap fires on an `age-limit (active autonomous run)` entry, the likely
  root is a stale `remaining` marker, not "something keeps killing it" — the
  aggregated attention item's generic copy may mislead; a follow-up could
  special-case it. The safe direction is to revive (the run can self-terminate)
  rather than to silently abandon live work — consistent with the parent
  principle.
- **Topic-resolution race.** If `getTopicForSession` returns null at reap time
  (the session de-registered from the topic map before the `sessionReaped`
  event fired), `topicId` is null → the active-run check is skipped → the run
  is NOT revived. This fails to the SAFE side: it is the pre-fix behavior (the
  run waits for the next inbound message), NEVER a double-spawn. Accepted.
- **Dev-live blast radius.** Live-on-dev means real respawns on Echo (durable
  side-effects + real quota — see Frontloaded Decision D1, classified NON-cheap
  and accepted). Mitigated by: one-at-a-time, calm-ticks + quota gate,
  resurrection cap, the drain-time liveness re-check, and the dry-run-on-fleet
  default (the fleet remains observe-only until a deliberate flip). Observe via
  `logs/resume-queue.jsonl` + `GET /sessions/resume-queue`.
- **Poisoned autonomous-run state file (in-trust-boundary, bounded).** A party
  who can write `<stateDir>/autonomous/<topicId>.local.md` can forge an "active
  run" — but that is the same trust boundary as the entire state dir (an
  attacker there already owns the agent), the forged file can only revive the
  topic that was ACTUALLY reaped (topicId comes from the session map, not the
  file — no cross-topic pivot), and the revival still passes `validateReality`
  + the quota/lease/cap gates. Worst forgeable outcome: one capped respawn of
  the legitimately-reaped topic. `summarize()` already clamps
  `duration_seconds`/`iteration` to `^\d+$`; defense-in-depth clamp of an
  absurd `duration_seconds` is optional (the cap already halts any loop).
  Accepted, consistent with the file-based-state trust model.
