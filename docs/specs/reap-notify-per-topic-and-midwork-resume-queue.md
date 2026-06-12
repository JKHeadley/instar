---
title: "Per-Topic Reap Notification + Mid-Work Resume Queue"
slug: "reap-notify-per-topic-and-midwork-resume-queue"
author: "echo"
status: "in-convergence"
supervision: "tier1"
lessons-engaged:
  - "P2 Signal-vs-Authority — engaged: the drainer's deterministic gates are spawn *eligibility* checks (quota, cap, pressure), all pre-existing authorities; the new Tier 1 LLM check is advisory-and-audited, never a silent blocker. Hard-invariant validators on dequeued entries (UUID format, enums) use the documented brittle-blocker exemption."
  - "P3 Migration Parity — engaged: ConfigDefaults registration for reapNotify.perTopic; resumeQueue keys deliberately code-defaulted (NOT in ConfigDefaults) so the later fleet flip of the shipped default actually takes effect; new marker-keyed CLAUDE.md block + framework-shadow markers list."
  - "P4 Testing Integrity — engaged: all three tiers specified, including the feature-alive E2E and wiring-integrity tests."
  - "P7 LLM-Supervised Execution — engaged: ResumeQueueDrainer declared Tier 1 (shed-tolerant LLM sanity check on each resume decision via LlmQueue); see 'Supervision'."
  - "P14 Distrust Temporary Success — engaged: resurrection-cap exhaustion is surfaced as the most diagnostic event the feature produces, never a silent stop; dry-run soak must assert quota-shed kills of working sessions actually stamp midWork:true (otherwise the soak validates a blindspot)."
  - "P17 Bounded Notification Surface — engaged: per-topic notices bounded by affected existing topics; ALL attention-item emissions aggregate into one rolling deduped item; burst-invariant test extended to the attention path; per-flush IMMEDIATE cap."
  - "P18 Observation Needs Structure — engaged: killer-supplied work evidence (the chokepoint re-check is blind for guard-cleared kills by construction); notify outcomes durably recorded; every drainer decision audited."
  - "P19 No Unbounded Loops — engaged: drainer-level circuit breaker across entries + per-entry attempts/backoff/TTL/resurrection caps + sustained-failure test with declared bounds."
  - "L7 Verify Runtime State — engaged: round-1 review caught the spec asserting a durable delivery path that does not exist; the design now builds one (see Part A delivery contract)."
  - "L13 Parallel Dev Isolation — engaged: queue entries carry the killed session's explicit cwd + worktree; resume respawn passes them explicitly; wiring test asserts round-trip."
  - "B1/B29 user-message quality — engaged: plain-English reason map for user-facing notices; no curl pointers in user-facing bodies."
  - "dev-gate registry (author memory: dark-features-must-dogfood-on-echo) — engaged: resumeQueue registers in DEV_GATED_FEATURES (live on dev agents, observe-only elsewhere) instead of inventing a third posture."
  - "L10 release notes in same PR — engaged: upgrades/next fragment in the ship checklist."
  - "P10 — no deferrals are requested by this spec; the one foundation fix it surfaces (SessionMigrator ignoring terminateSession refusal) is pulled in-scope."
eli16-overview: "docs/specs/reap-notify-per-topic-and-midwork-resume-queue.eli16.md"
---

# Per-Topic Reap Notification + Mid-Work Resume Queue

**Origin:** Operator directive (topic 24662, 2026-06-11): improve the session reaping process —
(1) reaped sessions should ALWAYS notify the user in the corresponding topic/channel;
(2) sessions reaped mid-work should be tagged as such, and a persistent mechanism should
look for opportunities to resume them (ordered queue, not all at once) once resources recover.

**Grounding incident:** 2026-06-11 machine overload — 7 always-on agent stacks drove a 16-core
box to load 20+; quota-shed and age-limit reaps killed working sessions. The reap-log recorded
them (`reason:"quota-shed"` skips, then `reason:"age-limit"` terminal reaps), but users saw at
most one consolidated lifeline message, and the killed mid-work sessions stayed dead until a
user happened to message their topic.

## What exists today (v1.3.487, file:line grounded — corrected by round-1 review)

- **Single kill authority:** `SessionManager.terminateSession` (src/core/SessionManager.ts:764)
  — CAS + in-flight guard, protected/lease/ReapGuard KEEP gates, exactly-once
  `beforeSessionKill` / `sessionComplete` / `sessionReaped` emission. All meaningful killers
  route through it (SessionWatchdog src/monitoring/SessionWatchdog.ts:630, OrphanProcessReaper:205,
  QuotaManager enforced kills via migrator dep src/monitoring/QuotaManager.ts:341, age-limit
  SessionManager.ts:1184, idle-zombie :1330, boot purge :2698).
- **ReapLog** (src/monitoring/ReapLog.ts): append-only `logs/reap-log.jsonl`, entry types
  `reaped` / `skipped`. **No mid-work indicator. No notification-outcome record.** CAUTION for
  this design: `normalizeEntry` (ReapLog.ts:122–143) coerces unknown `type` values to
  `'reaped'` and strips non-whitelisted fields (it already drops `launchLane` today) — the new
  entry type and fields MUST be added to the normalizer or they vanish on read.
- **ReapNotifier** (src/monitoring/ReapNotifier.ts): listens to `sessionReaped`, default-enabled,
  silent for `disposition:'recovery-bounce'` and `origin:'operator'`. Coalesces in a 60s window;
  **>1 reap → ONE consolidated message to the LIFELINE topic only** (ReapNotifier.ts:116-119) —
  affected topics get nothing. Buffer is bounded (`maxBuffer:100`, drop-oldest), so in a >100-reap
  storm even the consolidated message undercounts per-topic detail.
- **Delivery is fire-and-forget today.** The notifier's `send` dep is `notify('SUMMARY', …)`
  (src/commands/server.ts:2282, :5380) → `NotificationBatcher`, whose actual send
  (`sendDirect`, src/messaging/NotificationBatcher.ts:304-315) catches errors, console-logs,
  and retries nothing. `PendingRelayStore`/`DeliveryFailureSentinel` serve the `/telegram/reply`
  relay path only — they do NOT back the notify gateway. Any "always notifies" requirement built
  directly on `notify()` is built on a lossy path; Part A therefore changes the delivery contract.
- **Mid-work knowledge exists at evaluation time but is discarded at kill time** — and the kill
  chokepoint is the WRONG place to recompute it. ReapGuard (src/core/ReapGuard.ts) holds the
  work-positive KEEP closures, but an autonomous kill only reaches `terminateSession`'s body
  when those closures returned nothing (or a named bypass fired) — so a chokepoint re-run is
  empty by construction for guard-cleared kills. Worse, the motivating kill class (quota-shed)
  flows through `SessionMigrator.haltAllSessions`, which sends Ctrl+C and waits a grace period
  BEFORE calling `terminateSession` (src/monitoring/SessionMigrator.ts:~585-615) — by stamp
  time the work is already torn down. Evidence must come from the killer, at its decision point.
- **Foundation flaw surfaced by review, pulled in-scope:** `SessionMigrator.haltAllSessions`
  discards `terminateSession`'s result and records the session `halted` unconditionally
  (SessionMigrator.ts:608-616) — a ReapGuard refusal is silently counted as a halt. Fixed in
  this PR: check `terminated`, record refusals separately in the migration outcome.
- **Resume machinery exists but is purely reactive:** TopicResumeMap captures the resume UUID
  on `beforeSessionKill`; the next *user message* on the topic respawns with `--resume`.
  There is no deferred-resume queue, no resource-recovery watcher, no ordered drain.

## Requirements

**R1 — A reaped session always produces a durably-enqueued, eventually-delivered notice in
its corresponding topic/channel.** ("Always" = guaranteed durable enqueue + retried delivery
+ recorded outcome — NOT bypassing quiet hours.)
- R1.1 Per-topic delivery even in bursts: every topic that lost a session gets a notice in
  *that topic*; the lifeline gets unbound sessions + (when >1 topic affected) a one-line
  cross-topic index. Never creates new topics. In a storm larger than the detail buffer, every
  affected topic still gets at least a correct count (topic membership is tracked separately
  from per-event detail; see Part A step 2).
- R1.2 The notice states the reason in plain English (reason-slug → plain-English map; unknown
  slugs get a generic sentence with the slug parenthesized), whether the session was mid-work,
  and — only when the resume queue is LIVE (not dry-run) — its resume-queue position. No raw
  curl/API pointers in user-facing bodies.
- R1.3 Durable delivery + auditable outcome: per-topic notices are enqueued into the existing
  durable relay layer (`PendingRelayStore`, drained with retry + escalation by
  `DeliveryFailureSentinel`), extended with an optional `notBefore` release timestamp so tier
  semantics survive durability (SUMMARY → notBefore = batcher window end / quiet-hours end;
  IMMEDIATE → now, or quiet-hours end if inside quiet hours). Every notice writes a
  `type:'notify'` reap-log record at enqueue (`outcome:'enqueued'`) and is updated on the relay
  store's terminal delivery state (`sent` / `send-failed-escalated` / `no-topic`). "Did the
  user get told?" is a read.
- R1.4 Intentional silences remain and are recorded as such: `recovery-bounce` and
  `origin:'operator'`. Everything else notifies.
- R1.5 Flood bounds: messages per flush ≤ affected existing topics; at most
  `maxImmediatePerFlush` (default 5) notices ride IMMEDIATE release in one flush — the rest of
  that flush's mid-work notices fall back to SUMMARY release (still durable, still per-topic).

**R2 — Mid-work reaps are tagged, queued, and resumed in order once resources recover.**
- R2.1 Work evidence is supplied by the KILLER at its decision point and passed through
  `terminateSession` opts (`opts.workEvidence: string[]`, values clamped to the known
  closure-name enum + killer-specific names):
  - `SessionMigrator` computes evidence BEFORE its Ctrl+C grace round (it already evaluates
    `isBuildOrAutonomousActive` there; that check becomes evidence).
  - `SessionReaper` passes its pre-relaxation verdict; a `bypassActiveProcessKeep` kill means
    the reaper PROVED the session idle — `active-process` is excluded from its evidence.
  - The chokepoint fallback (`ReapGuard.workEvidence(session)`, a new observe-only method
    running ONLY work-positive closures) applies when the killer supplied nothing; it is
    documented as expected-empty for guard-cleared kills, is skipped entirely for `knownDead`
    boot purges, treats closure errors as NO evidence (overriding the closures' internal
    keep-true fail-safe — correct for blocking a kill, wrong for asserting work), and at
    pressure tier `critical` skips fork-based closures, stamping
    `workEvidence:['unverified-under-pressure']` (which is NOT resume-eligible).
  `midWork = workEvidence.length > 0` (excluding the `unverified-under-pressure` marker) is
  stamped on the `sessionReaped` event, the reap-log entry (fields added to `normalizeEntry`),
  and the persisted session record (`endedMidWork`).
- R2.2 Resume *eligibility* is stricter than midWork (observability ≠ resurrection): an entry
  is enqueued only for a terminal, autonomous reap whose evidence includes at least one
  STRONG signal — killer-asserted work (migrator pre-grace build/autonomous-active), active
  subagent, pending injection, open commitment, or structural-long-work — OR a topic-bound
  session with ≥2 distinct work signals. Bare `active-process` or `main-process-active` alone
  is NOT resume-eligible (gameable with one `sleep` child; contradicts an idle-proven verdict).
  Operator kills do not enqueue by default (`resumeQueue.includeOperatorKills: false`);
  recovery-bounces never enqueue.
- R2.3 The queue is durable (`state/resume-queue.json`, atomic write-rename), in-memory
  authoritative with synchronous persist (single writer: the agent server process; one drainer
  per agent), survives restarts, deduped per tmuxSession (re-reap replaces the entry), bounded
  (`maxQueueSize` 50; overflow drops oldest-low-priority, folded into the aggregated attention
  surface — never per-drop items). Entry: `{ id, queuedAt, sessionName, tmuxSession, topicId?,
  resumeUuid? (snapshot at enqueue), jobSlug?, cwd, worktreePath?, priorityClass, reason,
  workEvidence, attempts, status }`. A corrupt/unparseable file on load is sidecar-preserved
  (`resume-queue.corrupt-<ts>.json`), the queue starts empty, and the event lands on the
  aggregated attention surface — never a silent reset, never a crash. (Persistence rationale:
  a flat JSON file over SQLite — the queue is ≤50 entries, single-writer, atomic-rename
  suffices, and file-based state is this project's documented default; the WAL-backed stores
  exist only where multi-process writers do.)
- R2.4 Entry lifecycle is an explicit state machine: `queued → starting → resumed | failed |
  invalidated | gave-up:<why>`. Boot reconciliation: entries found in `starting` are treated
  as a failed attempt (attempts++). The drainer tick (default 60s) is re-entrancy-guarded
  (a tick that is still spawning skips) and resumes AT MOST ONE entry per tick, only when ALL
  deterministic gates pass:
  - pressure tier `normal` (shared `PressureGauge` extraction of SessionReaper's existing
    memory+CPU computation — one definition of "calm") for `requiredCalmTicks` (default 3);
  - `QuotaManager.canSpawnSession` passes; session count below cap; no quota migration in
    flight. These gates are NEVER bypassable — including by the manual drain route, which may
    skip calm-ticks only.
- R2.5 Ordering: priority class first — `interactive` before `job` before `other` — then FIFO
  by reap time. `priorityClass` is derived server-side ONLY (session record's topic binding /
  jobSlug at enqueue time); nothing session-asserted is consulted.
- R2.6 Drain-time reality validation (all checked immediately before spawn; any failure →
  `invalidated` with the audited reason, folded into the aggregate surface, never a spawn):
  - no live or spawning session already bound to the topic (covers the race with the reactive
    TopicResumeMap user-message resume — the double-session class);
  - the entry's `resumeUuid` snapshot still matches TopicResumeMap's current value for the
    topic (a newer session superseded it → stale, invalidate);
  - topic placement is still local (`topicOwnerElsewhere` — the dep SessionReaper already
    consults at src/monitoring/SessionReaper.ts:249 — false);
  - for job entries: the job exists, is not disabled, is not CrashLoopPauser-paused, and has
    not run since `queuedAt` (no double execution);
  - the entry's `cwd` (and `worktreePath` if set) still exists on disk.
- R2.7 Resume mechanics reuse the existing spawn path `POST /sessions/refresh` uses, passing
  the entry's explicit `cwd`/worktree (L13: never inherit the spawner's cwd). Topic-bound →
  respawn with the snapshot resume UUID + a continuation prompt; job → `scheduler.triggerJob
  (slug, 'resume-queue')`. The continuation prompt treats entry fields as DATA: `reason` is
  length-capped and delimited as literal text; `workEvidence` is the enum names only. No
  resume path available → `invalidated`, aggregated surface.
- R2.8 Failure ladder + brakes: spawn verified alive after a grace period; failure →
  attempts++ with backoff; `maxAttempts` (default 3) → `gave-up:max-attempts`. Entry TTL
  (`entryTtlHours` 24) → `gave-up:ttl` (a stale resume can be wrong). A per-tmuxSession
  resurrection LEDGER survives dequeue (retained as tombstones in the queue state, 24h
  window): a re-reap after a successful resume increments it; `maxResurrections` (default 2)
  → `gave-up:resurrection-cap` — explicitly surfaced (P14: a session killed→resumed→killed
  twice is the most diagnostic event this feature produces), never a silent stop; the ledger
  resets after 24h without a re-reap. DRAINER CIRCUIT BREAKER: `breakerThreshold` (default 3)
  consecutive failed resume attempts across entries opens the breaker — draining pauses for
  `breakerCooldownMin` (default 30), ONE aggregated degradation notice. All give-up classes
  (overflow, TTL, max-attempts, resurrection-cap, breaker-open, corruption) fold into ONE
  rolling deduped attention item ("resume queue degraded — N entries: list"), updated in
  place; per-entry HIGH items are forbidden (P17 — HIGH bypasses the topic-guard coalescer
  by design, so the bound must live here at the emitter).
- R2.9 Every drainer decision transition (resumed / starting / invalidated:<why> /
  gave-up:<why> / breaker-open/closed / deferred-reason CHANGES only, not every tick) is
  audited to `logs/resume-queue.jsonl` (size-capped rotation, default 5MB×2) and served at
  `GET /sessions/resume-queue` (Bearer-auth, read-only; includes `lastTickAt` and breaker
  state so a wedged drainer is detectable). `POST /sessions/resume-queue/:id/cancel` and
  `POST /sessions/resume-queue/drain` (single-step; skips calm-ticks ONLY) are Bearer-auth.
- R2.10 On resume, the topic gets a notice ("resumed after resource recovery"); on give-up,
  the aggregated attention item carries the manual lever (`POST /sessions/refresh`).

## Supervision (P7)

The ResumeQueueDrainer is a recovery loop holding real authority (it spawns sessions and
injects a continuation prompt). Declared **Tier 1**: each about-to-resume decision passes a
fast-tier LLM sanity check through the existing `LlmQueue` ("given this entry's reason,
evidence, age, and resurrection history, is resuming now sensible?") — advisory-and-audited:
a negative verdict defers the entry one tick and is recorded; a shed/unavailable verdict lets
the deterministic gates proceed, audited as `supervision:'shed'` (per-feature metrics record
the shed lane). The LLM is never a silent blocker and never a bypass of the deterministic
gates (Signal-vs-Authority: deterministic gates decide *eligibility*; the LLM adds judgment,
both outcomes visible).

## Design

### Part A — ReapNotifier v2 (per-topic coalescing on a durable path)

1. Buffer: keep the bounded per-event detail buffer (drop-oldest), and ADD an unbounded-safe
   affected-set: `Map<topicId, {count, mostSevere, midWorkCount}>` (tiny, grows only with
   topic count; hard cap 500 topics with an overflow counter). R1.1 holds in any storm size.
2. On flush, group buffered detail per topic; topics whose detail dropped out still get a
   count-only notice from the affected-set.
3. Each affected topic gets ONE message for the window: its sessions (or count), plain-English
   reason(s), mid-work tag, and queue position only when the queue is live. The lifeline gets
   the unbound list + (when >1 topic) the one-line cross-topic index.
4. Delivery: per-topic notices enqueue into `PendingRelayStore` with `notBefore` per tier
   (SUMMARY → batcher-window/quiet-hours-aligned; IMMEDIATE → now or quiet-hours end —
   IMMEDIATE never wakes the user; a queued resume means the system is already handling it).
   `DeliveryFailureSentinel` drains with its existing retry + fixed-template escalation. The
   notify gateway (`notify()`) is no longer on this path. Note: IMMEDIATE-tier Slack mirroring
   from the old gateway does NOT carry over; reap notices are Telegram-topic-scoped.
5. Outcome records: `ReapLog.recordNotify()` writes `{ ts, type:'notify', topicId,
   sessions:[...], outcome:'enqueued'|'sent'|'send-failed-escalated'|'no-topic', reason }`;
   the relay store's terminal state updates the record. `normalizeEntry` is extended to pass
   `type:'notify'` through and to carry `midWork`/`workEvidence` on reaped entries. Honest
   rollback note: a downgraded binary coerces `notify` records to phantom `reaped` rows on
   read (cosmetic; the JSONL itself is untouched) — there is no "older readers ignore unknown
   types" guarantee.
6. Per-flush IMMEDIATE cap per R1.5.

### Part B — killer-stamped evidence + ResumeQueue

Components: evidence threading through `terminateSession` opts (R2.1), `ResumeQueue`
(src/monitoring/ResumeQueue.ts, R2.2–R2.3), `ResumeQueueDrainer` (R2.4–R2.9), shared
`PressureGauge` extraction, Tier 1 check via `LlmQueue`.

Dequeue-side hard invariants (Signal-vs-Authority brittle-blocker exemption — these protect
`claude --resume` argv and the scheduler from corrupted state): `resumeUuid` must match UUID
format; `priorityClass` enum-checked; `jobSlug` charset-clamped; `reason`/`workEvidence`
length-capped. A failing entry is `invalidated:corrupt-entry`, audited.

### Config (`.instar/config.json` → `monitoring`)

```jsonc
"reapNotify": {
  "enabled": true,             // existing
  "coalesceWindowMs": 60000,   // existing
  "perTopic": true,            // NEW — v2 grouping; false = legacy single-buffer behavior
  "maxImmediatePerFlush": 5    // NEW
},
"resumeQueue": {
  // NO `enabled` key shipped: registers in DEV_GATED_FEATURES (live on dev agents,
  // observe-only/dry-run elsewhere) per the dev-gate lint. The fleet flip changes the
  // shipped default — possible ONLY because these keys are code-defaulted, NOT written
  // into ConfigDefaults (a written-out dryRun:true would make the flip a no-op).
  "drainIntervalSec": 60,
  "requiredCalmTicks": 3,
  "maxAttempts": 3,
  "maxResurrections": 2,
  "entryTtlHours": 24,
  "maxQueueSize": 50,
  "breakerThreshold": 3,
  "breakerCooldownMin": 30,
  "includeOperatorKills": false
}
```

Ship posture: Part A default-ON for the fleet (correctness fix to an already-default-on
notifier; `perTopic:false` is the reachable rollback lever). Part B rides the dev-gate: live
on dev agents immediately, dry-run (observe-only: logs would-enqueue/would-resume, sends no
queue-position wording) elsewhere; fleet flip after a soak window. THE SOAK MUST ASSERT the
core signal is real: at least one quota-shed kill of a genuinely-working session producing a
`midWork:true` entry (P14 — otherwise the soak validates the blindspot).

### Migration parity

- `ConfigDefaults.ts` (the actual mechanism `migrateConfig()` drives): add
  `monitoring.reapNotify.perTopic` + `maxImmediatePerFlush` (nested merge adds missing keys —
  `reapNotify` exists at ConfigDefaults.ts:168). `resumeQueue.*` deliberately NOT added (see
  Config above).
- CLAUDE.md template (`generateClaudeMd()`): update the Reap-Log section — notify records,
  mid-work tag, resume queue surface + proactive triggers ("where did my session go?" →
  reap-log; "will it come back?" → resume-queue).
- `migrateClaudeMd()` is append-only: ship the update as a NEW marker-keyed block
  (e.g. `resume-queue`), and add the marker to the `migrateFrameworkShadowCapabilities`
  markers list (PostUpdateMigrator.ts:~5306) so Codex/Gemini shadow files receive it.
- `state/resume-queue.json` is deliberately EXCLUDED from the BackupManager `includeFiles`
  whitelist (per-machine state referencing local tmux/worktrees; restoring it cross-machine
  would resume sessions that don't exist there).
- Release-note fragment in the same PR: `upgrades/next/reap-notify-resume-queue.md`
  (bump: minor; "What to Tell Your User" leads plain-English).
- Observability surface is API-only at ship (`GET /sessions/resume-queue`, reap-log routes);
  no dashboard tab in scope — notices themselves are the user surface.
- In-scope foundation fix: `SessionMigrator.haltAllSessions` checks `terminateSession`'s
  result; refusals recorded as `refused` in the migration outcome (not `halted`).
- No hook/skill changes.

### Testing (three tiers, per TESTING-INTEGRITY-SPEC)

- **Unit:** ReapNotifier v2 grouping (single, multi-topic burst, >buffer storm count-only
  notices, unbound, mixed; IMMEDIATE cap; outcome records; legacy mode; reason→plain-English
  map both sides incl. unknown slug); evidence threading (killer-supplied wins, fallback
  expected-empty for guard-cleared, knownDead skip, closure-error → no evidence, critical-tier
  skip marker not resume-eligible); resume-eligibility classifier both sides (strong signals
  enqueue; bare active-process does not); ResumeQueue (enqueue rules incl. operator/bounce
  exclusions, dedupe, resurrection ledger across dequeue + 24h reset, ordering, TTL, bounds,
  corrupt-file sidecar recovery, dequeue hard-invariant validators both sides); Drainer
  (calm-ticks, one-per-tick, re-entrancy guard, state machine incl. boot reconciliation of
  `starting`, drain-time validations EACH both sides, failure ladder, breaker open/close,
  dry-run inertness, Tier1 verdict defer + shed-proceed paths).
- **Integration:** `/sessions/resume-queue` routes (incl. cancel + manual drain gate
  semantics); reap → durable notify record lifecycle (enqueued→sent and enqueued→
  send-failed-escalated via a failing adapter); full quota-shed simulation → migrator
  pre-grace evidence → per-topic notices + queue entries; migrator-refusal recording.
- **E2E lifecycle:** feature-alive test — server boots with defaults, reap of a mid-work
  fixture session produces topic notice + queue entry + drainer resume under relaxed gates,
  with cwd round-trip asserted (wiring integrity: pressure gauge, spawn gate, relay store,
  LlmQueue deps real and delegating).
- **Burst invariants (P17/P19):** N reaps across M topics → ≤M topic messages + 1 lifeline
  message, ≤maxImmediatePerFlush IMMEDIATE, zero new topics; K queued entries failing to
  resume against a permanently-rejecting spawn target → attempts and per-attempt cost under
  declared bounds, breaker opens, exactly ONE aggregated attention item, zero per-entry items.

## Decisions (resolved 2026-06-11 per operator standing directive — design forks resolved
autonomously with the author's lean, reported after)

1. **Burst tier — RESOLVED (amended in convergence):** mid-work-with-queued-resume notices use
   IMMEDIATE release outside quiet hours and quiet-hours-end release inside them (never wake
   the user; the queue is already handling the resume); all other reap notices use SUMMARY
   release. Capped per R1.5.
2. **Part B fleet posture — RESOLVED (amended in convergence):** rides the DEV_GATED_FEATURES
   registry — live on dev agents immediately, observe-only elsewhere; fleet flip after a soak
   that must demonstrate a true-positive midWork stamp (P14).
3. **Operator kills — RESOLVED:** excluded from both the resume queue and (as today) the
   notifier. A deliberate kill is not a disappearance. `resumeQueue.includeOperatorKills`
   exists if an operator ever wants the opposite.

## Out of scope

- Cross-machine resume placement (session pool owns it; the drainer's `topicOwnerElsewhere`
  check is the seam that keeps the two from fighting).
- Lite-mode / agent-sleep tiering (the parent exploration this topic split from — separate spec).
- Reaper kill-decision changes (this spec observes and recovers; it does not alter who gets
  killed).
- Dashboard tab for the queue (API + notices suffice at ship; revisit on demand).
- `ReapLog.read()` full-file read cost at 100k+ entries (pre-existing; the notify records add
  marginal volume; a read-path cap is noted for a follow-up if `/sessions/reap-log` latency
  ever surfaces).
