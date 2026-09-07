# Round 8 — Security and Integration/Deployment

Reviewed `docs/specs/telegram-message-origin.md` and `conformance-round-8.json`, emphasizing the changes since the prior review. Canonical reviewable hash from the project's `cross-model-review.mjs --hash-only` helper: `c56608dbb5d510c46283856de1b59624e13bb0f06691cb8b9af4a17903d836ec`.

## SECURITY perspective

**0 DESIGN findings. 0 PRECISION findings.**

The JCS profile now specifies primitive spelling, escaping, duplicate-key and lone-surrogate rejection, in addition to exact ordering, safe numeric restrictions and immutable authored content. The distinct Web RPC argument boundary avoids claiming that nondeterministic encrypted MTProto frames are canonical message bodies. Worker serialization is allowed; changing sealed arguments, entities, random ID or text is not.

The outage notice's finite variants remain one previously recorded operation and one process-bound claim. At fire time, current visibility selects existing sealed bytes; no caller-controlled body or new materialization can be introduced. Disabled/all-hidden share the same no-footer variant. Current permission, ownership, mute/archive/deletion and opt-out checks remain in force. This limited exception therefore preserves both optional display and the mandatory recorded-origin boundary.

Session credentials, agent-versus-operator ASP classification, protected browser ownership, origin attestation, key lifecycle and operator-only audit access remain consistent. No new security flaw was found in the updated contract.

## INTEGRATION/DEPLOYMENT perspective

**0 DESIGN findings. 0 PRECISION findings.**

The notice now states that delivery is paused instead of promising automatic resumption, which is consistent with original deadlines, possible payload expiry and outcome-unknown holds. Its eight possible visibility variants remain under one preclaim, and the 8 KiB per-reservation limit covers all variants combined; the unchanged 8 MiB global reservation budget is therefore meaningful. Cosmetic preference changes do not suppress an otherwise authorized notification.

Bot API sealed bytes and Web RPC sealed arguments have explicitly different serialization boundaries. This matches the evidenced Web K manager seam and its necessary downstream provider serialization. The browser activation contract requires build canary, authenticated principal/destination verification and an actual permitted send-to-server-receipt join; the anonymous feasibility spike is not represented as that proof.

The explicit MTProto/TDLib alternative preserves the origin service and uncertainty state while requiring genuine account enrollment. The spec does not infer an enrolled alternate transport from browser cookies, silently migrate an uncertain send, or claim public stability for Web K's incidental managers. Worker deadline closure and same-random-ID discipline remain required.

Previously checked sole-outbox execution, inert evidence fallbacks, immutable redrive, queue dedup/retention and rolling activation contracts remain intact. No new implementation requirement beyond the approved scope is proposed by this review.

## Authority and result

Justin's explicit hold-and-notify decision remains the governing failure policy. The deterministic structural validators fit the hard-invariant exception in `docs/signal-vs-authority.md`; the diagnostic LLM does not gain retry or receipt authority.

Conformance round 8 reports 90 checked standards, zero findings, non-degraded, and a successful 90-article registry canary. This result is recorded independently of the review above. Earlier nonquiet rounds are not retroactively relabeled.

**Total: 0 DESIGN, 0 PRECISION.** Quiet for these perspectives on this specific hash. Overall convergence and the required subsequent quiet review remain the parent workflow's responsibility. No feature code or managed runtime/profile state was modified.
