# Side-Effects Review — False stopped-session notices and self-recovery

## Current-main refresh — 2026-11-07

Rebased onto main at bfe143d6d (195 commits later; seven files conflicted). The merge keeps main's notification envelopes, quiet receipts, conversation lock and usage-limit wiring alongside this fix.

An independent second pass of the rebase raised points that were fixed here:

- SessionMonitor counted standby, spawn acknowledgement and stall alert rows as answers, so a Telegram turn that died after one got no recovery and no notice. It now reads recorded provenance, then falls back to the shared text classifier. Slack rows carry no provenance and use the classifier; a Slack alert that matches neither path remains an under-block.
- A live session the model called dead rescheduled tier 3 without counting a recheck. It now counts.
- A heuristic `suggest_*` result reported resolved while doing nothing, which cleared the stall. It now reports unresolved, so the plain live-stall check-in still goes out.

The real-Telegram run then found main's `SESSION_RESTARTING_NOTICE` saying the session "had stopped" during a working replacement. The wording now says a new session is starting. It stays as the delay explanation and asks for nothing.

Reviewed and kept: the wider foreign-owner gate, which is earned by the 11-04 incident in closed PR #2743; server.ts now states that rule. Known limits: `deadRecoveryAttempts` is in memory, so a server restart allows one more attempt for the same message, only within 24 hours of it (`deadRecoveryDue`, registered as `session-monitor-dead-recovery` in the self-action ratchet). The failure notice stays deduplicated by the persisted ledger. WhatsApp keeps its `/new` wording and goes to the feedback queue; the fallback-name fix removes its false claim's root cause.

Live Telegram proof on a throwaway agent and bot: a real message, a forced resume death, one "Starting a new session" notice, a normal answer 18 seconds later, and no stopped notice.

Independent second pass of this refresh: **Concur with the review.** It confirmed the failure notice cannot repeat and noted one bounded extra restart per boot. Non-blocking note: the context-limit notice rarely sends, because PresenceProxy's stuck message covers that case.

## Current-main refresh — 2026-11-05

The main merge includes PR #2798's real Codex 0.166 native canary compatibility fix. Review of the resulting PR diff also found an older account-rescue regression: this branch installed a spawn-account resolver only when explicit pinning was enabled. Restore main's exact resolver block, including `wallRescue.spawnAccount()` when pinning is not explicitly true, and main's plain no-alternate-account notice. This is a narrow restoration of already-shipped behavior, not a new feature or migration. The only source file in the correction is `src/commands/server.ts`; existing account-rescue unit, integration spawn/route, and lifecycle tests plus full verification cover it.

The restored decision is the existing account-rescue authority; no parallel detector or new authority is added (see `docs/signal-vs-authority.md`). Over-block and under-block match main: a known walled default is refused, one usable account preserves the default, and explicit pinning still selects a pool account. The main implementation owns quota checks, identity checks, and brakes. This restoration does not change Slack/Telegram recovery ownership or its single failure notice. No new operator action, URL, or credential is introduced. Account selection is machine-local with the existing pool ownership rules. No schema, installed file, template or config default changes, so no migration or agent-awareness update is needed. Reverting the small correction restores the branch's prior behavior; it changes no data. A dedicated independent reviewer must concur before this correction is committed. Full final-head verification and isolated Telegram parity proof remain required before merge; the latest user instruction authorizes merge only after both pass.

Independent second pass, `/root/review_main_rescue_restore`: **Concur with the review.** The restored resolver and notice exactly match `origin/main`; the false-stopped recovery changes remain untouched. This concurrence is code review only, not final-head verification or channel proof.

**Version / slug:** `false-stopped-session-self-recovery`
**Date:** 2026-11-04
**Author:** Echo
**Second-pass reviewer:** `/root/second_pass` — concurred after follow-up review of adapter stall routes

## Summary of the change

An automatic fresh spawn after a failed resume now keeps the original registered session name. SessionMonitor and PresenceProxy use current session, spawn, and reply evidence before claiming a conversation has stopped. SessionMonitor attempts a fresh restart for a genuinely dead, unanswered conversation; only a failed recovery produces one plain notice. Foreign topic ownership follows the ownership record rather than peer reachability. Slack thread routing keys are resolved consistently for watcher reads and sends. The changed decisions are in SessionManager, SessionMonitor, SessionRecovery, PresenceProxy, and server wiring.

## Decision-point inventory

- Resume fallback session naming — modified: retains the bridge's registered name.
- Monitor dead-session recovery and notice — modified: checks live/starting/replied/ownership state, bypasses user-facing triage for a dead process, retries a fresh restart once per unanswered turn, then sends one failure notice.
- Proxy Tier 3 death claim — modified: suppresses it and leaves recovery to SessionMonitor.
- Telegram adapter stall and promise alerts — modified: dead sessions bypass triage and user notices; a second liveness check guards live-stall notices after asynchronous triage. Live-stall text no longer asks people to interrupt or restart.
- Slack adapter stall and promise alerts — modified: dead sessions bypass triage and user notices; live notices have no manual session commands. Server stall callback logs evidence without publishing another notice.
- Triage Orchestrator and Stall Triage Nurse — modified: automatic restarts no longer announce death before recovery; suggestions to operate session controls stay internal. Nurse escalation failure stays silent so a later monitor failure cannot double-notify.
- System Reviewer session-health wording — modified: the operator attention alert records the check without asking someone to restart sessions.
- Foreign owner gate — modified: non-owner machines do not announce a local session death.
- Slack routing-key resolution — modified: watcher evidence and thread replies use the conversation's routing key.

## 1. Over-block

An agent's short acknowledgement now suppresses a death claim for that user turn. If the agent then exits without completing the task, the reply evidence may hide a true later failure until a new message. This is consistent with the explicit conversation rule, but the uncompleted task remains a separate stall/reliability concern. A live but wedged session is not classified as dead; stall and context detectors remain active.

## 2. Under-block

The bounded outbound-log tail can miss a reply if more than 100 later rows land before a monitor check. The event and current-session checks cover common cases; the fallback is to monitor recovery, with the persisted once-per-message notice ledger limiting repetition. A reply that bypasses the normal message log cannot be observed by this guard. Live proof is recorded separately; Indra remains unproven until its installed update is observed.

## 3. Level-of-abstraction fit

SessionManager owns the exact name returned to the bridge, so it owns the fallback naming invariant. SessionMonitor already owns dead-session recovery and notification; PresenceProxy supplies progress signals but no longer asserts death. Ownership is read at the session-pool authority, not inferred from peer reachability. The log reader is evidence, not an independent delivery gate.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).

- [x] No — this change has no block/allow surface for user messages. It governs automated health claims and recovery.

The suppression is a deterministic contradiction check: a live session, a start in progress, a later reply, or a different recorded owner makes the specific statement “stopped” false. It does not interpret the person's request or block delivery.

## 4b. Judgment-point check

No new text heuristic is added at a competing-signals decision point. The stop rule relies on structural session liveness, spawn state, ownership, and temporal reply evidence. Existing brief-ack classification continues to control progress timers, but a brief reply cannot authorize a death claim.

## 5. Interactions

- **Shadowing:** SessionMonitor remains the sole dead-session recovery and failure-notice voice; PresenceProxy, adapters, and triage no longer shadow it with competing notices.
- **Double-fire:** The monitor rechecks ownership and current session after asynchronous mechanical recovery. A per-user-message attempt record bounds fresh restarts within one process; the persisted notice ledger bounds messages across restarts.
- **Races:** A replacement can register during recovery. The monitor rechecks starting, current live session, and logged reply before restart and before notice.
- **Feedback loops:** The fresh restart reads conversation history and may produce a reply. That reply suppresses later death notices. A failed fresh restart produces one notice, not repeated restarts each poll.

## 6. External surfaces

Slack and Telegram users no longer receive “unstick”, “restart”, or “send a new message” instructions from these automated death paths. They receive one plain failure message only if self-recovery fails. The System Reviewer no longer asks the operator to restart sessions from a health-check alert. Slack thread messages remain scoped to their thread. No new operator action or URL is introduced. Existing dead-notice and context-notice ledgers retain their formats; the new attempt record is process-local.

## 6b. Operator-surface quality

No dashboard or form surface is changed — not applicable. The single failure sentence is plain language and requires no action.

## 7. Multi-machine posture

**Machine-local by design:** liveness and in-progress spawn evidence describe processes on the current machine. Topic ownership is read from the shared session-ownership registry; a foreign owner suppresses local recovery and notices even if that peer is offline. The persisted notice ledger is local, but the ownership gate provides one voice and transfer changes which machine may act. No generated URL is involved. A topic transfer must establish local ownership before the new machine can restart or notify.

## 8. Rollback cost

Revert the code and ship a patch. No data migration is needed; existing ledgers remain readable. A rollback restores the earlier duplicate-notice and fallback-name behavior until the reverted release reaches agents. A living old session needs no state repair; stale channel registrations created before the fix heal on the next inbound spawn.

## Conclusion

The source fix addresses the recorded Indra split between a failed registered resume and a separately named successful fallback. Watcher guards cover both ordering windows, short replies, thread keys, and foreign ownership. The independent review concurs. Live canary verification and post-update Indra observation remain required before claiming the production outcome.

**Node 26 Slack transport coexistence (PR #2760 canary):** The disposable canary exposed a pre-existing package/runtime mismatch: Node 26 global `fetch` rejected the `undici` package Agent with `UND_ERR_INVALID_ARG invalid onError method`, so Socket Mode could not initialize. The Slack client now pairs the package `undici.fetch` with that package Agent, keeping its per-client pool, rate-limit retry, and transport reset behavior. Direct Slack demo `auth.test` and `apps.connections.open` succeeded with the same pairing. This affects the Slack HTTP transport, not the stopped-session decision logic. Rollback is a source revert; no state migration is involved.

## Second-pass review

**Reviewer:** `/root/second_pass`
**Independent read of the artifact:** Concur with the review. The reviewer first identified thread routing gaps in monitor and recovery history, context-exhaustion notices on live sessions, and an old notice ledger blocking self-recovery. A second pass found raw channel/thread mixing and missing cold thread replies; a third found that one cached reply could hide earlier thread history. Each concern was fixed with regression coverage. The reviewer re-read the final paths and found no remaining concrete blocker. A follow-up review identified the adapter and triage notice paths; those were fixed and the reviewer concurred with the extension. A final one-voice review concurred with keeping nurse escalation failures silent for the monitor to handle.

**Main-branch coexistence second pass (PR #2760 local verify repair):** Concur with the review. Independent reviewer checked the restored UsageWallRescue wiring and quota detection alongside the stopped-session paths, thread history helper, and this artifact.

**Node 26 Slack transport second pass:** Concur with the review. Independent reviewer confirmed that package `fetch` and `Agent` share one undici version and that the JSON, Retry-After, failure counter, and scoped pool reset paths remain intact.

## Evidence pointers

- Indra read-only log evidence: `/Users/justin/.instar/agents/echo/.instar/logs/indra-false-stopped-evidence-20261104.md` on Justin's laptop.
- Before/after regression: `tests/unit/spawn-resume-fallback.test.ts` (different fallback name before, same name after).
- Monitor and proxy regression tests: `tests/unit/SessionMonitor.test.ts`, `tests/unit/presence-proxy-replacement-session.test.ts`.

## Class-Closure Declaration (display-only mirror)

For the `unbounded-self-action` defect class, the self-triggered restart loop is bounded to one fresh attempt per unanswered user message in the process; the existing persisted notice ledger sends one failure notice per user message across restarts. `tests/unit/SessionMonitor.test.ts` proves a second death on the same turn does not respawn indefinitely. The ratchet is `tests/unit/self-action-convergence.test.ts`.
