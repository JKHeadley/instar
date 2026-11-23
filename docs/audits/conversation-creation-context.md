---
audit: conversation-creation-context
standing-guard: tests/unit/app-creation-hierarchy.test.ts
blind-spot-class: creation-evidence-projection-boundary-mismatch
standard-response-kind: no-change
standard-response-ref: docs/STANDARDS-REGISTRY.md
standard-response-article-id: iterative-audit-to-convergence
standard-response-article: Iterative Audit to Convergence
standard-response-rationale: Existing evidence, access and repeated-review standards already require these boundaries; concrete implementation defects need fixes and regression tests rather than another constitutional rule.
converged: "2026-11-22T23:10:24.130Z"
rounds: "4"
standard-response-digest: "5505039f748ca3861ec2d399966503a57b5080138e073a3d87b7f31683b37c47"
meta-artifact-at: "2026-11-22T23:10:24.130Z"
meta-artifact-digest: "fa82477bfd986eb441429b3737b1f4c895e32920c7db80f473c08348a0f89145"
---

# Generated Chat Origin Runtime Review

This reviews the approved bounded implementation. The broader capped design did not converge; its archive and actual reports remain available. Chief handoff1b9a32d3 replaced it with a smaller scope and a single external/internal design check before building. This runtime audit does not relabel the broader design as successful or claim native release completion.

## Meta-insight

How it arose: adding historical evidence to existing create, deduplication and list code crosses boundaries that module-local validation does not prove: codec compatibility, recovery identity, current access and complete graph inventory.
Why prior controls missed it: the old routes had no creation metadata, and ordinary list filtering was correct for display while being incomplete as the inventory for cycle detection. Fresh independent runtime readers found those composition defects. Existing standards already require current authorization, explicit uncertainty and repeat review; targeted regressions now exercise the actual seams.

## Round 1

Search angles: independent security/correctness, performance and adversarial/untested-path review of persistence, recovery, producer validation, all mobile DTO paths, explicit placement precedence, complete-source cache and full graph computation.
Surface delta: new source/context module, created-event observation/index support, immutable Work Board evidence, session/person writers, non-flushing Chief snapshot, reader-scoped list/preview and exact device route allowance; no companion subsystem or offline-recovery claim.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| AgentServer creation source | Telegram topic identity changes did not invalidate cache | stale-existence | fixed:src/server/AgentServer.ts |
| mobile create | Person source incorrectly carried a session-only request id | producer-schema-mismatch | fixed:tests/integration/app-creation-hierarchy.test.ts |
| Chief complete cache | Stable pending sequence could publish a durable view missing queued placement | pending-is-not-complete | fixed:tests/unit/creation-placement-snapshot.test.ts |
| Graph inventory | Hidden live Work Board chats were omitted from cycle detection | display-filter-is-not-inventory | fixed:tests/unit/app-creation-hierarchy.test.ts |
| List and preview | Source filesystem signature was repeated per row/reference | response-snapshot-not-shared | fixed:tests/integration/app-creation-hierarchy.test.ts |
| Work Board source | Historical accepted control characters invalidated entire backing-chat creation | optional-evidence-overblock | fixed:tests/unit/work-board-creation-context.test.ts |
| Cached mobile create | Completed retry returned child key/title after current access was revoked | stale-child-authorization | fixed:tests/integration/app-creation-hierarchy.test.ts |
| Local create recovery | Retry after durable event could mint another timestamp for the same id | manufactured-evidence-conflict | fixed:tests/unit/app-conversation-service.test.ts |
| Async projection refresh | Captured request scope could disagree with a newer background source signature | mixed-generation-projection | fixed:src/server/appCreationHierarchy.ts |

New findings this round: 9

## Round 2

Search angles: independent reviewers reread the corrected source and the concrete boundary regressions, including real conversation-store producer checks, permission changes, full inventory cycles, captured source reuse, pending flush guards and DTO redaction. Root also checked current session retry availability and the production Slack/Telegram resolver audience against current list identities.
Surface delta: internal unfiltered inventory method; captured per-response source and async signature consistency guard; source validation/replay access corrections; no new authority, no existing-chat mutation, no added recovery guarantee. Security, performance and adversarial reviewers each returned no further material findings after their corrections were verified.

New findings this round: 0

## Verification Limits

Focused unit, HTTP and production AgentServer lifecycle evidence plus throwaway server-startup verification are recorded in the side-effects artifact. Complete exact-head suites remain assigned to the normal shared throughput queue. Native app presentation and deployed route readiness are not established by this audit. Transferable proof and competing-create repairs remain tracked as wc_d3ce8fd1ba6a5cde and wc_baa561764dcb692b under the Chief-selected scope.

## Round 3

Search angles: retained exact-head complete verification failures, asynchronous browser test scheduling, feature ladder registry identity, owner-only route fixture, silent fallback scanner and independent-review artifact parser.
Surface delta: the complete verification candidate exposed four unit failures and an independent-review metadata refusal that the focused feature checks did not cover. No production placement or authorization rule changes in this correction.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|
| tests/unit/console-chats-page.test.ts:375 | Fixed short waits could expire before signed browser quick reads on a loaded worker | scheduling-not-observable | fixed:tests/unit/console-chats-page.test.ts |
| docs/specs/conversation-creation-context.md | Feature ladder declaration named a config path rather than the registry ID | registry-reference-mismatch | fixed:docs/specs/conversation-creation-context.md |
| tests/unit/mobile-session-terminal.test.ts:211 | Exact owner-only fixture did not list the intentional preview route | route-fixture-incomplete | fixed:tests/unit/mobile-session-terminal.test.ts |
| src/core/AppConversationStore.ts:1091 | Fail-closed historical evidence catches lacked explicit scanner-recognized explanations of visible unknown/conflict outcomes or existing reportOnce | fail-closed-explanation-missing | fixed:src/core/AppConversationStore.ts |
| src/server/appCreationHierarchy.ts:133 | Cache/source uncertainty catches lacked explicit response-state justification | fail-closed-explanation-missing | fixed:src/server/appCreationHierarchy.ts |
| src/server/mobileConversationRoutes.ts:448 | Parent identity failure correctly withheld metadata but lacked explicit scanner-recognized explanation | fail-closed-explanation-missing | fixed:src/server/mobileConversationRoutes.ts |
| upgrades/side-effects/conversation-creation-context.md | Actual independent reviewer concurrence was prose under a heading the verifier did not parse | review-evidence-shape-mismatch | fixed:upgrades/side-effects/conversation-creation-context.md |

New findings this round: 7

The full run failed and remains held. Its lifecycle pass does not substitute for integration, which ran zero tests. The corrected focused cases require normal complete verification again on the new exact candidate. The fallback threshold decreased from494 to493 after the exact scanner; it was never raised or waived.

## Round 4

Search angles: independent security/correctness recheck of all correction source catches, complete owner-only route assertion, browser synchronization and substantive reconstruction assertions, ladder registry identity, exact review heading and named reviewer provenance.
Surface delta: source catch explanations, lowered scanner ratchet, fixture synchronization/coverage, registry reference and review evidence shape are corrected. The independent reviewer personally reconfirmed their prior source review and this correction review. No production authorization or hierarchy semantics changed.

| location | behavior | bucket | disposition |
|----------|----------|--------|-------------|

New findings this round: 0

Independent reviewer context_spec_security reported zero material findings in the final correction pass. Focused verification and a fresh trace are supporting evidence only; the previous complete candidate remains failed and a normal complete rerun is required for the corrected exact head.
