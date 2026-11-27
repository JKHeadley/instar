# Side-Effects Review — App send refusal audit

**Tier:** 1, SMALL, reversible observation. **Author:** Instar Agent (echo).

## Summary

Add a fixed-schema warning on the existing device-authenticated app chat not-serving refusal. Connect existing coordinator leaseFreshness through MobilePairingService; sample after the unchanged boolean authority. No lease, response, request store, retry, policy, capacity or runtime setting changes. Historical 11:29 cause remains unknown.

## Decision-point inventory

The original holdsLease boolean remains the sole preflight decision. Diagnostic field validation affects only what can be logged. A sample reporting holding after refusal remains visible as such.

## 1. Over-block

No new block/allow surface. A throwing read, clock or writer cannot change the original 409.

## 2. Under-block

This observes refusal rather than fixing its cause. A missing log or unavailable sample cannot prove lease health. The timestamp and verdict are sampled after the false preflight and may differ at a clock boundary. Record fields explicitly label that relation.

## 3. Level-of-abstraction fit

The refusing route is the missing evidence boundary. Existing native leaseFreshness provides the reason categories; no parallel ownership policy or inferred cause is introduced.

## 4. Signal versus authority

Reference: [signal versus authority](../../docs/signal-vs-authority.md). The warning is a signal only. Existing lease authority remains in control, and no diagnostic consumer actuates on the log.

## 5. Interactions

The call is after request-store replay and owner/config validation but before rate and intake work, exactly on the original false branch. No request is admitted or reserved by logging. One warning per actual preflight refusal; successful sends and stored replays add none. The optional read is synchronous and contains no network access. Native server stderr retention applies; no new log store or repeating monitor.

## 6. External surfaces

Fixed fields: kind, server time, PID, sample relation, allowlisted observed verdict, numeric renewal age and TTL. No request, device, topic, credential, raw error or arbitrary callback field. Invalid values become null/unavailable. Logging failure is isolated. No external calls or user notices.

## 7. Multi-machine posture

Machine-local by design: each refusing server records its own process and lease sample. Existing warning-log collection remains the evidence path. No new durable state, URL, replicated authority or notification; there is no one-voice action.

## 8. Rollback

Revert the helper, route call, dependency and awareness text in a normal patch. Existing logs remain historical observations; no migration or state repair.

## Verification

Tests prepared for allowlisted categories, invalid/unavailable fields, throwing read/writer, strict privacy, signed HTTP refusal and replay behavior, and real coordinator/lease data through production AgentServer construction. Actual allocated unit 9/9 and signed HTTP 18/18 passed. Lifecycle first failed on a fixture wire-key versus PEM mismatch; stopped, preserved the failure, corrected only that fixture through independent review, then the separately authorized lifecycle rerun passed 1/1. Runtime, unit and HTTP hashes remained unchanged. Normal final build passed. Complete coordinator verification remains required; no release acceptance claimed.

## Independent review

Dedicated reviewer app_refusal_audit_review found a misplaced production dependency, a repeated verdict accessor read, and missing awareness frontmatter. Each is corrected before test allocation; a changing-getter regression verifies one validated read, and lifecycle setup is covered by cleanup. Final actual reviewer readback concurs with corrected source and all artifacts. No tests were run by the reviewer and no test acceptance is claimed.

## Class closure

No agent-authored-artifact defect. One warning follows one pre-existing request refusal; no autonomous action loop, retry, spawn, restart, notification or queue mutation is introduced.
