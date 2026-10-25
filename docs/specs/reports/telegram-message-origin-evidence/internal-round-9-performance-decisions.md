# Round 9 — Performance and Decision Completeness

Reviewed the current complete agent-home specification, both round-8 external outputs and conformance-round-9.json. No implementation or source edits.

## PERFORMANCE

**DESIGN: 0. PRECISION: 0.**

The changed notification destination reduces work: held conversations coalesce by the existing authorized operator alert hub, so a single operator's 1,000 affected conversations produce one reserved notice. Browser-only conversations do not require adding the bot to external chats. Across distinct operators, at most 1,000 permits enter the bounded owner queue; the rate is at most 10 attempts/second or the stricter existing outbound limit. The spec honestly gives the minimum 100-second full-fan-out dispatch duration at that cap and allows slower/failing network delivery rather than promising a hard maximum. The queue drains once, consumes each permit once and cannot manufacture new notices without confirmed recovery.

Both reservation ceilings remain independently enforced: 1,000 destinations and 8 MiB aggregate, with 8 KiB covering all eight variants of each reservation. This is separate from ordinary delivery capacity. Dequeue-time policy/variant checks prevent a long paced queue from using stale admission-time permissions; unknown current state suppresses explicitly. No recursive preparation, generic retry path, cross-process permit copy or timeout takeover is introduced.

Browser maintenance now has a named integration maintainer, activation canary, per-operation loaded-build comparison, a one-item-per-failed-build attention path, and a two-consecutive-unsupported-build migration trigger. This is a build check before each operation, not a new full authenticated send canary on every message. No repair-time SLA or automatically available alternate login is invented. Existing worker deadlines and immutable IDs continue to bound uncertain work.

Single-outbox execution authority, persistent child attempt/deadline budgets, asynchronous store work, bounded canonical materializations, indexed archives and explicit federated coverage remain unchanged. No concrete new scalability/concurrency defect found.

## DECISION-COMPLETENESS

**DESIGN: 0. PRECISION: 0.**

Justin's HOLD-with-notification decision remains explicit. Using the existing operator alert hub implements the standing one-hub notification policy and avoids sending operational notices to third-party recipients. Missing bot-reachable hubs and unavailable current destination policy are explicitly unavailable/suppressed outcomes; the contract does not require the operator to decide routing anew for each conversation.

No unresolved choice is introduced by the maintenance contract: the maintainer role is named, unsupported writes are held, the alternate transport requires actual enrollment, and personal browser access stays read-only/preserved while that prerequisite is resolved. Same-message ASP and cosmetic visibility remain separate. No additional user question or cheap-to-change claim is needed.

Decision accounting: **9 frontloaded decisions; 0 cheap-to-change tags; 0 contested cheap tags; 0 unresolved operator policy decisions.**

## Conformance and external-count integrity

Round-9 Standards-Conformance Gate ran: 90 standards, one advisory reachability flag, `degraded:false`; registry canary passed all 90 articles. The flag questions holding sends when recording fails. That is the exact policy Justin explicitly selected, with bounded notice mitigation and honest limits, so it is not an unresolved operator decision or a reason to introduce an unrecorded bypass.

Round-8 external declarations remain **4 DESIGN / 3 PRECISION**; this report does not relabel them or retroactively make that round quiet. Relevant behavior changes are now reviewed in round 9. External round-9 results must retain their own declared counts.

## Disposition

Quiet internal round for both assigned perspectives: **zero DESIGN / zero PRECISION**. Runtime verification remains required. No optional expansion proposed.
