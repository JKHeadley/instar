---
title: "Per-Topic Reap Notification + Mid-Work Resume Queue"
slug: "reap-notify-per-topic-and-midwork-resume-queue"
author: "echo"
status: "approved"
approved: true
approved-by: "Justin (topic 24662, 2026-06-12 10:17 PDT)"
parent-principle: "Close the Loop"
supervision: "ResumeQueueDrainer: tier1 (observe-only during soak; promotion criterion stated in 'Supervision'). ReapNoticeDrain: tier0 (deterministic template delivery, declared bounds)."
lessons-engaged:
  - "P2 Signal-vs-Authority — engaged: the drainer's deterministic gates are spawn *eligibility* checks (quota, cap, pressure), all pre-existing authorities; the Tier 1 LLM check is observe-only during soak and advisory-and-audited after promotion, never a silent blocker. Hard-invariant validators on dequeued entries use the documented brittle-blocker exemption. Reap notices are system-template sends via the adapter (not /telegram/reply), so the tone gate and whoami check are structurally not on this path — declared, not assumed."
  - "P3 Migration Parity — engaged: ConfigDefaults registration for reapNotify.perTopic + maxImmediatePerFlush; drainEnabled and all resumeQueue keys deliberately code-defaulted (NOT in ConfigDefaults) so later flips of shipped defaults actually take effect; new marker-keyed CLAUDE.md block + framework-shadow markers list; NO pending-relay schema change (the hold reuses the existing next_attempt_at column and the origin tag rides the delivery_id PK prefix, precisely so rollback keeps honoring holds)."
  - "P4 Testing Integrity — engaged: all three tiers specified, including the feature-alive E2E, wiring-integrity tests, and the held-row-across-restart test."
  - "P7 LLM-Supervised Execution — engaged: ResumeQueueDrainer declared Tier 1 (observe-only during the dev soak, promoted to advisory-defer only on demonstrated true catches); ReapNoticeDrain declared Tier 0 with the explicit deterministic-template justification; see 'Supervision'."
  - "P14 Distrust Temporary Success — engaged: resurrection-cap exhaustion is surfaced as the most diagnostic event the feature produces, never a silent stop; the soak must assert a true-positive midWork stamp from a quota-shed kill; the restore-purge fix is tested across a restart."
  - "P17 Bounded Notification Surface — engaged: per-topic notices bounded by affected existing topics; ALL attention-item emissions aggregate into one rolling deduped item; burst-invariant test extended to the attention path; per-flush IMMEDIATE cap."
  - "P18 Observation Needs Structure — engaged: killer-supplied work evidence; notify outcomes cover EVERY terminal state of the actual delivery machine including enqueue failure; every drainer decision transition audited."
  - "P19 No Unbounded Loops — engaged: drainer-level circuit breaker + per-entry attempts/backoff/TTL + resurrection ledger keyed on STABLE identity (topicId ?? jobSlug — tmux names regenerate per spawn) + sustained-failure test with declared bounds."
  - "L7 Verify Runtime State — engaged twice over: round 1 caught the spec asserting a durable delivery path that didn't exist; round 2 caught the replacement leaning on a drain engine that is default-OFF fleet-wide and a restore-purge with a documented data-loss incident. The design now ships its own always-on drain owner and the store-level purge fix."
  - "L13 Parallel Dev Isolation — engaged: queue entries carry explicit cwd + worktreePath; the spawn path gains the explicit-cwd parameter it currently lacks (spawnSessionForTopic has none today — named extension, not an assumed seam); wiring test asserts round-trip."
  - "B1/B29 user-message quality — engaged: plain-English reason map; no curl/API pointers in user-facing bodies (including attention-item bodies); resume notices worded honestly ('restarted to pick the work back up'), never claiming a transcript-resume that may not have attached."
  - "dev-gate registry (author memory: dark-features-must-dogfood-on-echo) — engaged: resumeQueue is classified in DARK_GATE_EXCLUSIONS (the DEV_GATED_FEATURES registry's admission bar excludes cost-bearing features, and the drainer spawns sessions); posture is code-defaulted dryRun with a local dev-agent flip."
  - "L10 release notes in same PR — engaged: upgrades/next fragment in the ship checklist."
  - "P10 — no deferrals are requested; both foundation fixes surfaced by review (SessionMigrator refusal-blindness; pending-relay restore-purge hold-exemption) are pulled in-scope."
eli16-overview: "reap-notify-per-topic-and-midwork-resume-queue.eli16.md"
review-convergence: "2026-06-12T05:25:51.182Z"
review-iterations: 7
review-completed-at: "2026-06-12T05:25:51.182Z"
review-report: "docs/specs/reports/reap-notify-per-topic-and-midwork-resume-queue-convergence.md"
cross-model-review: "codex-cli:gpt-5.5 + gemini-cli:gemini-2.5-pro (grok-tier unavailable, disclosed)"
---

# Per-Topic Reap Notification + Mid-Work Resume Queue

**Origin:** Operator directive (topic 24662, 2026-06-11): improve the session reaping process —
(1) reaped sessions should ALWAYS notify the user in the corresponding topic/channel;
(2) sessions reaped mid-work should be tagged as such, and a persistent mechanism should
look for opportunities to resume them (ordered queue, not all at once) once resources recover.

**Grounding incident:** 2026-06-11 machine overload — 7 always-on agent stacks drove a 16-core
box to load 20+; quota-shed and age-limit reaps killed working sessions. The reap-log recorded
them, but users saw at most one consolidated lifeline message, and the killed mid-work sessions
stayed dead until a user happened to message their topic.

## Glossary (for readers outside this codebase)

| Term | Meaning |
|---|---|
| **Reap** | An autonomous kill of an agent session (resource pressure, age limit, quota, watchdog). |
| **ReapGuard / KEEP closures** | The pre-kill checks that veto a kill when a session shows evidence of active work. Closure names are the evidence vocabulary (see the evidence table below). |
| **ReapLog** | Append-only JSONL audit of every kill and refused kill (`logs/reap-log.jsonl`). |
| **Topic** | A Telegram forum thread bound to a conversation/project; the user-facing channel. Lifeline = the system status topic. |
| **TopicResumeMap** | Maps a topic to the killed session's conversation-resume UUID so a respawn can continue the conversation (`claude --resume`). |
| **PendingRelayStore** | Existing durable SQLite outbox for Telegram sends (per-agent, WAL). |
| **DeliveryFailureSentinel (DFS)** | Existing opt-in (default-OFF) drain engine over that store for the reply-relay path. |
| **LlmQueue** | Existing rate-limited, spend-capped queue for background LLM calls. |
| **Pressure tier** | SessionReaper's memory+CPU health gauge: `normal` / `moderate` / `critical`. |
| **DEV_GATED_FEATURES / DARK_GATE_EXCLUSIONS** | The two registries the dark-feature lint accepts: dev-gated (auto-live on dev agents; admission bar: non-destructive, no-spend) vs. explicitly-classified exclusions with rationale. |
| **Attention queue / attention item** | The durable "needs the operator's eyes" surface (`POST /attention`): each item gets one Telegram topic via a flood-guarded creator; items dedupe on a stable id and can be updated in place; "aggregated item" = one rolling item carrying a count + list, updated as the situation evolves. |
| **P/L/B references** | Entries in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (principles / architectural lessons / behavioral lessons). |

## What exists today (v1.3.487, file:line grounded — corrected by rounds 1–2)

- **Single kill authority:** `SessionManager.terminateSession` (src/core/SessionManager.ts:764)
  — CAS + in-flight guard, protected/lease/ReapGuard KEEP gates, exactly-once
  `beforeSessionKill` / `sessionComplete` / `sessionReaped` emission. All meaningful killers
  route through it (SessionWatchdog :630, OrphanProcessReaper:205, QuotaManager enforced kills
  via migrator dep :341, age-limit SessionManager.ts:1184, idle-zombie :1330, boot purge :2698).
- **ReapLog** (src/monitoring/ReapLog.ts): entry types `reaped` / `skipped`. **No mid-work
  indicator. No notification-outcome record.** `normalizeEntry` (:122–143) coerces unknown
  `type` to `'reaped'` and strips non-whitelisted fields — the new type and fields MUST be
  added to the normalizer or they vanish on read.
- **ReapNotifier** (src/monitoring/ReapNotifier.ts): default-enabled, silent for
  `recovery-bounce` and `origin:'operator'`. **>1 reap in the 60s window → ONE consolidated
  message to the LIFELINE topic only** (:116-119); affected topics get nothing. Detail buffer
  `maxBuffer:100` drop-oldest.
- **Delivery is fire-and-forget today.** The notifier's send dep is `notify('SUMMARY', …)`
  (src/commands/server.ts:2282, :5380) → `NotificationBatcher.sendDirect`
  (src/messaging/NotificationBatcher.ts:304-315): errors are caught, console-logged, retried
  never. `PendingRelayStore`/DFS back the `/telegram/reply` relay path only.
- **The durable layer has two flaws this design must fix, not inherit** (round-2 foundation
  audit): (a) DFS is default-OFF fleet-wide (AgentServer instantiates it only on
  `monitoring.deliveryFailureSentinel.enabled === true`, absent from ConfigDefaults) — so
  "DFS will retry it" is false on a default agent; (b) the store's boot restore-purge drops
  queued rows whose `attempted_at` is older than ~60 min (pending-relay-store.ts:397-405) —
  the mechanism behind the documented 2026-06-05 silent-deletion incident — which would eat
  any quiet-hours-held notice that crosses a routine server restart.
- **Mid-work knowledge is discarded at kill time — and the chokepoint is the WRONG place to
  recompute it.** An autonomous kill reaches `terminateSession`'s body only when the
  work-positive closures returned nothing (or a named bypass fired) — a chokepoint re-run is
  empty by construction for guard-cleared kills. The motivating class (quota-shed) flows
  through `SessionMigrator.haltAllSessions`, which sends Ctrl+C and waits a grace period
  BEFORE `terminateSession` (src/monitoring/SessionMigrator.ts:~585-615) — by stamp time the
  work is already torn down. Evidence must come from the killer, at its decision point.
- **Foundation flaw, pulled in-scope:** `SessionMigrator.haltAllSessions` discards
  `terminateSession`'s result and records the session `halted` unconditionally (:608-616) —
  a ReapGuard refusal is silently counted as a halt (and the refused-but-alive session's job
  can be double-respawned downstream).
- **Resume machinery is purely reactive:** TopicResumeMap + next user message. Job sessions
  are spawned with timestamped tmux names (JobScheduler.ts:813: `job-<slug>-<ts36>`), and
  topic respawns re-derive the name from the CURRENT topic name — tmux session names are NOT
  stable identity across respawns.
- **The respawn path takes no cwd:** `SessionRefresh` → respawner → `spawnSessionForTopic`
  (server.ts:474) spawns into the module-level project dir; there is no per-spawn cwd
  parameter today. (Part B adds one — L13.)

## Work-evidence vocabulary (exact enum)

| Evidence name | Source | Class |
|---|---|---|
| `build-or-autonomous-active` | killer-supplied (migrator pre-grace; reaper structural check) | **strong** |
| `active-subagent` | ReapGuard closure | **strong** |
| `pending-injection` | ReapGuard closure | **strong** |
| `open-commitment` | ReapGuard closure | **strong** |
| `structural-long-work` | ReapGuard closure | **strong** |
| `active-process` | ReapGuard closure | weak (gameable with one child process) |
| `main-process-active` | ReapGuard closure | weak |
| `recent-user-message` | ReapGuard closure | weak |
| `relay-lease` | ReapGuard closure | weak |
| `unverified-under-pressure` | chokepoint marker (critical tier, fork-based closures skipped) | **never eligible** |

The enum is clamped INSIDE `terminateSession` (the single chokepoint), regardless of which
killer supplied the values — unknown names are dropped, not stored.

## Requirements

**R1 — Every non-silent reap produces a durable per-topic notice attempt; a delivery
failure is loudly recorded, never silent.** (The guarantee boundary: durable enqueue +
retried delivery + recorded outcome while the store is healthy; store unavailability
degrades to one direct send attempt + a loud degradation record — see R1.3. Never bypasses
quiet hours.)
- R1.1 Per-topic delivery even in bursts: every topic that lost a session gets a notice in
  *that topic*; the lifeline gets unbound sessions + (when >1 topic affected) a one-line
  cross-topic index. Never creates new topics. In a storm larger than the detail buffer,
  every affected topic still gets at least a correct count (affected-set tracked separately
  from per-event detail).
- R1.2 The notice states the reason in plain English (reason-slug → plain-English map;
  unknown slugs get a generic sentence with the slug parenthesized), whether the session was
  mid-work, and — only when the resume queue is LIVE (not dry-run) — that a resume is queued.
  No raw curl/API pointers in any user-facing body (notices AND attention items).
- R1.3 Durable delivery contract (owned by this feature — see Part A): notices are rows in
  `PendingRelayStore`, with a release hold implemented via the EXISTING `next_attempt_at`
  column (claim query already honors it; a rolled-back binary keeps honoring holds; no
  schema change). **Origin carrier:** the origin tag rides the `delivery_id` primary key as
  a prefix (`reap-notify:<noticeId>`) — truly zero DDL, PK-dedupe for free. Both drains
  scope their claim QUERIES on it (ReapNoticeDrain claims `delivery_id LIKE 'reap-notify:%'`;
  DFS's `selectClaimable` gains the complementary `NOT LIKE` filter), and the claim itself is
  a CAS UPDATE (`WHERE state='queued' OR claim-lease-expired`) so two drains can never
  double-claim a row — the single-owner contract lives in the queries, not in drain
  etiquette. The tag is a routing label inside the trusted local process boundary, not an
  auth boundary (anything that can write this store can already read the bot token).
  Rollback note: a rolled-back binary has no origin filter — with DFS default-OFF, orphaned
  notice rows are simply reclaimed by the old purge; accepted. Prefix discipline is
  centralized: delivery ids are built and parsed by ONE typed helper, and the contract tests
  assert every store path (claim, purge, metrics, repair) preserves prefix semantics — no
  caller hand-assembles the string, and the prefix filter is written as an index-compatible
  range predicate on the PK (`delivery_id >= 'reap-notify:' AND delivery_id < 'reap-notify;'`
  or equivalent), never a bare `LIKE` SQLite can't serve from the PK index — the 30s
  always-on drain must not be a latent table scan. A dedicated, always-on
  **ReapNoticeDrain** (ships with Part A, independent of the DFS flag; 30s tick; idle cost
  is one indexed claim query — ~zero on an empty store; per-pass send cap 15 to stay under
  Telegram's per-group rate, remainder picked up next tick) delivers via direct adapter send
  (`sendToTopic`) — NOT `/telegram/reply` — so the relay's tone gate, whoami check, and
  duplicate-suppression are structurally off this path (notices carry per-notice distinct
  content anyway). Bounded retries: store-backed backoff, `maxAttempts` 8, then terminal
  escalation into the aggregated attention surface. Outcome records: a `type:'notify'`
  reap-log record is APPENDED at enqueue (`outcome:'enqueued'`) and a second record APPENDED
  at terminal state (`sent` / `send-failed-escalated` / `no-topic` / `enqueue-failed`) —
  append-only JSONL, latest record per noticeId wins on read; updates are event-driven from
  the drain owner, not polled. Enqueue failure (store probe-failed/disabled) falls back to
  ONE direct immediate send attempt, recorded `enqueue-failed` with the send result, and
  raises the aggregated degradation surface — the guarantee degrades loudly, never silently.
- R1.4 Intentional silences remain and are recorded as such: `recovery-bounce` and
  `origin:'operator'`. Everything else notifies.
- R1.5 Flood bounds: messages per flush ≤ affected existing topics; at most
  `maxImmediatePerFlush` (default 5) notices get an immediate release in one flush — the rest
  fall back to SUMMARY-window release (still durable, still per-topic). The drain's per-pass
  send cap (15 per 30s tick, ~30/min) is the GLOBAL release throttle: a worst-case 500-topic
  storm enqueues 500 durable rows but sends them over ~17 minutes, under Telegram's rate
  limits, while the store holds the backlog — durable AND rate-acceptable.
- R1.6 **In-scope store fix:** the restore-purge cutoff becomes
  `max(attempted_at, next_attempt_at)` (a row held for the future is not stale), with a
  held-row-across-restart unit test. This fixes the documented 2026-06-05 loss class for ALL
  rows, not just reap notices. Anomaly clamp: a `next_attempt_at` more than 7 days in the
  future is treated as corrupt at restore-purge (purged + logged) — no legitimate writer
  holds that long, and without the clamp a malformed row would now live forever.

**R2 — Mid-work reaps are tagged, queued, and resumed in order once resources recover.**
- R2.1 Work evidence is supplied by the KILLER at its decision point via `terminateSession`
  opts (`opts.workEvidence`), clamped to the enum at the chokepoint. Killer inventory:
  - `SessionMigrator` (quota-shed): computes evidence BEFORE its Ctrl+C grace round → eligible.
  - `SessionReaper` (age-limit / idle paths): passes its pre-relaxation verdict; a
    `bypassActiveProcessKeep` kill means the reaper PROVED idle — `active-process` excluded.
  - `SessionWatchdog` terminal stuck-kills: evidence stamped for observability but **never
    resume-eligible** — a stuck session is not interrupted work; resuming recreates the wedge,
    and watchdog escalation owns that recovery.
  - Context-wedge / compaction / pool-transfer closeouts: recovery-bounce or
    `topic moved` dispositions — never enqueue (and drain-time validation backstops).
  - Boot purge of `knownDead`: stamping skipped entirely.
  - Chokepoint fallback (`ReapGuard.workEvidence()`, observe-only, work-positive closures
    only) applies when the killer supplied nothing; documented expected-empty for
    guard-cleared kills; closure errors → NO evidence (overriding the closures' internal
    keep-true fail-safe — correct for blocking a kill, wrong for asserting work); at pressure
    tier `critical`, fork-based closures are skipped and `unverified-under-pressure` stamped.
  `midWork` = any non-marker evidence; stamped on the `sessionReaped` event, the reap-log
  entry (normalizer extended), and the session record (`endedMidWork`).
- R2.2 Resume *eligibility* is stricter than midWork: terminal + autonomous + (≥1 **strong**
  signal, OR topic-bound with ≥2 distinct weak signals). Weak-alone never queues. Job entries
  require the job to OPT IN with `resumeOnReap: true` (new optional JobDefinition field,
  **default false** — jobs already have cron recurrence as their recovery path, and instar
  jobs carry no idempotency contract, so a reap-triggered early re-run must be a deliberate
  per-job choice; older agents' job parsers ignore unknown fields, additive-safe). Sessions
  with NEITHER a topic binding NOR a jobSlug are excluded at enqueue (they would have no
  resume path at drain time anyway — saves queue slots and keeps the resurrection ledger's
  key-space to stable identities). Operator kills excluded by default
  (`includeOperatorKills:false`); recovery-bounces never.
- R2.3 The queue is durable (`state/resume-queue.json`; persist discipline: write temp →
  fsync temp → rename → fsync parent dir — rename alone is not crash-durable; a crash can
  lose at most the latest mutation, which boot reconciliation absorbs: a lost enqueue is
  re-created by the next re-reap, a lost transition replays as a failed attempt), in-memory
  authoritative with synchronous persist. Single-writer is ENFORCED, not assumed: a lockfile
  (`state/resume-queue.lock` carrying pid + hostname + heartbeat mtime, refreshed each tick)
  is taken at boot. Stale-lock recovery is automatic: a claimant finding an existing lock
  checks liveness (same host + `kill -0` on the pid + heartbeat younger than 5 min) — a dead
  or stale lock is safely reclaimed and logged; only a LIVE other process disables the queue
  (loudly, surfaced on the aggregated attention item). HARD INVARIANT: the state dir is
  host-local — a lock whose recorded hostname differs from this host is NEVER liveness-probed
  or reclaimed (pid checks are meaningless cross-host); it disables the queue loudly instead.
  Multi-process or shared-volume deployments are unsupported. A same-host crash never
  requires manual lock cleanup. The foreign-lock recovery path is operational and documented
  in the disable message itself: after verifying nothing else uses the state dir (host
  renamed, restored from backup), delete `state/resume-queue.lock` and restart — no
  privileged endpoint is added for this (keeping the API surface small; the condition is
  rare and already requires host-level access to create).
  Entries dedupe and the resurrection ledger key on **stable identity:
  `topicId ?? jobSlug ?? tmuxSession`** (tmux names regenerate per spawn — keying on them
  makes the cap dead code for jobs and fragile across topic renames). Bounded
  (`maxQueueSize` 50; overflow drops oldest-low-priority into the aggregated attention
  surface). Entry: `{ id, queuedAt, stableKey, sessionName, tmuxSession, topicId?,
  resumeUuid? (snapshot), jobSlug?, cwd, worktreePath?, priorityClass, reason, workEvidence,
  attempts, status }`. Corrupt file on load → sidecar-preserved
  (`resume-queue.corrupt-<ts>.json`), queue starts empty, aggregated attention raised —
  never a silent reset, never a crash; losing the tombstone ledger in this rare path is
  accepted and surfaced. (Persistence rationale — JSON file over a `PendingRelayStore`
  table, considered and declined: the relay store's schema, claim machinery, and purge
  lifecycle serve MESSAGE DELIVERY — a resume-queue entry is not a message, and coupling
  session-resume state into that store entangles two lifecycles, which is exactly the class
  of collision the R1.6 purge bug demonstrates; the queue is per-machine operational state
  deliberately excluded from backup/restore, human-inspectable in incident response, ≤50
  entries, single-owner. Revisit only if the lock/corruption surfaces ever fire in practice.)
- R2.4 Entry lifecycle: `queued → starting → respawned | failed | invalidated |
  gave-up:<why>`. (`respawned`, not "resumed": the drainer can verify the spawn is alive,
  but `--resume` attachment is not observable from outside the pane — the terminal state
  must not claim more than the system can see; R2.11's wording matches.) Pause is a
  QUEUE-GLOBAL flag, not an entry state — entries keep their states while the drainer is
  halted. Boot reconciliation: `starting` found at load = failed attempt (attempts++);
  additionally, recent reap-log `midWork:true` terminal autonomous entries (within
  `entryTtlHours`) with no corresponding queue entry or tombstone are re-enqueued — closing
  the crash window where an enqueue's persist was lost and the session never gets re-reaped
  (the reap-log, written at the kill chokepoint, is the recovery source of truth). The
  drainer tick (60s, re-entrancy-guarded) resumes AT MOST ONE entry per tick, only when ALL
  deterministic gates pass: pressure tier `normal` (shared `PressureGauge` extraction of
  SessionReaper's computation — one definition of "calm") for `requiredCalmTicks` (3);
  `QuotaManager.canSpawnSession`; session count below cap; no quota migration in flight.
  NEVER bypassable — the manual drain route may skip calm-ticks ONLY. Recovery-time
  envelope, stated: a full queue (50 entries) drains in ≥50 calm minutes BY DESIGN — the
  one-per-tick stagger is the operator's explicit "ordered queue so they don't all resume
  at once" requirement; batch drain was considered and deliberately rejected.
- R2.5 Ordering: `interactive` before `job` before `other`, then FIFO by reap time.
  `priorityClass` derived server-side ONLY (session record's topic binding / jobSlug at
  enqueue); nothing session-asserted.
- R2.6 Drain-time reality validation (immediately before spawn; any failure →
  `invalidated:<why>`, audited, folded into the aggregate surface — never a spawn):
  - no live or spawning session already bound to the topic (races the reactive resume);
  - the entry's `resumeUuid` snapshot still matches TopicResumeMap's current value;
  - topic placement still local (`topicOwnerElsewhere` — the dep SessionReaper already
    consults — false);
  - the topic's CURRENT project binding still matches the entry's `cwd` (a rebound topic
    must not get the old project resumed into it);
  - no operator stop instruction recorded for the topic since `queuedAt`;
  - for jobs: exists, not disabled, not CrashLoopPauser-paused, not run since `queuedAt`;
  - the entry's `cwd` (and `worktreePath`) still exists on disk.
- R2.7 **Emergency stop reaches the queue:** the MessageSentinel emergency-stop and
  `POST /autonomous/stop-all` set the queue-global pause flag (audited; entries and their
  states untouched); an explicit per-topic stop cancels that topic's entries. A paused
  queue never spawns, and mutation routes (requeue, manual drain) are refused 409 while
  paused — a Bearer holder cannot work around an operator stop. Pause FREEZES entry TTLs
  (an operator pause must not silently expire the queue), the paused flag is exposed in
  `GET /sessions/resume-queue` alongside `lastTickAt`/breaker, and the unpause lever is
  explicit: `POST /sessions/resume-queue/resume` (Bearer, audited) — a forgotten pause is
  visible, never a silent feature death.
- R2.8 Resume mechanics: the spawn path gains an explicit per-spawn `cwd`/`worktreePath`
  parameter (threaded through `spawnSessionForTopic`/SessionManager spawn — the seam does
  NOT exist today and is a named extension of this spec; L13). Topic-bound → respawn with
  the snapshot resume UUID + a continuation prompt; job → `scheduler.triggerJob(slug,
  'resume-queue')`. The continuation prompt treats entry fields as DATA: `reason`
  length-capped and delimited as literal text; `workEvidence` enum names only. No resume
  path → `invalidated`.
- R2.9 Failure ladder + brakes: spawn verified alive after a grace period; failure →
  attempts++ with backoff; `maxAttempts` (3) → `gave-up:max-attempts`; `entryTtlHours` (24)
  → `gave-up:ttl`. TTL semantics, stated deliberately: an INCIDENT-AGE cap — wall clock
  since reap, frozen only by operator pause, NOT by pressure. An entry that expires because
  the gates never opened all day is the CORRECT outcome (a 20-hour-stale resume is more
  likely wrong than right) and is surfaced, not silent: pressure-starved expiries carry a
  `pressure-starved` marker in the aggregated attention item so a day-long overload reads
  differently from ordinary staleness. The resurrection LEDGER (keyed on stableKey, surviving dequeue as
  tombstones, 24h reset window) increments on a re-reap after a successful resume;
  `maxResurrections` (2) → `gave-up:resurrection-cap`, explicitly surfaced (P14: the most
  diagnostic event this feature produces). The cap is deliberately per STABLE IDENTITY —
  it measures the operational health of the topic/job, not of one work item — so distinct
  interruptions of the same topic within the 24h window share the cap by design (a topic
  reaped-and-resumed twice in a day is unhealthy regardless of which task was interrupted). DRAINER CIRCUIT BREAKER: `breakerThreshold` (3)
  consecutive failed attempts across entries → draining pauses `breakerCooldownMin` (30),
  ONE aggregated degradation notice. ALL give-up classes (overflow, TTL, max-attempts,
  resurrection-cap, breaker, corruption, enqueue-failure) fold into ONE rolling deduped
  attention item updated in place; per-entry HIGH items are forbidden (P17: HIGH bypasses
  the topic-guard coalescer, so the bound lives at the emitter).
- R2.10 Audit + API: decision TRANSITIONS (not every tick) → `logs/resume-queue.jsonl`
  (size-capped rotation 5MB×2); `GET /sessions/resume-queue` (Bearer; includes `lastTickAt`,
  paused + breaker state so a wedged drainer is detectable); `POST /sessions/resume-queue/:id/cancel`;
  `POST /sessions/resume-queue/:id/requeue`; `POST /sessions/resume-queue/resume` (unpause);
  `POST /sessions/resume-queue/drain` (single-step; skips calm-ticks ONLY). All Bearer-auth.
  **Requeue clamps:** eligible from `gave-up:*` states ONLY — never `cancelled` (an
  operator per-topic stop) and refused 409 while the queue is paused (an emergency stop),
  so a Bearer holder cannot undo an operator stop; resets `attempts` and RE-ANCHORS the TTL
  clock (TTL keys on `max(queuedAt, requeuedAt)` — otherwise requeueing a `gave-up:ttl`
  entry would re-expire immediately, a dead lever) while PRESERVING the original `queuedAt`
  for the operator-stop and job-ran-since checks in R2.6; the resurrection ledger keeps
  counting — requeueing a `gave-up:resurrection-cap` entry grants exactly ONE additional
  resume as an audited deliberate override, and the next re-reap re-caps.
- R2.11 On resume, the topic gets an honest notice — "restarted this session to pick the
  work back up" (never "resumed" as a transcript claim: `--resume` can fail in-pane and fall
  back to a fresh conversation; the wording must not promise what spawn-verification cannot
  see). On give-up, the aggregated attention item says in plain English: "message the topic
  to bring it back, or ask me to retry it" (API details live in the audit payload, not the
  user body).

## Supervision (P7)

The ResumeQueueDrainer is a recovery loop holding real authority (spawns sessions, injects a
continuation prompt). Declared **Tier 1**, staged honestly (round-2 external review:
unjustified LLM gating is overhead, not safety):
- **During the dev-gated soak: observe-only.** Each about-to-resume decision gets a fast-tier
  LLM sanity check via `LlmQueue` ("given reason, evidence, age, resurrection history — is
  resuming sensible?"); the verdict is AUDITED but never defers. The prompt literal-delimits
  `reason` (same discipline as R2.8).
- **Promotion criterion:** the check graduates to advisory-defer (negative verdict holds the
  entry one tick, recorded) only if the soak shows ≥1 true catch (a verdict-driven tick-hold
  the deterministic gates would have let through and a human agrees was right). Otherwise it
  stays observe-only and the spec's supervision claim is downgraded honestly to
  "tier1-observed".
- Shed/unavailable/deadline-exceeded → deterministic gates proceed, audited
  `supervision:'shed'`; a verdict deadline (5s) prevents tick serialization. Never a silent
  blocker; never a bypass of deterministic gates.
- **The failure class only the LLM can read** (round-3 external review asked for it
  concretely), scoped to the fields the check actually receives (entry reason, evidence,
  age, resurrection history — it gets NO conversation context): an internal contradiction
  between reason and evidence (a "mid-work" entry whose own reason text describes completed
  work), a resurrection history whose pattern reads as a crash loop rather than interrupted
  work, a continuation prompt that contradicts the entry it was built from. Catching "the
  user said stop in different words" is NOT claimed — that is the deterministic
  operator-stop check's job (R2.6), which reads recorded stop instructions. The check is
  its own experiment lever (`resumeQueue.tier1Check`, code-default true; runs only where
  the queue is live) so it can be switched off without touching the queue.

**ReapNoticeDrain: tier0**, declared — deterministic delivery of pre-authored template
content, no LLM-authored text, same class as DFS's "deterministic state machine,
fixed-template escalation" precedent; its loop brakes are the store-backed backoff,
`maxAttempts` 8, the per-pass send cap, and terminal escalation (P19 bounds declared).

## Design

### Part A — ReapNotifier v2 (per-topic coalescing on an owned durable path)

1. Buffer: keep the bounded per-event detail buffer (drop-oldest), ADD an affected-set
   `Map<topicId, {count, mostSevere, midWorkCount}>` (hard cap 500 topics + overflow
   counter). R1.1 holds in any storm size.
2. On flush, group detail per topic; topics whose detail dropped get a count-only notice.
3. Each affected topic gets ONE message: sessions (or count), plain-English reason(s),
   mid-work tag, queued-resume line only when live. Lifeline gets unbound + cross-topic index.
4. Delivery rows (the contract, per R1.3): `{ delivery_id: 'reap-notify:<noticeId>',
   topicId, body, next_attempt_at: releaseAt, attempts }` in PendingRelayStore (the prefix
   IS the origin tag and the PK gives dedupe). Release:
   SUMMARY → batcher-window/quiet-hours-end; IMMEDIATE → now, or quiet-hours end (never wakes
   the user; a queued resume means the system is already handling it). ReapNoticeDrain
   (always-on, ships with Part A): claims due `reap-notify` rows, direct adapter send,
   bounded retries with backoff (reusing the store's attempts/next_attempt_at), terminal
   escalation into the aggregated attention surface; DFS configured to exclude
   `origin:'reap-notify'` where enabled. Restart behavior: rows persist; R1.6's purge fix
   keeps held rows alive; boot re-claim is idempotent via dedupeKey.
5. Outcome records per R1.3 (append-only pairs; event-driven). `normalizeEntry` extended to
   pass `type:'notify'` and carry `midWork`/`workEvidence` on reaped entries. Honest rollback
   note: a downgraded binary coerces `notify` records to phantom `reaped` rows on read
   (cosmetic; the JSONL is untouched); held relay rows keep their hold on rollback because
   the hold IS `next_attempt_at`.
6. Per-flush IMMEDIATE cap per R1.5.

### Part B — killer-stamped evidence + ResumeQueue

Components: evidence threading through `terminateSession` opts (R2.1, enum clamp at the
chokepoint), `ResumeQueue` (src/monitoring/ResumeQueue.ts; R2.2–R2.3), `ResumeQueueDrainer`
(R2.4–R2.10), shared `PressureGauge` extraction, Tier 1 check via `LlmQueue`, spawn-path cwd
parameter (R2.8), emergency-stop hook (R2.7).

Dequeue-side hard invariants (Signal-vs-Authority brittle-blocker exemption — these protect
`claude --resume` argv and the scheduler from corrupted state): `resumeUuid` UUID-format;
`priorityClass` enum; `jobSlug` charset-clamped; `reason`/`workEvidence` length-capped.
Failing entry → `invalidated:corrupt-entry`, audited.

### Config (`.instar/config.json` → `monitoring`)

```jsonc
"reapNotify": {
  "enabled": true,             // existing
  "coalesceWindowMs": 60000,   // existing
  "perTopic": true,            // NEW — v2 grouping; false = legacy single-buffer behavior
  "maxImmediatePerFlush": 5,   // NEW — registered in ConfigDefaults
  "drainEnabled": true         // NEW — CODE-defaulted (not in ConfigDefaults, same pattern
                               // as resumeQueue.*): surgical rollback for JUST the durable
                               // drain — false reverts delivery to the legacy direct send
                               // (grouping unaffected; R1's durability claim lapses, stated)
},
"resumeQueue": {
  // Classified in DARK_GATE_EXCLUSIONS (NOT DEV_GATED_FEATURES — that registry's admission
  // bar excludes cost-bearing features, and the drainer spawns sessions / makes LLM calls).
  // Posture: `dryRun` is CODE-DEFAULTED true (deliberately NOT written into ConfigDefaults,
  // so the later fleet flip of the shipped default actually takes effect); the dev agent
  // sets `dryRun:false` in its local config for the soak.
  "enabled": true,
  "dryRun": true,              // code default; observe-only: logs would-enqueue/would-resume
  "drainIntervalSec": 60,
  "requiredCalmTicks": 3,
  "maxAttempts": 3,
  "maxResurrections": 2,
  "entryTtlHours": 24,
  "maxQueueSize": 50,
  "breakerThreshold": 3,
  "breakerCooldownMin": 30,
  "includeOperatorKills": false,
  "tier1Check": true           // the observe-only LLM check's own experiment lever
}
```

Ship posture: Part A (incl. ReapNoticeDrain + the R1.6 purge fix) default-ON for the fleet —
a correctness fix to an already-default-on notifier; `perTopic:false` is the rollback lever.
Part B ships enabled+dryRun (observe-only) fleet-wide, live on the dev agent via local
config; fleet flip = change the shipped code default after the soak. THE SOAK MUST ASSERT
the core signal is real: at least one quota-shed kill of a genuinely-working session
producing a `midWork:true` entry (P14 — otherwise the soak validates the blindspot).

### Migration parity

- `ConfigDefaults.ts`: add `monitoring.reapNotify.perTopic` + `maxImmediatePerFlush` (nested
  merge adds missing keys; `reapNotify` exists at :168). `resumeQueue.*` deliberately NOT
  added (see Config). NO pending-relay schema migration (hold = existing column).
- CLAUDE.md template (`generateClaudeMd()`): update the Reap-Log section — notify records,
  mid-work tag, resume queue surface + proactive triggers. Ship via a NEW marker-keyed
  `migrateClaudeMd()` block (append-only mechanism), marker also added to the
  `migrateFrameworkShadowCapabilities` markers list (PostUpdateMigrator.ts:~5292) for
  Codex/Gemini shadows.
- `state/resume-queue.json` deliberately EXCLUDED from the BackupManager whitelist
  (per-machine state referencing local tmux/worktrees).
- Release-note fragment in the same PR: `upgrades/next/reap-notify-resume-queue.md`
  (bump: minor; plain-English "What to Tell Your User").
- Observability is API-only at ship; notices are the user surface.
- In-scope foundation fixes: SessionMigrator refusal recording (refusals ≠ halted — also
  fixes today's refused-but-alive double-respawn); pending-relay restore-purge hold exemption
  (R1.6) — which changes behavior the DFS spec documents, so the same PR updates the DFS
  spec's §3h prose AND the `purgeStaleClaimable` doc-comment to the new
  `max(attempted_at, next_attempt_at)` + 7-day-clamp semantics.
- No hook/skill changes.

### Testing (three tiers, per TESTING-INTEGRITY-SPEC)

- **Unit:** ReapNotifier v2 grouping (single, multi-topic burst, >buffer storm count-only,
  unbound, mixed; IMMEDIATE cap; outcome record pairs incl. `enqueue-failed` fallback;
  legacy mode + `drainEnabled:false` legacy-delivery mode; reason map both sides incl.
  unknown slug); ReapNoticeDrain (hold release, retries/backoff incl. the maxAttempts-8
  bound, per-pass send cap, terminal escalation, dedupeKey idempotent re-claim,
  origin-scoped CAS claim — two drains racing claim disjoint row sets, asserted at the
  query level); **held-row-across-restart purge test (R1.6) + far-future clamp both sides**;
  evidence threading
  (killer-supplied wins, chokepoint enum clamp drops unknown names, fallback expected-empty
  for guard-cleared, knownDead skip, closure-error → no evidence, critical-tier marker not
  eligible, watchdog-kill never eligible); eligibility classifier both sides (strong vs
  weak-alone vs topic-bound+2-weak; job opt-in default-false both sides; no-topic-no-job
  enqueue exclusion); ResumeQueue (enqueue rules, stable-key dedupe + resurrection ledger
  ACROSS job re-trigger chains with fresh tmux names AND across a topic rename, 24h reset,
  ordering, TTL, bounds, corrupt-file sidecar, lockfile stale-reclaim [dead pid / old
  heartbeat] vs live-claimant refusal, dequeue validators both sides, requeue clamps
  [gave-up-only eligibility, queuedAt preserved, resurrection-cap single-override]); Drainer
  (calm-ticks,
  one-per-tick, re-entrancy, state machine incl. boot reconciliation of `starting`, EACH
  drain-time validation both sides incl. binding-match and operator-stop, pause-on-emergency-
  stop both sides, pause-freezes-TTL + unpause route, failure ladder, breaker open/close,
  dry-run inertness, Tier1 observe-only + shed + deadline paths + tier1Check off-lever);
  PressureGauge extraction parity vs SessionReaper's computation + oscillating-load stress
  (calm-ticks reset behavior).
- **Integration:** resume-queue routes (cancel, requeue, manual-drain gate semantics); reap →
  durable notify record lifecycle (enqueued→sent and enqueued→send-failed-escalated via a
  failing adapter); full quota-shed simulation → migrator pre-grace evidence → per-topic
  notices + queue entries; migrator-refusal recording.
- **E2E lifecycle:** feature-alive — server boots with defaults, reap of a mid-work fixture
  produces topic notice + queue entry + drainer resume under relaxed gates, cwd round-trip
  asserted through the NEW spawn-path parameter (wiring integrity: pressure gauge, spawn
  gate, relay store, LlmQueue deps real and delegating).
- **Burst invariants (P17/P19):** N reaps across M topics → ≤M topic messages + 1 lifeline,
  ≤maxImmediatePerFlush immediate releases, zero new topics; K entries failing against a
  permanently-rejecting spawn target → attempts and per-attempt cost under declared bounds,
  breaker opens, exactly ONE aggregated attention item, zero per-entry items.

## Decisions (resolved 2026-06-11 per operator standing directive — design forks resolved
autonomously with the author's lean, reported after; amended through convergence rounds)

1. **Burst tier:** mid-work-with-queued-resume notices release IMMEDIATE outside quiet hours,
   quiet-hours-end inside them; all other notices use SUMMARY-window release. Capped per R1.5.
2. **Part B fleet posture:** DARK_GATE_EXCLUSIONS classification; enabled+dryRun code-default
   fleet-wide; dev agent flips dryRun locally; fleet flip = shipped-default change after a
   soak that demonstrates a true-positive midWork stamp (P14).
3. **Operator kills:** excluded from notify + resume queue (a deliberate kill is not a
   disappearance); `includeOperatorKills` exists for the opposite.
4. **Delivery ownership (round 2):** reap notices get their OWN always-on drain over the
   shared durable store rather than depending on the default-OFF DFS or flipping DFS fleet-wide
   in this PR (smaller blast radius; DFS's §3i canary criteria stay undisturbed).

## Out of scope

- Cross-machine resume placement (session pool owns it; `topicOwnerElsewhere` is the seam).
- Lite-mode / agent-sleep tiering (parent exploration — separate spec).
- Reaper kill-decision changes (this spec observes and recovers).
- Dashboard tab (API + notices suffice at ship).
- `ReapLog.read()` full-file read cost at 100k+ entries (pre-existing; marginal added volume;
  follow-up if `/sessions/reap-log` latency surfaces). <!-- tracked: topic-24662 -->

- Flipping `deliveryFailureSentinel.enabled` fleet-wide (its own spec's canary criteria govern
  that; this PR only fixes the store-level purge bug it shares).
