# Side-Effects Review — Conversations hierarchy read model and routes (unmounted)

**Version / slug:** `conversation-graph-read-model`
**Date:** `2026-11-05`
**Author:** `Dawn (claude-code), read-API owner for Echo's Conversations run`
**Second-pass reviewer:** `independent verifier (claude-code subagent)`

## Summary of the change

Adds `src/core/conversationGraphRead.ts` (`ConversationGraphReadModel` over a `GraphReadSource` port) and `src/server/conversationGraphRoutes.ts` (`createConversationGraphRouter`: `GET /conversation-graph/roots`, `GET /conversation-graph/nodes/:ref`, and `/mobile/conversation-graph/…` twins). Spec: `docs/specs/conversation-effort-hierarchy-v3.md` §7.1–7.5 (increment B's read surface). Neither module is mounted, constructed or imported by any running code. Readiness is the source's `readiness()` (the increment-A proof runtime); until it reports ready every request is 503. Tests: `tests/unit/conversation-graph-read.test.ts` (14, including HTTP via supertest). Tier 2: an owner-only read surface over private conversation structure. ~330 LOC across 3 files.

## Decision-point inventory

- Readiness gate — **add** — 503 `conversation-graph-not-ready` unless the source is ready; nothing else is computed.
- Viewer resolution — **pass-through** — the caller's `resolveViewer` decides who the owner is; null is 403 `hierarchy-owner-only`.
- Viewer filter — **add (via GraphProjection)** — applied before sort, search, counts, paths, children and paging.
- Cursor validity — **add** — 409 `cursor-stale` for grant change, snapshot expiry, or a malformed/foreign-scope cursor.

---

## 1. Over-block

- A valid cursor is refused after `snapshotTtlMs` (default 120 s): a client paging slowly restarts from page one. Intended (§7.5 "short-lived authorized snapshot").
- A cursor is refused after any grant-version change, even one that would not affect this viewer's rows. Intended: the cheap rule is the safe one.
- The snapshot store is in memory and capped at 1,000 entries; a server restart, or more than 1,000 live snapshots, makes outstanding cursors `snapshot-expired`. Clients must restart from page one on 409.

## 2. Under-block

- Who the viewer is, and what `grantVersion` means, are entirely the caller's. A `resolveViewer` that returns an owner viewer for a non-owner would expose the owner's graph. This module cannot detect that; the runtime owner's mount, with the device allowlist (`ownerOnly`) and dashboard operator proof, is where that is enforced.
- `certifiedEvents()` must return only the all-member verified final-certificate union. A source that passes the raw local event file would surface uncertified state. Stated as a source contract; not checkable here.
- A row revoked inside a snapshot is dropped from its page, but the page's length and `nextCursor` still reflect the frozen snapshot, so a viewer could infer that a row was dropped from a short page. No identity or content leaks; the count of the snapshot was already authorized when it was frozen.
- A frozen children snapshot keeps serving a child that moved to another parent after page 1, while the same response's `visibleChildCount` is computed live — so one response can disagree with itself. This is the cost of cursors that graph events cannot invalidate (§7.5); nothing hidden is served, because every row is re-checked against `mayView`.
- Every request (including page 2+, 404 and 409) re-reduces and re-projects the full certified event set. Correct but O(events) per request; a cached projection keyed by revision is a later optimisation, not a correctness issue.
- Spec gaps, stated: §7.3 describes a "signed keyset cursor"; this cursor is unsigned base64url JSON. Safe here because the server holds the binding (snapshot id → principal, grant version, scope) and the snapshot id is 128 random bits, but it is not signed. §7.3 also lists `replicationState`; the response carries `partial` + `partialReasons` instead, as agreed with the dashboard and native owners on 2026-11-05.

## 3. Level-of-abstraction fit

Right layer: the model is pure and shared by the dashboard and mobile surfaces (§7.1, one projection module), authentication stays with the caller that holds the evidence, and certification stays with the runtime that holds replication state.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface on any live path (nothing mounts it).

When mounted, its refusals (403/404/409/503) are access control and protocol validity over private data, not judgment calls; they are deterministic by design.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals judgment point. The readiness decision is delegated to the runtime's proof state, not decided here.

## 5. Interactions

None at runtime. It reuses `reduceGraph` and `GraphProjection` from `src/core/conversationGraph.ts` (a5190cf2b, 00601f123) and adds no state file. When the runtime mounts it, the router must be registered in `DEVICE_ALLOWLIST` (owner-only) and `CAPABILITY_INDEX`, or phones get `device-not-allowed` and the capabilities test fails — both are the runtime owner's mount work.

## 6. External surfaces

None until mounted. The response shapes are the contract agreed with the dashboard and native owners (Echo, 2026-11-05): NodeRef objects, `metadata.frontDoor` presence as the only front-door signal, snapshot cursors, `partialReasons`.

## 6b. Operator-surface quality

Not applicable — no dashboard renderer or form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: no new state surface.** All graph state is read through the source port, whose posture is the runtime's (the all-member certified union). The cursor snapshots are per-process request memory, not durable state: nothing persists them and nothing replicates them. A cursor issued by one machine is refused (`snapshot-expired`) by another, and the client restarts from page one, which is the documented 409 path.

**Status surfaces:** none added or changed.

## 8. Rollback cost

Revert the commit. Nothing is mounted, so no client depends on it yet.

## Conclusion

An unmounted, owner-only read surface whose availability is bound to the increment-A proof runtime, with privacy filtering before every derived value and cursors that unrelated graph events cannot break.

## Second-pass review

**Reviewer:** independent-verifier (Claude Code subagent, fresh context, 2026-11-05)
**Independent read of the artifact: concur**

Round 1: concern — node `provenance` was taken from unfiltered placement data and revealed a placement under a hidden parent; repeated or oversized `cursor`/`q` values were silently treated as absent (fresh page 1, or an unfiltered list); snapshots were stored even with no next page; scope was checked before principal; the revocation test was weak. All fixed with regressions; the two inherent behaviours it found (frozen-page vs live-count disagreement, per-request reduction) and the spec gaps are now disclosed under Under-block. Round 2: "Concur with the review" after re-running every probe; its one untested path (a repeated `cursor` on the node route) now has a test.

## Class-Closure Declaration

- **Defect class:** `unbounded-self-action`
- **Closure:** `n/a` (negative declaration)
- **Reason:** No self-triggered action: a request/response read model and router; no timer, loop, retry, restart, spawn or notification.

## Evidence pointers

- `npx vitest run tests/unit/conversation-graph-read.test.ts` → 14 passed.
- `npx tsc --noEmit -p .` → exit 0.
