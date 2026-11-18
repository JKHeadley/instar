# Side-Effects Review — Paging through Needs you

**Version / slug:** needs-list-pages
**Date:** 2026-11-17
**Author:** Echo
**Second-pass reviewer:** needs_final_review

## Summary of the change

The existing server composer calculates all visible rows before bounding the response. This change makes those rows reachable through the two existing Needs routes. The dashboard strip displays a page at a time with working action links. It propagates relevant HTTP status codes and loads subsequent pages over the network. Grounding: work-front-doors §1 and §2.1, previously filed feedback fb-e00b29e7-5d5.

## Decision-point inventory

- Existing viewer resolution and source filtering run for each request. The server checks a continuation against the request's admitted principal, current ordered item IDs and destinations.
- The response adds navigation metadata only when more than 100 rows exist. Section transitions distinguish malformed requests, stale pages and refused reads.
- The console replaces the visible page after validating its position. A stale continuation offers reload. A network failure offers retry. The existing weak-network component excludes continuation reads from offline storage.

## 1. Over-block

A changed destination or item order can require a fresh first page while the person is navigating. This costs an extra click. The person can still reach the current list and existing source actions. A process restart or switch to another server also requires a fresh first page.

## 2. Under-block

The continuation describes membership, order and action destinations. A change solely to descriptive text may leave navigation valid, and a fresh read supplies the new wording. Source completeness continues to follow the existing per-source checks and grace periods. Each action's destination still checks its own permissions.

## 3. Level-of-abstraction fit

The source composer has the complete viewer-filtered list before applying the response limit. This is where a page can be selected consistently. Both HTTP entry points use the same code. The dashboard accepts server-provided cursors and never invents its own offsets or attempts to retrieve all pages at once.

## 4. Signal vs authority compliance

Reference: docs/signal-vs-authority.md. Access decisions remain with the existing device and viewer permissions. The server deterministically checks the integrity of a paging position. The page token grants no action or read permission. A list refresh cannot make a decision on a user's behalf.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals judgment is introduced. Page size, visible identities and ordering are enumerable properties of an already authorized read. No label text, model assessment or urgency metric decides access.

## 5. Interactions

The first-page owner cache stores a bounded page and its digest. A continuation obtains a fresh composition and concurrent owner builds can share the in-flight read. Team reads come from the caller's current board. Canary probes keep their synthetic row within the page bound. The strip keeps one page per mount. Late responses cannot replace a newer mount or navigation, and background refresh respects focus. There are no writes to work items.

## 6. External surfaces

The optional continuation object and cursor query extend existing GET routes. Older clients can read their existing first-page fields. Older servers retain the omission notice on the newer dashboard. Phone clients may consume the same contract through their signed read. No new operator permissions, storage migration or network delivery is required.

## 6b. Operator-surface quality

1. Three needs and their original actions remain immediately visible. An expanded list has a position and controls for previous and next pages.
2. People see titles, reasons and ranges. Cursor values stay out of the interface.
3. Paging navigates a list. It introduces no destructive operation.
4. At 390 and 1280 CSS pixels, the full console fixture opened item 105, moved backwards, and recovered from a changed list without horizontal overflow.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN for paging tokens: each process validates against its own current projected list and ephemeral signing key. Switching to a different machine or process gives the user a reload path. Existing source-level replication and pooled reads keep their current behavior. No durable page position, duplicate notification or machine-specific action URL is added.

## 8. Rollback cost

Revert the new paging change. Old clients already tolerate absence of the optional fields. Previously issued continuation tokens are temporary. No database cleanup is required, and the earlier omission notice is independently reviewed in #3361.

## Conclusion

A list of 105 visible needs can be opened in two bounded pages. Viewer checks run before continuation use. Full production verification, merge and installation belong to the merge-line owner.

## Second-pass review (if required)

The independent reviewer concurred with the source and artifacts after two corrections. A focused heading now permits refresh, including a stale or denied response. The production E2E fixture now checks the actual Desktop destination for an item on the second page. The reviewer checked the changes in source. Local Verify owns execution of the integration and E2E tests.

## Evidence pointers

Tests cover the composer, signed HTTP middleware, production AgentServer owner/mobile routes, console pagination and weak-network behavior. The full console browser fixture and guard results are recorded under the isolated worktree's .instar/state/build directory. Full integration and end-to-end suites are assigned to Local Verify.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This fixes a runtime presentation and retrieval limitation. The polling mechanism reads status and does not start a recovery action.
