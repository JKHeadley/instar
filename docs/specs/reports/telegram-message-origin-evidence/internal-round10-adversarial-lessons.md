# Round 10 — adversarial and lessons-aware review

Reviewed the complete current spec body, SHA-256 `4a40e9e8971b8b6025f207e8c6e724fea322ac31e52a0dd4bb323637e06c7552`. This supersedes my unfinished round-9 review; it is not evidence of two independent quiet rounds. The two perspectives below are from the same reviewer.

## ADVERSARIAL

DESIGN: 0. PRECISION: 0.

Rechecked the named notifier API and counterfeit-permit/ordinary-HTTP/direct-egress/IPC controls. Callers cannot supply request bytes or choose arbitrary destinations; one immutable preclaimed child owns the finite variants and one named process incarnation consumes it. Policy checks at dequeue prevent a queued notice retaining stale permission, and unresolved current authority suppresses explicitly. Operator hub coalescing covers user-account conversations without sending to their third-party recipients; 10/second pacing and the 1,000-permit ceiling bound fan-out. Existing wire sealing, receipt uncertainty, ASP freshness, same-message authorship, inert evidence fallbacks and fenced outbox claims remain intact.

The unsupported-build prewrite check and broker termination deadline address observed Web worker behavior without pretending a private upstream interface is stable or browser cookies enroll MTProto. No additional design defect found in those changes.

## LESSONS-AWARE

DESIGN: 1. PRECISION: 0.

**D1 — The newly specified browser-canary escalation notifies on detection, before bounded self-heal.** In Migration, rollout and rollback, a failed broker canary immediately emits one attention item per failed build. P22 in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md:965` requires escalation only after bounded self-heal has failed. A canary identifies failure; it is not itself an attempted repair. The explicit fallback exhaustion for the recording-outage notice does not cover this separate browser-drift attention path. The two-consecutive-build migration trigger also happens later than the first user escalation.

Minimal resolution: keep the transport held and health immediately visible; attempt one bounded safe broker refresh/restart and canary recheck before user-facing escalation, with no send, replay or new random ID and no reclassification of already uncertain work. If refresh cannot safely run, record that failure/unavailability rather than silently skipping it. Escalate the existing deduped attention item only when that recovery is exhausted. Keep the existing public-MTProto migration trigger; do not introduce an autonomous source-patching loop or ask the operator for another policy choice. This changes the escalation trigger and recovery behavior, so it is DESIGN rather than wording precision.

Re-grounding included P22/P23/P24, L5's canary requirement, relevant memory and the fresh worktree's actual `AttentionTopicGuard.ts`; its topic coalescing is not a self-heal mechanism. Other reviewed lessons remain satisfied at the design level: operator-hub routing, explicit notification coverage limits, finite pacing/queues, honest uncertain receipts and Tier 1 diagnosis without execution authority.

Conformance round 10 checked 90 standards without degradation; its sole reachability flag remains an explicitly user-approved hold policy, not a new defect or a reason to bypass durable origin recording. No runtime/source edits or external sends were performed. Authenticated browser activation and implementation tests remain outstanding.

## Counts

Aggregate of these perspectives: **1 DESIGN, 0 PRECISION**. This is not a design-quiet round for this reviewer.
