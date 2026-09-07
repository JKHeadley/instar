# Round 3 — Performance and Decision Completeness

Reviewed the revised technical specification and ELI16 companion. No runtime/source edits. **Zero DESIGN findings; two PRECISION findings.**

## PERFORMANCE

The round-2 authority finding is resolved: evidence sinks are expressly inert, one credential-owner outbox admits executable work, server/lifeline share it, and lost admission acknowledgements reconcile against that same authority. This removes the cross-store claim race without requiring distributed commit. Persistent per-child attempt counters, the original six-hour deadline and one consult per originId resolve the recovery-budget reset and multi-child accounting concerns. Indexed archival and snapshot/per-shard pagination remain adequately specified. No new performance architecture defect found.

### P3-1 — PRECISION: reserve derived security companions inside admission limits

Contract 16 now permits per-member security companions for large groups, constructed after concrete content receipts exist. Contract 11 caps a plan at 100 children and 256 MiB active payloads. Clarify that these limits and the complete pre-dispatch plan count **all** content, cosmetic and security children, including the worst-case bounded receipt-carrier size, before any content dispatch. Otherwise an implementation can admit 60 content members and discover after delivery that 60 required companions exceed the admitted plan limit.

Recommended wording: reserve every security child and bounded carrier bytes at initial admission; receipt-dependent fields are explicitly typed placeholders, filled only from validated parent receipts, then the concrete child bytes are durably finalized/signed before that child's claim. Filling receipts cannot add children or expand beyond reserved limits. Oversize plans fail before the first content send. Test a group whose derived children cross the configured ceiling and the exact-limit positive case. This makes the existing complete-plan/capacity intent explicit for the newly added carrier path; it does not require another user decision.

## DECISION-COMPLETENESS

Broker ownership of agent Telegram profiles and mandatory authorship carriers despite hidden cosmetic fields are now frontloaded and explained in the overview. The original fallback, retention, companion and ASP-scope decisions remain concrete proposed defaults. There are no new operator preference questions and no cheap-to-change claims to contest. Existing authentication, if required for enrollment, remains a deployment prerequisite rather than an unrecorded design choice.

### D3-1 — PRECISION: correct the public availability promise after outbox simplification

The technical fallback paragraph correctly says unavailable durable execution admission/claim also holds a send. The next paragraph nevertheless says **"Only when no durable sink can acknowledge preparation is a new send held"**, and the ELI16 says **"Hold a new send only if none can record it."** Those statements now overpromise: a healthy peer can record origin while the sole credential-owner outbox is unavailable, and the design intentionally holds that send.

Recommended correction in both documents: origin-store failure alone does not stop delivery when a fallback evidence sink and the credential-owner outbox are healthy. Sending requires durable origin evidence **and** durable exclusive execution admission; if either is unavailable, the operation remains held. No evidence mirror independently sends. Keep this explicit limitation in the approval overview so the operator is approving the actual availability tradeoff.

## Disposition

Performance: zero DESIGN, one PRECISION. Decision completeness: zero DESIGN, one PRECISION. Round-2 material findings are resolved. The two wording/contract clarifications above do not introduce a new architectural choice or require a fresh operator decision.
