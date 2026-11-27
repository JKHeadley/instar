# Side-Effects Review — Smaller Telegram And Slack Chat Updates

**Slug:** telegram-slack-change-feed
**Date:** 2026-11-22
**Author:** Echo
**Second-pass reviewer:** feed_final_review — concurred after independent read-only review of the final source and test diff.

## Summary of the change

The initial unshipped time-window interface is replaced by `knownRows`, an optional bounded set of exact SHA-256 digests of final emitted message rows. Both history routes build their existing complete current page before diffing it. Slack holder reads forward the parameter. The browser retains actual baseline rows, reconstructs full pages from the ordered hashes and changed rows, and broadcasts complete pages to other tabs. Plain reads and the 30-second pool schedule stay unchanged. Tier 1: reversible read-only optimization, no new storage schema, migration, authority or visible UI. Scope remains the same parity card and existing PR #3640. Review caught and repaired the Slack weaker-copy/privacy ordering bug and timestamp suppression risk; it also required actual baseline rows for new tabs and duplicate-hash support.

## Decision-point inventory

- Added structural validation of digest syntax, bounded count/length and backwards-cursor incompatibility: invariants.
- Exact complete-row identity determines payload omission, not admission or semantic filtering.
- Browser baseline adoption requires complete row/hash correspondence: invariant.
- Existing device admission, audience, origin, token and holder revocation checks are passed through unchanged.

## 1. Over-block

No new message-admission authority. Malformed opt-in queries return400. A client may omit its own exact rows by supplying their digests; the empty baseline retrieves everything in the current page. An inconsistent browser baseline is discarded and refreshed, rather than hiding unknown rows. Timestamp ordering never controls inclusion.

## 2. Under-block

No new read permission is granted. SHA-256 digests cover only rows the existing route has already authorized and privacy-shaped. They are content identifiers, not credentials. The protocol retains the existing newest-page limit and cannot recover history outside it; it makes no durable ingestion-feed claim. A failed API read never advances browser state.

## 3. Level-of-abstraction fit

The diff belongs at the final response layer: Telegram after store/media/origin joins, pool merge and view-signature stripping; Slack after store/platform deduplication and device shaping. Earlier filtering was proven unsafe: an authoritative older stored Slack caption could be displaced by its newer raw platform mirror. No message-log or signed-mesh protocol is changed.

## 4. Signal vs authority compliance

Reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md). Hard structural validation and exact content equality only; no semantic gate or irreversible action. Existing authentication and audience authorities remain responsible for access.

## 5. Interactions

Read positions, pins, backwards cursors and pool status are not filtered. Delivery, attachment and origin changes alter the complete-row hash and resend the row. Snapshot ordering is preserved, including identical duplicate rows. The browser captures the exact sent baseline before awaiting a request; it caches rows and hashes atomically, caps cached conversations, and reconstructs before cross-tab broadcast. Invalid or incomplete deltas clear the baseline; older full-page answers do not teach fingerprints. First-load and scroll-back still use plain reads.

## 6. External surfaces

An optional query and response field on existing routes, consumed by the web chat. Native apps retain existing behavior until adoption. Older agents/holders ignore the query and return a full page. The unshipped `after` parameter is removed rather than left with clock-sensitive semantics. No page layout, user wording, compose behavior or destructive control changes.

## 6b. Operator-surface quality

This changes background requests and row caching, not the rendered conversation layout. The primary action remains reading and composing messages. No hashes, baseline identifiers, protocol labels or other raw internals appear as primary content. No destructive action is added or emphasized. Existing text stays in plain language and the existing phone-width layout is unchanged. The browser wiring test closes and reopens a conversation and verifies complete readable rows are restored even when the network delta is empty. These answers apply to both changed dashboard files; neither introduces a new UI element.

## 7. Multi-machine posture (Cross-Machine Coherence)

Unified through existing proxied reads. Telegram peers return normal bounded pages; the answering server computes fingerprints after its final pool merge/privacy shaping. Slack forwards hashes only through the trusted holder path with owner revalidation, URL admission, existing body limits and deviceView checks. A different source or restarted server can resend rows; stale digests cannot hide changed content. No new durable machine-local state or generated URLs.

## 8. Rollback cost

Revert the PR. No database/config migration, credential changes or state repair. A browser sending hashes to a reverted server receives a full page and drops its digest baseline.

## Verification And Proportion

Targeted helper, browser, holder, HTTP and production-wiring lifecycle tests are run. Exact counts and final independent verdict are appended after completion. TypeScript no-emit check passed. Full-suite validation belongs to the shared Local Verify owner; no full suites run by hand. The unrelated main-level Docs Coverage issue is excluded as requested by Chief of Staff. One corrective commit is planned after independent review and gate validation; no auto-review bypasses.


## Final Review And Targeted Results

Independent reviewer verdict: no material code issues found. The reviewer checked final-row hashing, baseline capture and reconstruction, duplicate rows, holder privacy/admission and metadata preservation. Separate frontend and Slack reviewers implemented and tested the clock, weaker-copy and cross-tab fixes.

- Unit: 4 helper, 10 holder and 91 browser model/page checks passed (105 total).
- HTTP integration: 7 Telegram and 17 Slack checks passed (24 total).
- Production-wiring E2E: 3 Telegram fixture checks and 3 Slack/holder checks passed (6 total).
- Total targeted checks: 135; zero failures. TypeScript no-emit check and git diff --check passed.
- Full regression suites remain a Local Verify requirement for the final PR head. No full suite or deployment is claimed here.

Corrective scope: 20 implementation/test/documentation files, approximately500 added lines and400 removed lines. No unrelated class-coverage documentation is included. One final source review pass after the two design findings; two commit-gate attempts (first correctly required the explicit operator-surface-quality section); one corrective commit planned. This is larger than the initial timestamp filter because complete browser baselines and production-wiring regression cases are required to preserve existing polling behavior.
