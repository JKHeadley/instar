# Round 11 — Performance and Decision Completeness

Reviewed the full current specification, the round-10 external reviews, the previous internal report and conformance-round-11.json. Full-file SHA-256 including frontmatter: `ddf46e8147b91a0a4682f2c71f1a6a3cec1518b6d0172f132821516a3da13f99`. No runtime implementation edits or deployment claim.

## PERFORMANCE

**DESIGN: 0. PRECISION: 0.**

The recording-outage contract now explicitly separates fire-time policy reads from the failed origin database/outbox worker (line 229). A validated authority projection lasts at most 30 seconds, cannot outlive its authority lease, is invalidated by known revocation/version invalidation or observer-health loss, and cannot refresh itself. Main and lifeline obtain independently refreshed projections; IPC neither transfers the single execution permit nor manufactures authority. This resolves the concrete failed-store dependency identified in the round-10 review without introducing another durable execution authority.

The 30-second projection is not a permission grant for the entire notice queue. The existing dequeue checks and independently refreshed authority inputs remain necessary during the at-least-100-second full fan-out (line 231); absent fresh authority, later notices suppress. This is an implication of the explicit freshness and dequeue contracts, not an additional design requirement. The specification separately requires a positive injected-origin-worker-failure test that reaches mocked network and a negative expired/failed-policy-authority test. The distinct failures must remain distinguishable in implementation.

Notice workload remains bounded by one coalesced notice per authorized operator hub and outage generation, one process/boot owner, at most eight presealed variants under one child, at most 8 KiB across those variants, independent 1,000-reservation/8 MiB limits, a 1,000-permit queue and at most 10 attempts/second or a stricter existing limit. Only the named notifier can consume permits; source lint and independent counterfeit-permit sabotage now enforce that exclusive boundary (line 227). No extra retry or authority-transfer path was added.

Browser canary recovery is limited to one fresh process/reload and read-only recheck before escalation (line 169). It never submits or replays a message, persists its recovery/attention latch through the existing bounded self-action authority and honors the 15-minute episode brake. Failed writes cannot become restart loops. Existing request deadlines, uncertain-outcome holds, immutable random IDs and migration triggers remain in force. No newly missing resource bound, hot-path scan, archive/pagination obligation or recovery rule identified.

## DECISION-COMPLETENESS

**DESIGN: 0. PRECISION: 0.**

Justin's explicit HOLD-with-notification choice remains the governing failure policy. The changes make its engineering contract executable: notification policy has an independent bounded source, the reserved capability has one permitted consumer, and safe canary self-healing precedes operator escalation. They do not require another operator preference or authorization decision.

Optional display still applies to outage notices, immutable finite variants preserve it, and the alert remains routed through the existing operator hub. No new recipients, unconditional delivery guarantee or automatically assumed MTProto enrollment were introduced. Missing/expired authorization remains an honest notification-suppressed outcome rather than an unrecorded-send exception.

Decision accounting: **9 frontloaded decisions; 0 cheap-to-change tags; 0 contested cheap tags; 0 unresolved operator policy decisions.** Sender inventory, actual browser receipts, harness positive controls and production activation remain empirical implementation obligations. “Open questions: None” is scoped by the immediately preceding explicit implementation-verification statement; it does not establish runtime readiness.

## Count integrity

Round-11 conformance checked **90 standards**, reported **0 findings**, `degraded:false`, and passed the 90-article registry canary. The round-10 external authors declared **2 DESIGN / 3 PRECISION** in aggregate. Their declarations remain intact; this internal review does not reclassify them or treat round 10 as quiet. The parent also reports a separate lessons-review DESIGN finding resolved by the canary recovery contract; that is separate from these two external reports.

This is a quiet internal round for the two assigned perspectives: **0 DESIGN / 0 PRECISION**. Overall convergence still depends on the external reviewers' own round-11 declarations and the required consecutive quiet rounds.
