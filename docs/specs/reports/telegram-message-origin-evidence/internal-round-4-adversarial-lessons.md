# Round 4 — Adversarial and lessons-aware review

Inputs: revised agent-home `docs/specs/telegram-message-origin.md`; `.instar/telegram-origin-review/conformance-round-4.json`; prior adversarial/lessons reports; prior full lessons-catalog and relevant-memory reading; read-only fresh-main browser/profile/gate inspection at `77df8be42a24a09d991b044027161c95eb9322a5`. No runtime or source edits.

## ADVERSARIAL perspective

No DESIGN or PRECISION findings in this perspective.

The prior late-bound-plan defect is resolved by contract 19: only enumerated derivations are permitted, materializations are separately sealed and persisted before claiming, their provenance links remain inspectable, and identity/budgets do not reset. Arbitrary body/destination/display substitutions remain forbidden. The post-hoc operator-account security carrier has been removed; unsupported forms now fail before sending any unsigned content. Thus the draft no longer has the transient human-attribution interval or an unbounded multipart security protocol to implement.

The browser implementation is still real work, but the draft does not represent it as shipped or guarantee hostile-same-UID containment. Fresh-source evidence confirms that current profile metadata, activation rewrites, leases and MCP hooks are insufficient on their own. The specified new broker requires ownership of writable connections, migration away from generic writable profiles, and concrete server receipt correlation before activation. Missing current code for an expressly new component is not itself a design defect. Its claim must be earned with the specified bypass and receipt tests; current registry/profile tools cannot substitute for that boundary.

The recording-outage notice is prepared while persistence works, is exact/sealed, bound to a single process/boot permit, consumed before asynchronous work, and uses a one-attempt egress rather than a retrying send path. It explicitly does not replay after restart or recursively prepare another notice. Current ownership/permission checks still apply. The limitations on notifying a new conversation, after process loss, or through a failed network are stated rather than hidden. I found no new contradiction requiring different architecture. During implementation, the shared-server/lifeline permit must be exercised as one actual authority, not duplicated per-process JavaScript booleans; that is a direct test of the existing contract, not an additional design proposal.

## LESSONS-AWARE perspective

### R4-AL1 — PRECISION — Carry forward the uncorrected availability-summary wording

The durability summary still says that only failure of all durable evidence sinks holds a new send as `audit-unavailable`. The surrounding execution-outbox contract and the new notification section correctly say admission/claim failure of the sole execution outbox also holds work. This is the same document-only finding as R3-AL2, not a new design defect.

Fix: summarize the two distinct refusal states explicitly: evidence-unavailable versus execution-outbox-unavailable. Origin-store failure alone is survivable only while another evidence sink and the execution outbox remain healthy. The implementation behavior is already specified; no new mechanism is requested.

No lessons-aware DESIGN findings. Conformance's reachability warning is retained as an audit result but is resolved by Justin's explicit choice of hold with notification; a generic preference for fail-open reachability must not override the operator's actual decision. The reserve-notice path addresses that decision without an unrecorded exception, while honestly disclosing when notification itself cannot be delivered.

Prior P4/P20/B22/B24 issues remain addressed: positive model observations make an always-unknown resolver fail wiring checks; queue cleanup preserves retained provenance; receipt evidence differs from HTTP success or suppression; post-dispatch timeouts cannot become generic retryable failures; ASP renewal preserves freshness/replay rules; one outbox owns execution; bounded Tier 1 diagnostics cannot fabricate receipt or retry authority.

## Counts and verdict

DESIGN: 0. PRECISION: 1 (carried-forward wording only).

This is an honest design-quiet round for these two perspectives. It is not, by itself, a convergence declaration or deployment claim.
