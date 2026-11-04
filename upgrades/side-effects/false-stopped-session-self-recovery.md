# Side-Effects Review — False stopped-session notices and self-recovery

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
- Triage Orchestrator and Stall Triage Nurse — modified: automatic restarts no longer announce death before recovery; suggestions to operate session controls stay internal. Nurse escalation failure uses one plain message without session commands.
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

## Second-pass review

**Reviewer:** `/root/second_pass`
**Independent read of the artifact:** Concur with the review. The reviewer first identified thread routing gaps in monitor and recovery history, context-exhaustion notices on live sessions, and an old notice ledger blocking self-recovery. A second pass found raw channel/thread mixing and missing cold thread replies; a third found that one cached reply could hide earlier thread history. Each concern was fixed with regression coverage. The reviewer re-read the final paths and found no remaining concrete blocker. A follow-up review identified the adapter and triage notice paths; those were fixed and the reviewer concurred with the extension.

## Evidence pointers

- Indra read-only log evidence: `/Users/justin/.instar/agents/echo/.instar/logs/indra-false-stopped-evidence-20261104.md` on Justin's laptop.
- Before/after regression: `tests/unit/spawn-resume-fallback.test.ts` (different fallback name before, same name after).
- Monitor and proxy regression tests: `tests/unit/SessionMonitor.test.ts`, `tests/unit/presence-proxy-replacement-session.test.ts`.

## Class-Closure Declaration (display-only mirror)

For the `unbounded-self-action` defect class, the self-triggered restart loop is bounded to one fresh attempt per unanswered user message in the process; the existing persisted notice ledger sends one failure notice per user message across restarts. `tests/unit/SessionMonitor.test.ts` proves a second death on the same turn does not respawn indefinitely. The ratchet is `tests/unit/self-action-convergence.test.ts`.
