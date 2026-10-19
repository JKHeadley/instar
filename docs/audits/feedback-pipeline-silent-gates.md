# Audit: silent gates in the feedback pipeline (and the paths that report on it)

Date: 2026-10-19. Topic 18330 (run run-mvfjbluq-1520f04e), Task C. Auditor: Echo (forked worker), Mac Studio.
Question: which gates can pause this pipeline, and does each raise exactly one attention item per episode when it trips?
Sources: `origin/main` @ bd340b087 and `origin/fix-feedback-readiness-pause-alarm` (#2201, with #2202 stacked); live state on the Studio (`GET /feedback-factory/*`, `GET /attention`, `GET /jobs`, `.instar/logs/telegram-origin-held.jsonl`, `.instar/watchdog-interventions.jsonl`).
Method: grep for every alarm surface (`createAttentionItem`, `raiseAttention`, `this.attention(`, `DegradationReporter.report`, attention ids) per gate, then read the trip path. A "no alarm" verdict below means those greps found nothing on that path, not that the grep was skipped.

Key finding that changes the meaning of "one item": `TelegramAdapter.createAttentionItem` returns the existing item for any id it already holds, OPEN or DONE (TelegramAdapter.ts:4120). An id scoped to a subject rather than an episode is therefore "one item ever", and every later episode is silent. Also: `DegradationReporter` does not reach the operator by default (`notifyUser` false unless `monitoring.degradationReporter.notifyUser` is true, server.ts:29178), so a degradation report is a log, not an alarm.

## Ranking (coordinator's order: unbounded first, then by silence length)

| # | Gate | Silence | Alarm before | Status |
|---|---|---|---|---|
| 1 | Watchdog interrupts a session's own wait (sleep in a poll loop / Monitor) | unbounded | none to the owning session | **Fixed, PR #2209** (sleep floor + one notice per interrupted process) |
| 2 | Write routes that apply some fields and ignore the rest (`PATCH /attention/:id` and ~20 siblings) | unbounded | none (200 OK) | **Fixed, PR #2208** (shared refusal + ratchet test); found `PATCH /api/files/config` ignored `{enabled}` entirely |
| 2b | PermissionPromptAutoResolver abstaining on a blocking prompt | unbounded | none (and no audit row) | Open, G8; the coordinator is measuring it with a live canary |
| 3 | Feedback readiness authority paused | 4 days | none | #2201 (pause alarm) + #2202 (stall alarm); post-2202 wall-clock gap = parent's Task A |
| 4 | CI run hung in progress | 19.8 h | none (GreenPrAutoMerger only surfaces an *armed* PR after 24 h) | Open, see G6 |
| 5 | Held Telegram reply / held forward | 6 h (fbacbf73); ~4 h today on topic 48154 | one item per topic **ever** | **Fixed, PR #2209** (episode-scoped ids) |

## Gate table

Feedback pipeline:

| Gate | Where | Alarm when it trips |
|---|---|---|
| Inbox drainer list/blob failures | InboxDrainer.ts:138-143 | **None** (counter + log; reports are safe in the cloud inbox) — G4 |
| Processing pass (clustering) | FeedbackProcessingService | None needed on its own: a stall shows up as drain progress age (Task A) |
| Drain tick refused: not canonical owner / nonce replay / restore pending | FeedbackDrainTickProxy, routes | None; healthy-by-design refusals (job prints a no-op) |
| Drain tick refused: readiness agent not current (paused authority) | TickProxy.acceptOwned | #2201: one item per (authority, generation) |
| Readiness brakes (spend cap, contract violation, drift) | FeedbackDrainService | #2201: one item per (authority, generation) |
| Readiness invocation failures (429, timeout) | FeedbackDrainService | #2202: one item per stall episode after 6 failed ticks |
| No successful readiness call for a long time while candidates are due, whether or not ticks run | — | Parent's Task A |
| Overdue collecting rows (live: 269, oldest 4.7 days) | FeedbackDrainStore | None. **For the parent** (G1) |
| Consumer dry-run / promotion not live | FeedbackConsumerPromotionStore | Deliberate operator dial, visible in status; no alarm by design |
| Triage authority awaiting-approval / paused / binding-stale | FeedbackTriageService.composeActionList | One line in the daily action list per (state, generation) |
| Triage authority-mismatch | FeedbackTriageService:666 | One HIGH item per generation |
| Triage self-heal exhausted / flapping | FeedbackTriageService:620, 648 | One item per episode |
| Triage quota pause (≥75% or unreadable) | FeedbackTriageService:276 | **None before; fixed in #2209** (one item per pause past 6 h with items waiting) |
| Triage ignore-rate brake | FeedbackTriageService:585 | Degradation report only (not operator-visible). Low impact: it holds new ignores, it does not stop work items |
| Executor approver-not-independent | FeedbackExecutorService.actionItems | One action-list line per approver (live today) |
| Executor auto-merge-disabled / approver-unset / publish-fork-unset / github-unavailable / no-source-repo | FeedbackExecutorService.refreshAvailability | **None** — G3 |
| Executor profile-unenforceable (canary) | :664 | One HIGH item per episode |
| Executor deps-unavailable | :681 | One item after the retry ladder is exhausted |
| Executor admission refusals (max-open-prs, quota-shedding, spawn-limiter, update-pending) | :474-482 | None; max-open-prs is covered indirectly by the "PR awaits approval" action-list lines — G3 |
| Executor dry-run | config | Deliberate operator dial; visible as `wouldStart` |
| Job skipped (quota shed, gate, paused, claimed, role-guard) | JobScheduler.ts:715-900 | **None** — skip ledger only. All four feedback jobs are `priority: low`, the first shed — G2 |
| Job consecutive failures | JobScheduler.alertOnConsecutiveFailures | Telegram alert per failure episode (threshold 3) |
| CrashLoopPauser pausing a job | server.ts:7781 | Console only (ships dry-run) — G5 |

Delivery and tooling paths named by the coordinator:

| Gate | Alarm before | Status |
|---|---|---|
| Held reply, lease-not-held (forward or direct) | `telegram-origin-held:<topic>` — one per topic ever | Fixed (#2209) |
| Held forward with last answer `outcome-unknown` | Delay notice skipped by design (OriginForwardToHolder.ts:246-248); item is the only voice, swallowed by an older open id | Fixed via the id scoping (#2209) |
| Held forward expiry | `telegram-origin-held:<topic>:expired` — per topic ever | Fixed: per operation (#2209) |
| Held ordinary reply, other hold reasons (origin-authority-unavailable, recording sinks unavailable…) expiring | In-memory `expiredHolds` only (TelegramOriginService.ts:426-433) | Open — G7 |
| Watchdog interrupting a session's command | Never told to the session | Fixed (#2209) |

## Gaps left open, with why

- **G1 — overdue collecting rows (for the parent, FeedbackDrainService/Store).** 269 rows are past their `nextReviewAt`, the oldest by 4.7 days, while the latest tick ended `readiness-time-exhausted-rest-due`. Each tick's 90 s wall clock is spent before the backlog drains, so the backlog only grows. Exposed as `overdueCollecting` / `oldestOverdueAgeMs`, no alarm. It fits Task A's progress-age alarm: due candidates exist and the oldest due one keeps getting older.
- **G2 — job starvation.** No alarm when a job is skipped for many cadences in a row. Generic scheduler work (one item when a job's last run is older than N × its cadence), larger than a cheap fix. Task A covers the drain side by wall clock; triage and execute stay uncovered.
- **G3 — executor unavailable for reasons other than approver independence.** Configuration states. Once the operator's approver tap lands, `auto-merge-disabled` or a broken `publishRepo` would stop every fix silently. Cheap: add those reasons to `actionItems()`. Not done here because the executor is held on the operator's tap and that path must not change under it this window.
- **G4 — inbox drainer failing.** Reports stay safe in the cloud inbox, so this is delay, not loss. Cheap follow-up: one item when `lastDrainAt` is older than 6 h with errors climbing.
- **G5 — CrashLoopPauser.** Ships dry-run; once live a pause disables a job with only a console line. Precede the live flip with one attention item per pause.
- **G6 — hung CI runs.** Nothing in instar watches in-progress age. The green-PR watcher sees only armed PRs and only after 24 h. A cheap watcher check: one item per run in progress for more than 2 h on an instar PR.
- **G8 — permission-prompt resolver abstention is unannounced and unaudited** (coordinator's instance #7). Two blocking prompts on the coordinating session tonight (a `Switch model?` menu and a dangerous-rm hook prompt reading only "Do you want to proceed? 1. Yes / 2. No") were neither auto-answered nor reported. From the source: Layer 2 (auto-approve) is an allowlist that needs at least two named prose patterns, so a hook prompt carrying only "Do you want to proceed?" can never be auto-approved — that is structure, not luck. Layer 3 (any persisting ❯-menu for 4 ticks) is documented to raise `perm-prompt:<session>|<hash>` and did not: zero attention items were created on this machine today, and `logs/permission-prompt-resolver.jsonl` has never existed here, so a Layer-3 abstention leaves no audit row at all. Ranked with the unbounded gates: a wedged session stays wedged with nothing saying so. Cause under measurement by the coordinator with a live canary session; not fixed here.
- **G7 — held ordinary replies with other hold reasons** (the CMT-862 class): not durable, no item on expiry. Needs the origin service to report expiry through the runtime the way the lease path does.

## Convergence

Pass 1 swept the gates named in the dispatch and found G1-G7 (G8 added from the coordinator's evidence) plus the subject-scoped-id defect. Pass 2, prompted by the coordinator's write-route evidence, swept every PATCH/PUT route (28) and found the silent-partial-write class (fixed in #2208, pinned by a ratchet test). Pass 3 re-swept the full table above after both fixes and found no new gates. That is one clean pass, not a machine-earned convergence stamp; the open gaps are recorded, not fixed.
