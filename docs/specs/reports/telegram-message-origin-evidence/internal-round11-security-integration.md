# Round 11 — Security and Integration/Deployment

Reviewed the latest `docs/specs/telegram-message-origin.md` and conformance report. Canonical helper hash: `056d5361eae344c45ba1e602e8b1a0a0b90043e12e600d741bcfdee8bc1feeed`.

## SECURITY perspective

**0 DESIGN findings. 0 PRECISION findings.**

The notifier is now expressly the only permitted consumer of preclaimed outage permits. A source boundary lint and independent behavioral counterfeit-reference tests cover different enforcement layers; sabotaging lint does not make ordinary references valid outage capabilities. Existing narrow IPC, no-arbitrary-payload, one-use process binding and sealed variants remain intact.

Fire-time permission does not come from the failed origin store or the old notice reservation. It comes from separately maintained authority projections with a maximum age of 30 seconds, bounded further by the authority's own expiry. Revocation, version invalidation and observer loss invalidate the projection; reading a cached value cannot refresh its evidence age. Unknown/expired policy suppresses. These explicit bounds resolve the earlier dependency ambiguity without inventing permission during a storage outage.

The browser canary recovery step is read-only, performs no message replay, and leaves write capability held until verification succeeds. Its restart cannot be interpreted as proof that an earlier uncertain send failed. No newly introduced authorization or authorship flaw was identified.

## INTEGRATION/DEPLOYMENT perspective

**0 DESIGN findings. 0 PRECISION findings.**

The required paired fault controls now demonstrate both sides of the notification boundary: failing the origin/outbox worker while policy remains available must reach mocked network; failing or expiring the policy authority must suppress. Independently refreshed projections allow a paced queue longer than 30 seconds to retain current policy when that separate authority remains alive; otherwise later entries correctly become unavailable rather than relying on the original snapshot.

Canary failure updates health immediately, then permits one fresh-process/read-only recheck before a deduplicated attention item. The existing durable self-action latch and 15-minute brake prevent repeated failed writes from creating a restart loop. The transport remains held during the probe, and the diagnostic action does not grant retry permission for an uncertain operation. The already defined MTProto fallback and enrollment requirements remain unchanged.

Prior contracts for sole-outbox execution, immutable materialization, receipt evidence, deadlines, bounded notice capacity/pacing, rolling activation and retained audit remain coherent. No additional contract-level defect was found. These statements assess the design, not code that has yet to be written or initialized.

## Review status

Conformance round 11 reports 90 standards checked, zero findings, non-degraded, and a successful 90-article registry canary. Justin's explicit hold-with-notification decision remains authoritative. Structural policy validity and capability checks remain within the hard-invariant exception in the signal-versus-authority principle.

**Total: 0 DESIGN, 0 PRECISION.** This is a quiet review for these two perspectives on the recorded hash. Prior external findings remain in their original rounds; no aggregate convergence or implementation completion is claimed. No feature source or managed runtime/profile state was changed.
