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
rounds: "2"
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
