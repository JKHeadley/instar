# Round 5 — Performance and Decision Completeness

Reviewed the entire current agent-home specification, its ELI16 overview, prior review findings and `conformance-round-5.json`. This is a design review, not implementation validation. No source edits or runtime actions.

## PERFORMANCE

**DESIGN: 0. PRECISION: 0.**

Both round-4 findings are resolved:

- The sole transactional outbox pre-claims the outage notice while storage is healthy and binds it to one named process/boot incarnation. Other processes use bounded authenticated IPC; timeout never transfers the claim or permits another sender. The permit is explicitly not an in-memory object shared between OS processes. Consumption precedes network await, ordinary retries/reclaim are excluded, and restart invalidates the prior permit.
- Ready notices have a separate ceiling of 1,000 conversations, 8 MiB aggregate and 8 KiB per request. They do not consume ordinary active-delivery slots. Capacity exhaustion exposes incomplete notification coverage rather than removing bounds or permitting unrecorded notices.

Rechecked the broader workload contract: preparation uses one bounded attempt per evidence sink and a two-second aggregate budget; execution remains in one credential-owner outbox; database work stays off the serving event loop; plans reserve bounded children/bytes before dispatch; attempt counters and original deadlines survive restart/transfer/variant changes; uncertain acceptance cannot become retryable work; a diagnostic consult is limited to one per originId and never delays sending; audit retention uses bounded indexed archives and explicit snapshot/per-shard coverage. No additional concrete workload or concurrency defect found.

The revised availability wording also correctly distinguishes evidence-store failure from execution-outbox unavailability. It no longer claims any healthy evidence mirror alone guarantees delivery.

## DECISION-COMPLETENESS

**DESIGN: 0. PRECISION: 0.**

The nine frontloaded decisions define the behavior to build, including broker-profile ownership, same-message operator-account authorship proof, supported captionless bot companions, retained searchable audit, display precedence and failure behavior. Justin's explicit HOLD-with-notification approval settles the availability policy. Notification remains an attempted delivery, with unreserved conversation, process restart, revoked permission and network failure limitations stated honestly. No extra policy question is needed.

The Web receipt feasibility spike and activation canary are concrete implementation verification obligations. The preferred TDLib/MTProto alternative requires explicit enrollment and is not represented as already authenticated by browser cookies. Neither route is silently advertised as complete. Technical feasibility and possible login enrollment are external implementation prerequisites, not hidden user preference decisions.

Decision-completeness accounting: **frontloaded decisions 9; cheap-to-change tags 0; contested cheap tags 0; unresolved operator policy decisions 0.**

## Conformance signal

Standards-Conformance Gate ran: 90 standards checked, zero flags, `degraded:false`; registry canary passed with 90 articles and no failures. This agrees with the independent review but does not substitute for it or prove runtime wiring.

## Disposition

Quiet round for both assigned perspectives: **zero DESIGN and zero PRECISION findings.** All prior findings in these perspectives are resolved. No optional scope expansion proposed.
