# Upgrade Guide — Per-Topic Reap Notices + Mid-Work Resume Queue

<!-- bump: minor -->

```yaml user_announcement
- audience: user
  maturity: stable
  text: "When sessions get shut down automatically (low memory, usage limits, idle cleanup), each affected conversation now gets its own plain-English notice — and delivery is guaranteed: notices queue durably and retry until they land, even across server restarts. Previously a burst of shutdowns produced one easy-to-miss summary in the system topic, and a failed send was silently lost."
- audience: user
  maturity: preview
  text: "New (observe-only for now): sessions killed in the MIDDLE of real work are tagged and queued for automatic revival — once your machine has recovered, they restart one at a time, in order, and tell you they're picking the work back up. It ships in watch-mode while we verify the detection on real workloads."
```

## What Changed

Implements `docs/specs/reap-notify-per-topic-and-midwork-resume-queue.md` (converged 7 iterations with GPT-5.5 + Gemini 2.5 Pro cross-review, operator-approved 2026-06-12, topic 24662 — "reaped sessions should ALWAYS notify the user in the corresponding topic, and mid-work reaps need a persistent resume mechanism").

**Part A — per-topic durable reap notices (default ON):**
- `ReapNotifier` v2: per-topic coalescing — every topic that lost a session gets ONE notice in THAT topic (plain-English reasons, mid-work tag); the lifeline gets unbound sessions + a cross-topic index. Affected-set tracking is separate from the detail buffer, so storms still produce correct per-topic counts. Rollback: `monitoring.reapNotify.perTopic: false`.
- Durable delivery: notices are `reap-notify:`-prefixed rows in the shared PendingRelayStore (release holds ride the existing `next_attempt_at` column — zero DDL), drained by a NEW always-on `ReapNoticeDrain` (30s tick, CAS claims, per-pass cap 15, backoff to 8 attempts, terminal escalation into ONE aggregated attention item). Independent of the default-OFF DeliveryFailureSentinel. Rollback: `monitoring.reapNotify.drainEnabled: false`.
- **Store-level fix for everyone (R1.6):** the pending-relay restore-purge cutoff is now `max(attempted_at, next_attempt_at)` with a 7-day corruption clamp — a message HELD for future release no longer gets eaten at boot (the 2026-06-05 silent-deletion class, fixed for ALL rows, not just reap notices).
- Outcome records: every notice attempt lands in the reap-log as `type:'notify'` pairs (`enqueued` → `sent`/`send-failed-escalated`/`no-topic`/`enqueue-failed`) — "did the user get told?" is now auditable.

**Part B — mid-work tagging + resume queue (ships enabled + dry-run observe-only):**
- Killers supply work evidence at THEIR decision point (the quota-shed migrator snapshots it BEFORE its Ctrl+C grace round tears the work down); the single kill chokepoint clamps it to an exact enum and stamps `midWork` on the event, the reap-log, and the session record.
- `ResumeQueue`: durable per-machine queue (fsync persist discipline, single-writer lockfile with same-host stale reclaim + foreign-host loud-disable, corrupt-file sidecar, boot reconciliation from the reap-log). Eligibility is stricter than midWork: ≥1 strong signal (or topic-bound + 2 distinct weak); jobs opt in via `resumeOnReap: true` (default false); operator kills excluded by default.
- `ResumeQueueDrainer`: revives AT MOST ONE entry per minute, only after 3 consecutive calm pressure ticks + quota headroom + session-cap + no migration in flight. Seven drain-time reality validations re-check the world before any spawn. Failure ladder: 3 attempts with backoff → gave-up; resurrection cap (2 per identity per 24h) kills kill-resume-kill loops; circuit breaker on consecutive failures. ALL give-up classes fold into ONE rolling attention item.
- Emergency stops reach the queue: stop-all/MessageSentinel stops pause it (TTLs frozen, mutation routes 409); per-topic stops cancel that topic's entries; explicit unpause via `POST /sessions/resume-queue/resume`.
- New spawn-path capability: sessions can now be spawned with an explicit per-spawn `cwd`, so interrupted worktree work resumes in ITS tree.
- Tier 1 supervision (observe-only during the soak): each about-to-resume decision gets an audited fast-tier LLM sanity check that never defers.

**Foundation fixes pulled in-scope (no deferrals):**
- `SessionMigrator` no longer records a ReapGuard REFUSAL as "halted" — refused-but-alive sessions are no longer double-respawned after a quota migration.
- The reap-log normalizer no longer strips `launchLane` on read.

**Migration parity:** ConfigDefaults gains `reapNotify.perTopic` + `maxImmediatePerFlush` (resumeQueue keys deliberately code-defaulted for the later fleet flip); new content-sniffed `migrateClaudeMd()` section + framework-shadow marker; `state/resume-queue.json` registered machine-local (excluded from backup/restore).

## What to Tell Your User

- "When the system shuts down your sessions (low memory, usage limits), each affected conversation now gets its own clear notice — and the notice can't be silently lost anymore, even across restarts."
- "Coming online in watch-mode: sessions killed mid-work get queued and automatically restarted one at a time once your machine recovers, picking the work back up."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Per-topic shutdown notices | Automatic — each affected topic is told, in plain English |
| Durable notice delivery | Automatic — `reap-notify` rows in the pending-relay store, always-on drain |
| Notice audit trail | `GET /sessions/reap-log` — `type:'notify'` outcome pairs |
| Mid-work tagging | reap-log + session records carry `midWork` + `workEvidence` |
| Resume queue state | `GET /sessions/resume-queue` (entries, paused, breaker, lastTickAt) |
| Queue levers | `POST /sessions/resume-queue/:id/cancel` · `/:id/requeue` · `/resume` · `/drain` |
| Job opt-in | `resumeOnReap: true` on a job definition |

## Evidence

- Tier-1: `tests/unit/pending-relay-store.test.ts` (R1.6 + origin scoping + CAS), `reap-log.test.ts`, `work-evidence.test.ts`, `session-migrator.test.ts` (pre-grace evidence + refusal recording), `reap-notifier.test.ts` (v2 matrix + legacy modes), `reap-notice-drain.test.ts`, `resume-queue.test.ts`, `resume-queue-drainer.test.ts`.
- Tier-2/3: resume-queue route integration + reap→durable-notify lifecycle + feature-alive E2E (same PR).
- Side-effects artifact: `upgrades/side-effects/reap-notify-resume-queue.md`.
