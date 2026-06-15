---
status: approved
approved: true
approval-provenance: "Justin session pre-approval, topic 13481 (autonomous instar-dev session, 2026-06-14): 'You have my pre-approval for all decisions needed. Please do NOT stop for me if at all possible.'"
parent-principle: "Close the Loop — a safety pause must never become a silent permanent feature death; Agent owns follow-through, never a manual lever the user must remember"
eli16-overview: "resume-queue-stale-emergency-pause.eli16.md"
review-convergence: "2026-06-14T16:39:23.203Z"
review-iterations: 6
review-completed-at: "2026-06-14T16:39:23.203Z"
review-report: "docs/specs/reports/resume-queue-stale-emergency-pause-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 5
cheap-to-change-tags: 1
contested-then-cleared: 0
---

# Resume queue: a stale emergency-stop pause must not silently strand active autonomous runs forever

## The gap (proven from a real 2026-06-14 incident)

On 2026-06-14, Echo's autonomous run on topic 13481 went silent for ~4 hours. The
forensic chain (from `logs/reap-log.jsonl`, `logs/resume-queue.jsonl`, and
`GET /sessions/resume-queue`):

1. **2026-06-13 17:48 UTC** — a Telegram message was LLM-classified `emergency-stop`
   by the MessageSentinel. The handler (`routes.ts`, the `classification.category ===
   'emergency-stop'` branch) did three correct things and one over-broad thing:
   - killed the matched session (correct),
   - cleared that topic's autonomous job (correct),
   - `cancelByTopic(topicId)` on the resume queue so the stopped topic can't be
     resurrected (correct),
   - **`resumeQueue.pause('message-sentinel emergency stop')` — a GLOBAL pause** that
     freezes revival for *every* topic, indefinitely, with no expiry and no re-arm.
2. The pause was **never lifted**. Nothing in the system clears it; the only
   documented recovery is the operator manually calling
   `POST /sessions/resume-queue/resume` (and a quiet `paused:true` in the GET).
3. **2026-06-14 12:04 UTC** (~18h later) — `instar-exo` (topic 13481) hit its
   per-session age cap and was reaped while *idle between turns* during an ACTIVE
   autonomous run. The resume-idle fix (`resume-idle-autonomous-on-reap.md`, #1157)
   worked exactly as designed: the session was **admitted to the resume queue** with
   `reason: 'age-limit (active autonomous run)'`, `status: 'queued'`.
4. But **a paused queue admits and never drains** — `ResumeQueueDrainer.tick()`
   returns `{ blocked: 'paused' }` at the top, before any work. So the queued
   revival never fired. The session sat dead until the operator messaged ~4h later.

The honest-wording fix (#1155) and the admit-active-run fix (#1157) both did their
jobs. The residual gap is structural: **a single emergency stop — even a stale one,
on an unrelated topic, issued long before the work it now blocks even existed —
permanently and silently disables the safety net that is supposed to revive
recycled autonomous runs.** This is the live behavioral cause behind the operator's
recurring "why do my sessions keep dying?"

## Why the global pause is safe to relax (the key insight)

**The MessageSentinel emergency-stop is TOPIC-SCOPED in its real intent — verified
from the code, not assumed (review finding, round 3 — codex #1).** The handler lives
at `routes.ts` (the `classification.category === 'emergency-stop'` branch on the
lifeline-forward path, ~L14695). The "stop everything" message arrives ON A SPECIFIC
TOPIC, and every action the handler takes is bound to THAT topic:
- it kills ONLY the matched topic's session (`sessionName` is resolved from `topicId`);
- it clears ONLY that topic's autonomous job (`stopAutonomousTopic(… String(topicId))`);
- it cancels ONLY that topic's queued resumes (`cancelByTopic(Number(topicId))`);
- it records the operator stop FOR THAT TOPIC (`operatorStopRecorder(Number(topicId))`);
- it replies "Session terminated" IN THAT TOPIC.

The ONE thing it does globally is the blunt `resumeQueue.pause('message-sentinel
emergency stop')` — which is exactly the over-broad implementation artifact this spec
fixes, NOT an encoding of "halt all automation until I inspect" intent (that
deliberate, global intent has its OWN pause, `'autonomous stop-all'`, which this spec
NEVER auto-clears). codex's own resolution path agrees: "if it is topic-scoped, stop
using a global pause for it long term" — Layer 2 is precisely the safe relaxation of
that over-broad global pause for the topic-scoped panic reflex.

The global pause is therefore **not** the per-topic protection it appears to be.
Independently, the drainer's drain-time reality validation
(`ResumeQueueDrainer.validateReality`) calls `operatorStopSince(topicId, queuedAt)`
and invalidates any candidate whose topic has a recorded operator stop since it
queued (`invalidated:operator-stop`, never a spawn).

Therefore: **the topic the operator actually stopped stays blocked by the per-topic
`operatorStopSince` guardrail regardless of the global pause.** The global pause's
only *unique* effect is the blunt, indefinite freeze of *every other* topic's
revival. Relaxing the global pause for newer, unrelated active-run work does not
re-revive a genuinely-stopped topic — that protection lives in a different,
finer-grained, still-intact gate.

## The fix — two layers, both in `ResumeQueueDrainer.tick()`

Both layers live where the silent strand happens: the `if (queue.isPaused())` block
at the top of `tick()`. Both are gated on `!queue.isDryRun()` (an observe-only fleet
queue never spawns, so a paused dry-run queue strands nothing and must not page).

### Layer 1 — Loud "paused with waiting work" escalation (signal-only)

When the queue is paused AND there is ≥1 `queued`/`starting` entry waiting, raise
ONE rolling, deduped aggregated attention item via the existing `raiseAggregated`
surface (kind `paused-waiting`, folded into the single `resume-queue:aggregate`
item — P17, never per-entry):

> "Revival queue paused since `<pausedAt>` (`<reason>`) — `<N>` session(s) are
> waiting and won't come back until it's resumed. Ask me to resume it, or resume
> it from the dashboard."

**User-facing wording (review finding, round 1 — codex #5).** The notice body is
PLAIN ENGLISH and carries NO raw API/curl pointer — the prior reap-notify
user-message-quality rule (and the Quiet-by-default lesson) forbids `POST /…`
strings in a user-facing body. The concrete endpoint
(`POST /sessions/resume-queue/resume`) lives in the AUDIT row
(`event:'paused-waiting'`) and this spec, never in the Telegram text.

**Fire-once-per-(pause-episode × waiting-count) (review finding, rounds 1–3 — Layer-1
dedupe).** `tick()` runs every ~60s; a naïve raise-every-tick would inflate the
aggregated `paused-waiting×N` counter into a slow drip. Layer 1 therefore dedupes on
an IN-MEMORY marker keyed on **`pausedAt | waitingCount`** and re-raises only when
that key changes:
- a NEW pause (`pausedAt` changes) re-alerts (an `unpause()`+re-`pause()` is a new
  episode — correct);
- a GROWING backlog under the SAME pause (`waitingCount` increases) re-alerts —
  closing the "alert once for one entry, then 10 more accumulate and the drainer goes
  silent" residual-strand gap (codex r3 #3);
- a STEADY pause (same `pausedAt`, same count) does NOT drip every tick.

Precise guarantee (codex r2 #3): this is "once per DRAINER PROCESS per
(pause-episode × count)" — the marker is in-memory, so a server restart mid-pause CAN
re-raise once. That is harmless: the aggregate attention surface is a SINGLE rolling
`resume-queue:aggregate` item keyed on kind, so a post-restart repeat folds into the
same item rather than spawning a new one. We deliberately do NOT persist the marker —
a once-per-restart re-surface of a STILL-PAUSED-WITH-WAITING-WORK condition is, if
anything, a feature (it re-reminds after a bounce). This is the meaning of the unit
test's "raises `paused-waiting` aggregated exactly once per rolling window".

This converts a silent 4-hour strand into a visible, ack-able signal within one
drain interval (~60s). It is a pure signal-producer: it gates nothing, spawns
nothing, changes no behavior. **This is the floor — it alone makes the strand never
silent again.**

### Layer 2 — Stale emergency-stop pause auto-recovery (bounded behavior change)

The operator should not have to remember a manual lever (their standing directive:
the agent owns all follow-through; "users never remember anything"). So when the
pause is a **sentinel/emergency-stop pause** that has gone **stale**, auto-resume it.

A pause is "stale" when ALL of these hold:
- `isAutoResumableEmergencyPauseReason(pauseInfo().reason)` is true — the centralized
  predicate (currently `/emergency|sentinel/i`), matching only the blunt-stop class
  and never the deliberate `autonomous stop-all` operator pause, which stays manual;
- there is a waiting entry with `reason === AGE_LIMIT_ACTIVE_RUN_REASON` (the
  strongest "the operator has a live autonomous run they want continued" signal);
- that entry's `queuedAt` is **strictly more than** `staleEmergencyPauseAutoResumeMin`
  minutes AFTER `pauseInfo().pausedAt` — i.e. `Date.parse(queuedAt) - Date.parse(pausedAt)
  > staleEmergencyPauseAutoResumeMin * 60_000` — the work the pause now blocks was queued
  long *after* the stop, so the stop cannot have been about it.

**Timestamp / clock discipline (review finding, round 1 — codex #3, gemini #3).**
Both timestamps are compared as parsed epoch-ms via the drainer's single injected
`now()`/`Date.parse` path; the comparison is the strict `>` above. A `pausedAt` or
`queuedAt` that is absent or `Date.parse`-unparseable resolves to the SAFE side (NOT
stale ⇒ no auto-resume) — a malformed timestamp can only KEEP the pause, never clear
it. This is single-process-clock-safe by construction: the resume queue is
machine-local (one queue per machine, single-writer lockfile, host-local state dir —
a foreign-host lock is refused, never shared), so `pausedAt` and `queuedAt` are always
stamped by the SAME process clock. No cross-machine timestamp comparison occurs.

**Why substring-match on the reason, and its acknowledged brittleness (review
finding, rounds 1 & 2 — codex #1/#2, gemini #1/#2).** The match is a substring test
against an INTERNALLY-generated pause reason, never user free-text. The
MessageSentinel emergency-stop is a PANIC REFLEX ("stop NOW") — it is the class this
spec auto-resumes once it is provably stale; the autonomous `stop-all` pause is a
DELIBERATE HALT ("halt all automation until I re-enable it") and is NEVER
auto-cleared by design (its reason does not match `/emergency|sentinel/i`). Both
reviewers correctly note a structured `pauseKind` enum on the persisted pause record
would be more robust than a substring. That is the right long-term shape but a
strictly larger change (it touches `ResumeQueue.pause()`'s signature, the
`PersistedState` schema, the routes.ts callsite, AND a migration for any pause already
persisted on disk at update time) and is deliberately OUT OF SCOPE for this incident
fix.

To make the closed-world assumption EXECUTABLE and TESTED rather than merely asserted
(codex r2 #2), the match lives in ONE centralized predicate
`isAutoResumableEmergencyPauseReason(reason: string): boolean` (a pure helper next to
`AGE_LIMIT_ACTIVE_RUN_REASON` in `WorkEvidence.ts`), with a code comment requiring any
NEW pause reason added anywhere in the codebase to be considered against this
predicate, and a unit test that pins the verdict for EVERY pause reason currently
passed to `ResumeQueue.pause()` (the MessageSentinel emergency reason → true; the
`autonomous stop-all` reason → false). A future text rephrasing then fails a test
instead of silently changing behavior. The substring match is safe here because
(a) it is anchored to a closed, internally-controlled set of pause reasons checked by
that test, (b) a NON-match fails to the SAFE side (the pause stays — the
over-broad-block behavior, never a wrongful clear), and (c) the per-topic
`operatorStopSince` guard is the real protection regardless of what the substring
decides. A future `pauseKind`-enum follow-up is noted under Future. <!-- tracked: ACT-904 -->

**Layer 2's safety is critically dependent on `operatorStopSince` correctness
(review finding, round 2 — gemini #1).** Stated plainly: relaxing the global pause is
safe ONLY because the finer-grained per-topic `operatorStopSince` validation
(`ResumeQueueDrainer.validateReality`) correctly invalidates any candidate whose
topic has a recorded operator stop since it queued. If THAT guard had a bug, a
genuinely-stopped topic could be revived after the staleness window. This spec does
not modify `operatorStopSince`; it depends on it. The existing drainer test suite
already covers the `invalidated:operator-stop` path, and this spec's test plan
RE-ASSERTS it holds AFTER an auto-resume (the per-topic guardrail-intact unit case) —
so the dependency is guarded by test, not just by assertion.

When stale, the drainer calls `queue.unpause()`, audits
`event: 'auto-resumed-stale-pause'`, and raises ONE notice:

> "I auto-resumed the revival queue. It had been paused by an emergency stop at
> `<pausedAt>`, but an active autonomous run has been recycled and queued since
> then — so the stop wasn't about this work. Any topic you actually stopped stays
> protected (per-topic operator stops still block its revival)."

After auto-resume the tick falls through to normal draining. The per-topic
`operatorStopSince` validation remains the real guardrail; the staleness window
protects a FRESH "kill everything" from being undone (a recent pause never
auto-clears). The operator can always re-issue an emergency stop.

**Overlapping pauses — `pause()` is first-writer-wins WITH a deliberate-halt UPGRADE
(review findings, rounds 4–5 — codex r4 #3 / r5 #1, gemini r4 #2 / r5 #2).** `pause()`
is first-writer-wins (a second `pause()` on an already-paused queue does not advance
the freeze clock), with ONE exception both reviewers independently asked for: a
DELIBERATE, non-auto-resumable reason (`autonomous stop-all`) UPGRADES an existing
AUTO-RESUMABLE (emergency/sentinel) pause's reason, so the operator's explicit
"halt all automation" is honored even if it arrives while a stale-emergency pause is
already active. The reverse never downgrades. Concretely:
- `stop-all` THEN `emergency-stop`: reason stays `'autonomous stop-all'` → NOT
  auto-resumable (an emergency stop never downgrades a deliberate halt). ✔
- `emergency-stop` THEN `stop-all`: the pause reason is UPGRADED to
  `'autonomous stop-all'` (pausedAt unchanged — the freeze clock is continuous) → NOT
  auto-resumable. The operator's later deliberate halt is honored, not silently
  no-op'd. ✔ (this is the fix for codex r5 #1 / gemini r5 #2)
- the emitted `pause-upgraded` audit row records `from`/`to` so the transition is
  visible.
- `unpause()` clears whatever SINGLE pause is active; there is never more than one
  active pause record, so nothing can be erased out from under a deliberate halt.

This is implemented in `ResumeQueue.pause()` (not asserted) and covered by unit tests
for BOTH orderings. **Product semantics (codex r4 #1):** the MessageSentinel
emergency-stop is DEFINED as topic-scoped (it acts only on the topic the "stop"
message arrived in — see the code citation above); the global pause it sets is an
over-broad implementation artifact, and auto-resuming a stale one fixes drift rather
than changing product semantics.

**Why a staleness predicate, not a blind pause-TTL (review finding, round 5 — gemini
#1).** gemini proposed the simpler alternative of just expiring the emergency pause
after a fixed TTL. We deliberately keep the predicate: a blind TTL would auto-clear a
genuine emergency pause even when NO active-autonomous-run evidence exists (e.g. the
operator stopped everything and walked away with nothing new queued) — silently
undoing a safety pause on a timer. The predicate is strictly MORE conservative: it
only clears when there is positive evidence the operator re-engaged real long work
(an `AGE_LIMIT_ACTIVE_RUN_REASON` entry queued well after the stop). The cost gemini
correctly notes — "if nothing new is queued, Layer 2 never fires" — is intentional and
fully covered by Layer 1, which keeps alerting that the pause is holding waiting work
until the operator resumes (the strand is never silent; it is just resolved by an
explicit resume rather than a timer when there is no re-engagement signal).

**Blast radius — auto-resume clears the WHOLE pause, by design (review finding,
round 1 — gemini #2).** `queue.unpause()` lifts the global pause for every waiting
entry, not just the entry that proved staleness. gemini proposed the more
conservative alternative of draining ONLY the triggering entry while leaving the
queue paused. We deliberately do NOT do that, for three reasons: (1) the pause being
cleared is, by the staleness predicate, an OVER-BROAD stale block that should never
have outlived the moment of the stop — leaving it up would re-strand every OTHER
waiting entry indefinitely, which is the exact bug this spec fixes; (2) every entry
the unpause frees still passes ALL deterministic reality gates AND the per-topic
`operatorStopSince` validation before it can spawn — a genuinely-stopped topic is
re-blocked at drain time, so the freed set is not an unguarded spawn set; (3)
"drain-one-while-paused" would itself be a new, more invasive change to the queue's
pause semantics (a paused queue that spawns) — a bigger Signal-vs-Authority surface
than the narrow, well-understood `unpause()` lever. The blast radius is intentional
and bounded by the same per-topic guard the spec's "key insight" relies on.

**Incident-scoped trigger, evidence path to broaden (review finding, round 1 —
codex #4).** Only `AGE_LIMIT_ACTIVE_RUN_REASON` triggers auto-resume — the exact
signal class behind the 2026-06-14 incident. A plain mid-work entry is a weaker
"operator wants this alive" signal and stays behind the manual lever + the Layer-1
alert (which now names how many are waiting). This is conservative on purpose; the
Layer-1 audit row records the count of paused-waiting entries so a future decision to
broaden the trigger can be evidence-driven rather than speculative.

## Frontloaded decisions

1. **Staleness threshold default = 60 min** (`staleEmergencyPauseAutoResumeMin`,
   config `monitoring.resumeQueue.staleEmergencyPauseAutoResumeMin`). Long enough
   that a fresh "kill all sessions" + a coincidental age-reap minutes later never
   auto-undoes the stop; short enough to self-heal well within a long run.
   Cheap-to-change (single number).
2. **Only the active-autonomous-run reason triggers auto-resume**, not any queued
   entry. The active-run reason proves the operator re-engaged real long work; a
   plain mid-work entry is a weaker signal and stays behind the manual lever +
   Layer-1 alert.
3. **Reason-class match = `emergency`/`sentinel` substrings only.** The deliberate
   `autonomous stop-all` pause (operator chose to stop all autonomous work) is NOT
   auto-cleared — that is an intentional operator state, not a stale safety reflex.
4. **On by default everywhere, with an off-switch.** This is a bug fix (current
   behavior is a permanent silent strand), not a speculative feature, so it is not
   shipped dark. `monitoring.resumeQueue.autoResumeStalePause: false` disables Layer
   2 (Layer 1 alert always stays on). Both layers are inert on a dry-run (fleet)
   queue, so the fleet behavior change is limited to the alert being *possible* only
   when a queue is live.
5. **No new attention topic / no new surface.** Both layers reuse the existing
   `resume-queue:aggregate` item (P17 dedupe) — zero flood risk.

## Signal vs authority (`docs/signal-vs-authority.md`)

- **Layer 1** is a pure signal-producer (an attention notice). No authority. ✔
- **Layer 2** removes an over-broad, stale, blunt *block* (the global pause) only
  when a precise staleness predicate holds; it does NOT bypass any per-topic safety
  — every revived candidate still passes all deterministic gates AND the per-topic
  `operatorStopSince` validation. It narrows authority toward the finer-grained gate
  that already exists, rather than adding a new brittle blocker. The change is
  strictly additive to safety on the stopped topic (unchanged) and removes a
  false-negative-on-revival on unrelated topics.

## Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The resume queue is one-queue-per-machine: a
single-writer lockfile (`state/resume-queue.lock`, pid + hostname + heartbeat), a
host-local state dir, and a HARD INVARIANT that a foreign-host lock is never probed or
reclaimed (it disables the queue loudly instead). Pause/unpause state lives in that
per-machine `state/resume-queue.json`. Both layers added here are pure additions to
the per-machine drainer tick:
- **Layer 1's notice** routes through the existing per-machine
  `resume-queue:aggregate` attention item — no new cross-machine surface, no new
  generated URL, no replicated state.
- **Layer 2's `unpause()`** mutates only the local queue's local pause state and acts
  only on locally-queued entries; it neither reads nor writes any peer's queue.
- **No timestamp crosses a machine boundary** (see clock discipline above) — `pausedAt`
  and `queuedAt` are always same-process-stamped.

A multi-machine agent therefore behaves identically per machine; there is no
strand-on-transfer concern because a topic transfer already closes the source
session and the resume queue does not follow a moved topic.

## Test plan (3 tiers — Testing Integrity Standard)

**Unit (`tests/unit/resume-queue-drainer.test.ts`, extend):**
- paused + waiting entry + live → raises `paused-waiting` aggregated exactly once
  per pause episode (multiple ticks at the SAME `pausedAt` raise it ONCE; never
  spawns; still returns `blocked:'paused'` when not stale).
- a NEW pause episode (unpause + re-pause with a new `pausedAt`) re-raises `paused-waiting`.
- a GROWING backlog under the SAME pause (a second entry queues while paused)
  re-raises `paused-waiting` (the count changed — codex r3 #3); a steady same-count
  pause does NOT re-raise. (Dedupe is intentionally COUNT-LEVEL aggregation — codex r4
  #4 — not per-entry churn; the aggregate item is a bounded attention surface, not a
  ledger.)
- `autonomous stop-all` THEN `emergency-stop` (overlapping pauses) → the queue stays
  paused with the `stop-all` reason and is NOT auto-resumed (an emergency stop never
  downgrades a deliberate halt; codex r4 #3 / gemini r4 #2).
- `emergency-stop` THEN `autonomous stop-all` → the pause is UPGRADED to `stop-all`
  (reason changes, pausedAt unchanged, `pause-upgraded` audited) and is NOT
  auto-resumed — the operator's later deliberate halt is honored (codex r5 #1 /
  gemini r5 #2).
- paused + waiting + DRY-RUN → no alert, no auto-resume (observe-only silence).
- stale emergency pause (reason matches, active-run entry queued > threshold after
  pausedAt) + live → calls `unpause()`, audits `auto-resumed-stale-pause`, raises the
  notice, then drains normally.
- **boundary: exactly-at-threshold** (queuedAt − pausedAt === threshold) → NOT stale
  (strict `>`), stays paused.
- **boundary: just-over-threshold** (threshold + 1ms) → stale, auto-resumes.
- **malformed timestamp** (missing/`NaN` `pausedAt` or `queuedAt`) → NOT stale (safe
  side — pause stays), no `unpause()`.
- FRESH emergency pause (active-run entry queued < threshold after pausedAt) → does
  NOT auto-resume (stays paused, Layer-1 alert only).
- `autonomous stop-all` pause (deliberate, reason does NOT match
  `/emergency|sentinel/i`) + active-run entry → does NOT auto-resume.
- waiting entry is a plain mid-work entry (reason ≠ `AGE_LIMIT_ACTIVE_RUN_REASON`),
  stale emergency pause → does NOT auto-resume (only the active-run reason triggers).
- `autoResumeStalePause:false` → Layer 2 off, Layer 1 still fires.
- after auto-resume, a candidate whose topic has an `operatorStopSince` record is
  still `invalidated:operator-stop` (per-topic guardrail intact — guards the
  gemini-r2 #1 dependency).
- **`isAutoResumableEmergencyPauseReason()` closed-world test** (codex r2 #2): the
  MessageSentinel emergency-stop reason → true; the `autonomous stop-all` reason →
  false; an unrelated maintenance-style reason → false. Pins the verdict for every
  pause reason currently passed to `ResumeQueue.pause()` so a future text change fails
  a test.

**Integration (`tests/integration/resume-queue-routes.test.ts`, extend):**
- `GET /sessions/resume-queue` reflects `paused:false` after a drainer auto-resume
  of a stale emergency pause (the state is observable through the live HTTP route).

**E2E (`tests/e2e/reap-notify-resume-queue-lifecycle.test.ts`, extend):**
- full lifecycle: emergency-stop pauses the queue → an active-run session is admitted
  later (queuedAt after pausedAt by > threshold) → on the next calm tick the drainer
  auto-resumes and the session is revived → the route shows `paused:false` and the
  entry `respawned`. The "feature is alive" assertion.

## Migration parity

`staleEmergencyPauseAutoResumeMin` and `autoResumeStalePause` are CODE-defaulted in
the drainer config (like the other `resumeQueue.*` keys — deliberately not frozen
into `ConfigDefaults`, preserving the fleet flip). No `PostUpdateMigrator` change is
needed: existing agents pick up the new drainer behavior the moment they take the
instar update and restart, with the code defaults. No CLAUDE.md template capability
section is required (no new route/endpoint; the existing `/sessions/resume-queue`
and reap-log capability text already covers the surface), though the resume-queue
template note will mention that a stale emergency pause self-heals.

## Rollback

`monitoring.resumeQueue.autoResumeStalePause: false` disables Layer 2 instantly
(read live at tick time). Layer 1 is a notice only and carries no behavioral risk.
Reverting the PR restores the prior (permanent-pause) behavior exactly — no state
migration, no persisted schema change.

## Accepted tradeoffs (reviewed, deliberately not changed)

- **Dry-run paused-waiting is silent** (codex r2 #4): a paused dry-run (fleet) queue
  with waiting entries does not raise Layer 1. The reviewer notes this hides a signal
  the live rollout might fail. We keep the silence: the firmly-established rule is that
  observe-only queues must never page anyone (the same `!isDryRun()` gate the whole
  feature uses). The dry-run queue STILL audits its entries (`would-resume`), so the
  soak's observability is in the audit log, not in user-facing attention.
- **Staleness keys on `queuedAt`, not original-context age** (gemini r2 #3): an
  autonomous run that was contextually OLD but only hit its age cap (and thus queued)
  after the stop will satisfy the predicate. We accept this: the entry queued after the
  stop genuinely reflects a run the operator left RUNNING through the stop window, and
  the per-topic `operatorStopSince` guard still blocks the topic if the operator
  actually stopped it. Threading an original-creation timestamp into the entry is a
  larger schema change for a nuanced edge case — noted as a future option.

## Future (out of scope, noted for evidence-driven follow-up)

<!-- tracked: ACT-904 -->
<!-- All three Future items below ride evolution-action ACT-904 so they re-surface rather than rot (Close the Loop). -->

- **Structured `pauseKind` enum** (codex #1 / gemini #1): persist a `pauseKind`
  discriminator on the pause record and match THAT instead of the reason substring.
  More robust + extensible, but requires a `PersistedState` schema bump + a migration
  for already-persisted pauses, so it is deferred past this incident fix. <!-- tracked: ACT-904 --> (The
  centralized `isAutoResumableEmergencyPauseReason()` predicate added in this spec is
  the bridge: it makes the closed-world assumption testable now and gives the enum a
  single callsite to replace later.)
- **Broaden the auto-resume trigger** (codex #4): the Layer-1 audit row's
  paused-waiting count is the evidence stream; if plain mid-work entries are seen
  stranding behind stale emergency pauses in practice, broaden beyond
  `AGE_LIMIT_ACTIVE_RUN_REASON` on that evidence.
- **Original-context age in the staleness heuristic** (gemini r2 #3): add the revived
  session's original creation/last-activity timestamp to the entry and factor it in as
  a secondary staleness check.
