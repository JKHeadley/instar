# Round 8 — Performance and Decision Completeness

Reviewed the complete latest agent-home specification and conformance-round-8.json, including the changed notice variants, promise wording, canonical serialization and alternate-transport activation. No implementation/source edits.

## PERFORMANCE

**DESIGN: 0. PRECISION: 0.**

The finite outage-display variant set is bounded correctly: three field switches produce at most eight variants, with disabled/all-hidden sharing the no-footer case. All variants share **one** preclaimed child and process-bound single-use permit. Selecting an existing sealed request does not multiply claims or permit retries. The reservation cap remains 8 KiB for the combined variants and 8 MiB overall, not eight times the earlier budget; reservations remain separate from ordinary delivery slots.

The fire-time path only selects stored bytes after reading current effective display bits and existing destination policies. It does not recanonicalize/resign an arbitrary body during the storage outage. Cosmetic preference changes therefore preserve notification coverage without weakening the preserved snapshot for ordinary operations. Named owner, bounded authenticated IPC, no takeover on timeout, no reclaim, one network attempt and non-reuse across process restart remain intact.

Rechecked JCS-based canonical bytes and the distinct Web RPC/HTTP boundaries. Provider-required TL serialization/encryption is no longer incorrectly treated as byte-for-byte HTTP payload reuse. Sealed RPC arguments/random ID remain immutable; worker lifetime is still explicitly bounded, and uncertain operations cannot be replaced by new IDs. No new processing loop or unbounded object expansion is required by these changes.

Existing bounded preparation, persistent child attempt ceilings/deadlines, indexed archives, per-shard snapshots and separate audit/execution authority continue to hold. No additional concrete workload or concurrency defect found.

## DECISION-COMPLETENESS

**DESIGN: 0. PRECISION: 0.**

The revised fixed notice says delivery is paused while recording is unavailable. It no longer promises eventual delivery after recovery, so the notice agrees with the original six-hour recovery deadline and expired-unresolved state. Justin's HOLD-with-notification policy is preserved without a new completion guarantee.

Same-message operator-account ASP remains distinct from cosmetic display. The Web activation requirements and explicitly enrolled TDLib/MTProto alternate are now present in rollout as well as the alternatives discussion. This supplies the alternate implementation contract without pretending the required user-account login already exists. Technical validation/enrollment may still be necessary, but no new policy choice is parked on the operator.

Decision accounting remains **9 frontloaded decisions; 0 cheap-to-change tags; 0 contested cheap tags; 0 unresolved operator policy decisions**.

## Conformance and disposition

Round-8 Standards-Conformance Gate ran: 90 standards, zero flags, `degraded:false`; registry canary passed with 90 articles.

Quiet internal round for both assigned perspectives: **zero DESIGN / zero PRECISION**. This records only this review's classes; external round-8 findings must be counted as their reviewers declare them. No optional expansion proposed and no runtime-completion claim made.
