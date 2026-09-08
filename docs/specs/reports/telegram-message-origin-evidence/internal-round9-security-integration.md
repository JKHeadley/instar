# Round 9 — Security and Integration/Deployment

Reviewed the latest `docs/specs/telegram-message-origin.md`, including operator-hub notification routing, coalescing/pacing, unknown live policy, and browser maintenance/activation changes. Canonical reviewable hash verified with the project helper: `1312d97208fe46cf26f5fd854ca21f16b2741c15ddef44b324a83dcc137f0814`.

## SECURITY perspective

**0 DESIGN findings. 0 PRECISION findings.**

The fixed outage notice now targets an existing authorized operator alert destination. It neither discloses operational status to third-party conversation recipients nor assumes a bot can post in every operator-account chat. Missing configuration yields notification-unavailable; it does not cause recipient invention or an emergency human-account send.

The reservation remains one immutable recorded operation with finite sealed display variants and one process-bound, nonreclaimable claim. Current authorization/ownership/destination policy must resolve before consumption; unknown policy suppresses instead of treating the historical reservation as live permission. Cosmetic visibility selects already-recorded bytes and cannot introduce arbitrary content. Hub coalescing and the existing notification authority preserve the standing one-hub constraint.

Browser write access remains broker-exclusive. The loaded build is rechecked immediately before each prepared operation, so successful startup verification does not grant indefinite permission to write through an unsupported changed client. The read-only alternative while account enrollment is unresolved does not reopen generic writable profile access. Prior credential, ASP, attestation, key lifecycle and audit-access contracts remain intact.

## INTEGRATION/DEPLOYMENT perspective

**0 DESIGN findings. 0 PRECISION findings.**

Hub-based coalescing covers held external/browser conversations without requiring the bot at their destination. One operator with 1,000 held conversations generates one notice per outage generation. Multiple operator destinations share the existing outbound pacing authority, capped at ten attempts per second or a stricter existing limit, with a bounded one-pass queue. The draft reports the resulting fan-out latency honestly and rechecks policy/visibility at dequeue rather than reservation time.

Count and byte limits are separately enforced, and the per-reservation budget includes every sealed variant. The single-use claim, no automatic retry after uncertain acceptance, no restart reuse and no replenishment before recovery remain specified. NotificationAttempted is still distinct from delivered, suppressed and unavailable outcomes.

The Web adapter now has a named maintenance owner, activation and pre-write canaries, one attention item per failed build, explicit absence of a repair-time SLA, and a defined MTProto migration trigger. A migration requires actual account enrollment and preserves operation identity and uncertainty rather than reinterpreting an old unknown result. The primary-source feasibility artifact supports the concrete Web K path; authenticated send/receipt validation is still required before activation.

No additional contract-level defect was found in these perspectives. Implementation must still prove the described behavior; no code or runtime wiring is asserted here.

## Conformance and authority

`conformance-round-9.json` reports 90 standards checked and one possible reachability violation concerning hold on recording failure, with a successful registry canary and no degraded review. Justin explicitly chose hold with user notification and approved the build. That instruction governs this failure policy; the general reachability finding does not authorize an unrecorded-send bypass. The automated report is retained with its actual finding, not represented as zero-findings.

The notification is already recorded, and live-policy suppression addresses authorization uncertainty rather than message meaning. Existing semantic notification/content authorities remain responsible for their questions. No signal-versus-authority violation was identified.

**Total: 0 DESIGN, 0 PRECISION.** Quiet for these two perspectives on this hash. The external round 8's findings remain nonquiet history; this review does not declare aggregate convergence or count that round as quiet. No feature source or runtime/profile state was changed.
