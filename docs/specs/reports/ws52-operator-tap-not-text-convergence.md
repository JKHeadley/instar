# Convergence Report — WS5.2 Operator-Facing Completion + "Operators Act in Taps, Not Text" Standard

## Cross-model review: codex-cli:gpt-5.5 + gemini-cli:gemini-2.5-pro (RAN — both "minor issues")

Convergence ran on a multi-angle **internal** reviewer panel (security, adversarial, integration/multi-machine, decision-completeness, lessons/foundation) + a round-2 verifier (all Claude-family) AND a round-3 **external cross-model** pass through both available non-Claude families: codex gpt-5.5 and gemini-2.5-pro. Both external reviewers returned **MINOR ISSUES** (no criticals) and explicitly endorsed the architecture ("well-architected and robust… mature understanding of user-centric design, security, and distributed systems"; "commendably avoids common LLM-family blind spots"). Their four refinements (single-flight key identity domain; explicit target→fronting failure/status mesh path; durable operator-message outbox for true idempotency; revocation-before-every-transition + login-issued invalidation) were folded into the spec as R3.1–R3.4. The internal panel caught the three CRITICAL defects (cross-machine surfacing, no-op single-flight, revoked-mandate auto-enroll); the external pass confirmed the corrected design and tightened the distributed-systems edges. Full external-family assurance achieved.

## ELI10 Overview

We're finishing the "account follow-me" feature (one machine borrows another's subscription the safe way — each machine does its own fresh login; no password/token ever copied). The plumbing shipped, but the actual person-facing experience was broken: the only way to approve it was pasting raw JSON into a form, and even then nothing told the other machine to start its login. This spec fixes both: a single tap to approve, a connector that makes the other machine actually run its login and sends you one tappable link, and an enforced rule that no future operator screen can require pasting technical text.

The review process changed the design materially. The first draft assumed the *other* machine would text you the login link — but only your main machine can message you, and the other machine doesn't even know which conversation is "you." So the link would never arrive. We re-architected it so your main machine drives the whole flow. The review also found that the "don't run this twice" guard didn't actually exist in the code (it would have spawned duplicate logins) and that a mandate you'd *revoked* could still trigger a login. All fixed before any code.

The main tradeoff: this is a genuine multi-part feature (a UI card, a cross-machine connector, two enforcement guards), so it's real work, not a quick patch — and its riskiest part (the cross-machine auth connector) deserves the external review pass on a healthy machine before it ships.

## Original vs Converged

- **Originally**, the target machine surfaced the login link to the operator. **After review**, the *fronting* machine (where Approve was tapped and where the verified operator binding lives) owns the operator-facing loop end-to-end; the target just returns its login artifact over the authenticated mesh. This was a hard correctness fix — the original couldn't deliver the link at all.
- **Originally**, "single-flight per (account,target)" was asserted but the live code wired an empty set (a no-op). **After review**, a durable, state-machined, TTL'd single-flight ledger gates issuance, enrollment, reissue, and scan re-offer.
- **Originally**, the point-of-use re-verify checked only the signature + bounds. **After review**, it also checks expiry and live revocation (fail-closed), revoke purges the delivered store, and a mesh verb propagates revocation cross-machine.
- **Originally**, enrollment would have been driven inline in the mesh handler. **After review**, a durable store-consumer (boot-sweep + tick) drives it — restart-safe, handles an offline-at-issue target, tolerates version skew.
- **Originally**, the runtime enforcement hook was a standalone blocker. **After review**, it's a signal into the existing outbound authority (Signal vs Authority).
- **Originally**, all build decisions were implicit. **After review**, ten Frontloaded Decisions (FD1–FD10) resolve every would-be mid-build stop.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security, adversarial, integration, decision-completeness, lessons | ~9 material (3 critical) + many medium | Full rewrite: FD4 fronting-anchored surfacing, durable single-flight, revocation/expiry at point-of-use + cross-machine revoke, durable enroll consumer, agents-in-offer, signal-not-blocker arm 2, mechanical arm 1, honest failure surfacing, FD1–FD10 |
| 2 | verifier | 0 material (2 minor build-time clarifications, fail-safe) | none |
| — | (converged) | 0 | — |
| Standards-Conformance Gate | ran — returned empty/degraded (route dark on this host) | n/a | recorded honestly |

## Full Findings Catalog (round 1, by reviewer)

- **Security:** CRITICAL — delivered-mandate point-of-use checks neither revocation nor expiry; revoke never purges the delivered store. CRITICAL/HIGH — same path skips expiry. SOUND — delivery trust anchor is the authenticated mesh sender (correct). HIGH — single-flight is a no-op; nonce window doesn't dedup the new side effect. HIGH — login-link recipient must be the cryptographically-verified operator, not a topic name. MEDIUM — prompt-injection in the Telegram message + login-link domain must be allowlisted. MEDIUM — arm-2 fail-open heuristic is bypassable (frame as backstop). LOW — gate allowlist needs its own discipline; delivered store is local-writable (auto-enroll widens T12 blast radius). → all folded into rewrite.
- **Adversarial:** CRITICAL — single-flight nonexistent on live path. CRITICAL — revoked delivered mandate auto-enrolls. HIGH — stale mandate auto-fires without fresh intent. HIGH — login-link expiry reissue storm. HIGH — connector can reintroduce the silent stall (failure surfacing). MEDIUM — runtime hook false pos/neg. MEDIUM — build gate gaming/over-block. MEDIUM — concurrent Approve duplicate issuance. → all folded.
- **Integration/multi-machine:** CRITICAL-1/2 — target can't reach operator (lease-gated egress; no operator identity/binding). HIGH — scan pool-scope; topic-transfer strands; version-skew stall. MEDIUM — posture table; restart-durable single-flight; login URL is provider-public (sound). LOW — independent flags per part. → all folded.
- **Decision-completeness:** G2 (agents pair missing — top build-blocker), G3 (expiry default), G7 (login topic resolution), G8 (offline target) as must-frontload; plus card scope, hook/gate patterns. → FD1–FD10.
- **Lessons/foundation:** HIGH — §6b is willpower (prose-attestation) not structure → arm 1 upgrades it. HIGH — store-only is a missing-driver gap → durable consumer, not inline. MEDIUM — onMandateDelivered bounds from caller not verified mandate → derive from readFollowMeBounds. MEDIUM — circular self-verify → separate proof role. MEDIUM — arm 2 must be a signal not a blocker (Signal vs Authority). → all folded.

## Convergence verdict

Converged at iteration 2. No material findings remain. The spec is ready for user review and approval. **Caveat (see banner):** the external cross-model pass was not run on this load-constrained host; re-run it on a healthy machine before the security-sensitive Part B lands.
