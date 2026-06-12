# Per-Topic Reap Notification + Mid-Work Resume Queue

**Status:** draft (awaiting review-convergence)
**Author:** echo
**Date:** 2026-06-11
**Origin:** Operator directive (topic 24662, 2026-06-11): improve the session reaping process —
(1) reaped sessions should ALWAYS notify the user in the corresponding topic/channel;
(2) sessions reaped mid-work should be tagged as such, and a persistent mechanism should
look for opportunities to resume them (ordered queue, not all at once) once resources recover.
**Grounding incident:** 2026-06-11 machine overload — 7 always-on agent stacks drove a 16-core
box to load 20+; quota-shed and age-limit reaps killed working sessions. The reap-log recorded
them (`reason:"quota-shed"` skips, then `reason:"age-limit"` terminal reaps), but users saw at
most one consolidated lifeline message, and the killed mid-work sessions stayed dead until a
user happened to message their topic.

## What exists today (v1.3.487, file:line grounded)

- **Single kill authority:** `SessionManager.terminateSession` (src/core/SessionManager.ts:763)
  — CAS + in-flight guard, protected/lease/ReapGuard KEEP gates, exactly-once
  `beforeSessionKill` / `sessionComplete` / `sessionReaped` emission. All meaningful killers
  route through it (SessionWatchdog src/monitoring/SessionWatchdog.ts:630, OrphanProcessReaper:205,
  QuotaManager enforced kills via migrator dep src/monitoring/QuotaManager.ts:341, age-limit
  SessionManager.ts:1184, idle-zombie :1330, boot purge :2698).
- **ReapLog** (src/monitoring/ReapLog.ts): append-only `logs/reap-log.jsonl`, entry types
  `reaped` / `skipped`, fields ts/session/tmuxSession/reason/disposition/origin/machine/launchLane.
  **No mid-work indicator. No notification-outcome record.**
- **ReapNotifier** (src/monitoring/ReapNotifier.ts): listens to `sessionReaped`, default-enabled
  (`monitoring.reapNotify.enabled ?? true`), silent for `disposition:'recovery-bounce'` and
  `origin:'operator'`. Coalesces in a 60s window:
  - exactly 1 reap → notice to the session's bound topic, falling back to the lifeline topic;
  - **>1 reap → ONE consolidated message to the LIFELINE topic only** — the affected topics
    get NOTHING (ReapNotifier.ts:116-119);
  - no resolvable topic at all → silent (reap-log only).
  Delivery goes through `notify('SUMMARY', …)` (src/commands/server.ts:5380) — the 30-min
  notification batcher, quiet-hours aware. Outcome (sent / dropped / no-topic) is recorded nowhere.
- **Mid-work knowledge exists at evaluation time but is discarded at kill time.**
  ReapGuard (src/core/ReapGuard.ts) holds the positive-evidence KEEP closures
  (active-process, active-subagent, structural-long-work, recent-user-message,
  open-commitment, relay-lease, pending-injection, main-process-active). When a kill is
  *authorized anyway* (age-limit hard cap, quota-shed enforced kill, operator kill,
  `bypassActiveProcessKeep`, watchdog escalation), none of that evidence is stamped onto the
  reap event, the reap-log entry, or the session record.
- **Resume machinery exists but is purely reactive:** TopicResumeMap captures the resume UUID
  on `beforeSessionKill`; the next *user message* on the topic respawns with `--resume`.
  SessionRefresh / `POST /sessions/refresh` do kill+respawn on demand. SessionMigrator restarts
  sessions it halted itself (account-switch flow only). **There is no deferred-resume queue, no
  resource-recovery watcher, no ordered drain.** A mid-work session killed by quota-shed or
  age-limit stays dead until a human notices.

## Requirements

**R1 — A reaped session always produces a user-visible notice in its corresponding
topic/channel.**
- R1.1 Per-topic delivery even in bursts: every topic that lost a session gets a notice in
  *that topic*; the lifeline gets the cross-topic summary only for unbound sessions or as an
  aggregate index. Never creates new topics (bounded-notification standard).
- R1.2 The notice states the reason, whether the session was mid-work, and (if queued) its
  resume-queue position.
- R1.3 Delivery outcome is durably auditable: every flush writes a `notify` record into the
  reap-log (per topic: sent / no-topic / send-failed), so "did the user get told?" is a read,
  not a guess. Sends ride the existing durable relay path (PendingRelayStore +
  DeliveryFailureSentinel) so a transient Telegram failure retries instead of dropping.
- R1.4 Intentional silences remain, and are *recorded* as such in the notify record:
  `recovery-bounce` (kill-to-respawn is not a disappearance) and `origin:'operator'`
  (the user commanded the kill). Everything else notifies.

**R2 — Mid-work reaps are tagged, queued, and resumed in order once resources recover.**
- R2.1 At the kill chokepoint, work-state evidence is computed and stamped:
  `midWork: boolean` + `workEvidence: string[]` (the KEEP-closure names that fired) on the
  `sessionReaped` event, the reap-log entry, and the persisted session record
  (`endedMidWork: true`).
- R2.2 A terminal, autonomous reap of a mid-work session enqueues a durable resume-queue
  entry. Operator kills do not enqueue by default (`resumeQueue.includeOperatorKills: false`).
  Recovery-bounces never enqueue (their respawn is the recovery itself).
- R2.3 The queue is durable (`state/resume-queue.json`, atomic writes), survives restarts,
  is deduped per tmuxSession (a re-reap replaces the entry, carrying `resurrections` count),
  and is bounded (`maxQueueSize`, overflow → oldest-low-priority dropped WITH an attention item).
- R2.4 A ResumeQueueDrainer ticks (default 60s) and resumes AT MOST ONE entry per tick —
  the ordered, staggered drain the operator asked for. Resume eligibility requires ALL of:
  - pressure tier `normal` (reuse the SessionReaper's memory+CPU tier computation) for
    `requiredCalmTicks` consecutive ticks (default 3);
  - quota spawn gate passes (`QuotaManager.canSpawnSession`);
  - session count below cap; no quota migration in flight.
- R2.5 Ordering: priority class first — `interactive` (topic-bound conversation sessions)
  before `job` (scheduler-spawned) before `other` — then FIFO by reap time.
- R2.6 Resume mechanics reuse what exists: topic-bound → respawn with the TopicResumeMap UUID
  (`--resume`) + a continuation prompt naming the reap ("you were shut down mid-work —
  <reason> — pick up where you left off"); job sessions → `scheduler.triggerJob(slug,
  'resume-queue')`; no resume path available → entry becomes an attention item (never a
  silent drop).
- R2.7 Failure ladder: spawn verified alive after a grace period; failure → attempts++ with
  backoff; `maxAttempts` (default 3) exhausted → HIGH attention item. Entry TTL
  (`entryTtlHours`, default 24) expired → attention item, not auto-resume (a stale resume can
  be wrong). `maxResurrections` (default 2) caps the kill→resume→kill loop under sustained
  pressure; the calm-ticks requirement damps it structurally.
- R2.8 Every drainer decision (resumed / deferred:<why> / gave-up:<why>) is auditable:
  `logs/resume-queue.jsonl` + `GET /sessions/resume-queue` (Bearer-auth, read-only).
- R2.9 On resume, the topic gets a notice ("resumed after resource recovery"); on give-up,
  the attention item carries the manual lever (`POST /sessions/refresh`).

## Design

### Part A — ReapNotifier v2 (per-topic coalescing)

Replace the single-buffer flush with per-topic grouping at flush time:

1. Buffer unchanged (bounded, drop-oldest detail, exact count preserved).
2. On flush, resolve each event's topic; group: `Map<topicId, ReapEvent[]>` + an `unbound` list.
3. Each affected topic gets ONE message for the window (its sessions only, reason + mid-work
   tag + queue position each). Message count per flush = number of affected existing topics —
   bounded, no new topics, flood-safe by construction.
4. The lifeline gets: the unbound list, plus (only when >1 topic was affected) a one-line
   cross-topic index ("N sessions reaped across M topics — see each topic / reap-log").
5. Every per-topic send outcome appends a `type:'notify'` reap-log record:
   `{ ts, type:'notify', topicId, sessions:[...], outcome:'sent'|'no-topic'|'send-failed', reason }`.
   ReapLog gains `recordNotify()`; `read()` normalization tolerates the new type (older
   readers ignore unknown types — additive, no migration needed for the log itself).
6. Wiring keeps the SUMMARY tier (batcher, quiet-hours) — "always" means guaranteed durable
   eventual delivery, not bypassing quiet hours. Mid-work reaps with a queued resume use
   IMMEDIATE tier instead: the user should know promptly that work was interrupted.

### Part B — mid-work stamping + ResumeQueue

**Stamping (in `terminateSession`, before the tmux kill):**
```
const evidence = this.reapGuard?.workEvidence(session) ?? [];   // new observe-only method
const midWork = evidence.length > 0;
```
`ReapGuard.workEvidence()` runs ONLY the work-positive closures (active-process,
active-subagent, structural-long-work, relay-lease, pending-injection, main-process-active)
in observe mode — never the policy guards (protected, lease), never vetoes. Cheap-first
ordering preserved; errors → empty evidence (stamping must never block a kill).
Stamped onto: `sessionReaped` payload, reap-log entry (`midWork`, `workEvidence`), session
record (`endedMidWork`).

**ResumeQueue (new, src/monitoring/ResumeQueue.ts):**
- Durable JSON state file, atomic write-rename, per-machine (queue is local: a session's
  worktree/tmux live on the machine that killed it; cross-machine resume is explicitly out of
  scope — the session pool's placement handles that separately).
- Enqueue listener on `sessionReaped`: terminal + autonomous + midWork → entry
  `{ id, queuedAt, sessionName, tmuxSession, topicId?, resumeUuid?, jobSlug?, priorityClass,
     reason, workEvidence, attempts: 0, resurrections, status:'queued' }`.
- `ResumeQueueDrainer` tick loop per R2.4–R2.7. Pressure tier comes from a shared
  `PressureGauge` extraction of SessionReaper's existing memory+CPU computation (reaper and
  drainer must read the SAME tier — no second definition of "calm").
- Routes: `GET /sessions/resume-queue` (queue + drainer state), `POST /sessions/resume-queue/:id/cancel`
  (operator lever, Bearer-auth), `POST /sessions/resume-queue/drain` (manual single-step drain).

### Config (`.instar/config.json` → `monitoring`)

```jsonc
"reapNotify": {
  "enabled": true,            // existing
  "coalesceWindowMs": 60000,  // existing
  "perTopic": true            // NEW — v2 grouping; false = legacy single-buffer behavior
},
"resumeQueue": {
  "enabled": true,
  "dryRun": true,             // ships observing: logs would-enqueue/would-resume, touches nothing
  "drainIntervalSec": 60,
  "requiredCalmTicks": 3,
  "maxAttempts": 3,
  "maxResurrections": 2,
  "entryTtlHours": 24,
  "maxQueueSize": 50,
  "includeOperatorKills": false
}
```

Ship posture: Part A default-ON (it is a correctness fix to an already-default-on notifier).
Part B ships `enabled:true, dryRun:true` fleet-wide (observe-only), flipped live on the dev
agent immediately; fleet flip after a soak window — graduated-rollout standard, since the
drainer autonomously spawns sessions (real authority).

### Migration parity

- `migrateConfig()`: add missing `monitoring.reapNotify.perTopic` and `monitoring.resumeQueue.*`
  defaults (existence-checked).
- CLAUDE.md template (`generateClaudeMd()`): update the Reap-Log section — notify records,
  mid-work tag, resume queue surface (`GET /sessions/resume-queue`), proactive triggers
  ("where did my session go?" → reap-log; "will it come back?" → resume-queue).
- `migrateClaudeMd()`: content-sniffed section refresh for existing agents.
- No hook/skill changes.

### Testing (three tiers, per TESTING-INTEGRITY-SPEC)

- **Unit:** ReapNotifier v2 grouping (single, multi-topic burst, unbound, mixed; outcome
  records; legacy mode); ReapGuard.workEvidence (observe-only, never throws, ordering);
  ResumeQueue (enqueue rules incl. operator/bounce exclusions, dedupe+resurrections, ordering,
  TTL, bounds); Drainer (calm-ticks gate, one-per-tick, failure ladder, dry-run inertness).
- **Integration:** `/sessions/resume-queue` routes; reap → notify record in
  `GET /sessions/reap-log`; full quota-shed simulation → per-topic notices + queue entries.
- **E2E lifecycle:** feature-alive test — server boots with defaults, reap of a mid-work
  fixture session produces topic notice + queue entry + drainer resume under relaxed gates.
  Wiring-integrity: drainer's pressure gauge, spawn gate, and resume deps are real (non-null,
  delegate to live implementations).
- **Burst invariant:** extend the notification-flood burst test — N reaps across M topics
  produce ≤ M topic messages + 1 lifeline message, zero new topics.

## Decisions (resolved 2026-06-11 per operator standing directive — design forks resolved
autonomously with the author's lean, reported after)

1. **Burst tier — RESOLVED:** mid-work-with-queued-resume notices go IMMEDIATE (the user
   should promptly know work was interrupted and a resume is queued); all other reap notices
   stay SUMMARY (batched ≤30 min, quiet-hours aware). Rationale: interrupted work is
   actionable; routine idle reaps are not.
2. **Part B fleet posture — RESOLVED:** `dryRun:true` fleet-wide for one release, flipped
   live on the dev agent (echo) immediately, fleet flip after a soak window. Rationale: the
   drainer autonomously spawns sessions — real authority — so this follows the
   graduated-rollout standard; straight-to-live fleet-wide would skip the soak a
   spawn-authority feature requires.
3. **Operator kills — RESOLVED:** excluded from both the resume queue and (as today) the
   notifier. A deliberate kill is not a disappearance. The `resumeQueue.includeOperatorKills`
   config lever exists if an operator ever wants the opposite.

## Out of scope

- Cross-machine resume placement (session pool owns it).
- Lite-mode / agent-sleep tiering (the parent exploration this topic split from — separate spec).
- Reaper kill-decision changes (this spec observes and recovers; it does not alter who gets killed).
