# Round 4 — Performance and Decision Completeness

Reviewed the current agent-home technical specification, ELI16 overview and `conformance-round-4.json`. No implementation edits. Findings are confined to the newly added outage-notification mechanism.

## PERFORMANCE

Previously reviewed boundaries remain satisfactory: inert evidence fallback, one credential-owner execution outbox, persistent per-child budgets, bounded off-event-loop persistence, capped plan admission, indexed archives and explicit federated coverage. Contract 19 now reserves derived child count/bytes before dispatch, resolving the round-3 capacity finding. Removing post-hoc operator-account security companions also removes that derived-work amplification case.

### P4-1 — DESIGN: name one OS process as the outage permit owner

The notification section says a process/boot-bound single-use permit is shared with the lifeline and consumed as an in-memory callable before awaiting. Main server and lifeline are separate OS processes. An in-memory consume operation cannot itself provide a cross-process atomic claim, and the ordinary durable claim store is precisely what may be unavailable. Without an explicit owner, implementing the text as two callable copies permits duplicate notice attempts; attempting a fresh durable claim during the outage defeats the fallback.

Recommended resolution: choose exactly one named process as permit owner while storage is healthy (prefer the independently running lifeline), and bind the prepared permit to its process incarnation. The other process can request an attempt through bounded local IPC, but receives no permit copy and never sends the notice itself. The owner synchronously consumes before network await. IPC timeout/death never transfers the permit; missing/restarted owner produces the already-documented unavailable-notification result. Reserve a fresh generation only after confirmed recovery. Add a two-process test issuing simultaneous main/lifeline signals, plus IPC lost-ack and owner-restart controls. This preserves the operator's approved HOLD behavior and requires no new operator choice.

### P4-2 — PRECISION: separate reserved-notice capacity from ordinary active work

Contract 11 caps active logical operations at 1,000. The outage contract adds a permanently prepared reservation for every active conversation but does not state whether these consume that same cap or define their own bound. Counting reservations as ordinary active work can leave no room for actual messages; exempting them without a separate cap makes the new reservation workload unbounded.

Recommended default: a distinct bounded reservation lane, excluded from the 1,000 ordinary active-operation limit, with at most 1,000 reserved conversation notices and a fixed bounded payload per reservation. Create/refresh lazily during healthy ordinary activity; do not sweep all historical conversations. Retire least-recently-active unused reservations as needed, making their lack of a notice explicit in existing coverage/health. Retained audit evidence is unaffected. A used permit is never recycled. Test filling the reservation lane while an ordinary message remains admissible, and the no-reservation path beyond the cap. The existing documented new/unreserved-conversation limitation makes this an engineering default, not a new user decision.

## DECISION-COMPLETENESS

Zero new DESIGN or PRECISION findings in this perspective. Justin explicitly approved HOLD with user notification; the conformance reachability flag is an advisory signal superseded by that concrete operator choice. Do not ask him to choose between mandatory recording and an unrecorded bypass again.

The overview accurately distinguishes safe evidence storage from execution-outbox admission, same-message operator-account ASP from bot companions, and implementation approval from deployment. Notification limitations are honestly stated for unreserved conversations, process restart, revoked permission and network/Telegram failure. The user has no unresolved design choice to answer. Runtime login availability remains an external enrollment prerequisite, not a missing policy choice. No cheap-to-change tags are asserted.

## Disposition

Performance: one DESIGN and one PRECISION, both on the new notification path. Decision completeness: zero findings. Prior material findings are resolved; fixes above should be mechanical declarations of ownership and capacity, not broader redesign.
