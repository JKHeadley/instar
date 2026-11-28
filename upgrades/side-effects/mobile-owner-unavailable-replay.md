# Side-Effects Review — Resume saved mobile messages after reconnect

**Version / slug:** `mobile-owner-unavailable-replay`
**Date:** 2026-11-27
**Author:** Echo
**Second-pass reviewer:** Independent mobile retry reviewer

## Summary of the change

The native chat send route resumes a message on a same-ID retry if it was durably saved and the original handler stopped before attempting routing. The request store claims that resume before any dispatch, and the route uses the saved event and attachments.

## Decision-point inventory

- The existing request lookup can resume one explicitly marked saved send when the serving lease is held.
- The existing request store now durably claims a saved send before the route can dispatch it.
- The owner-unavailable response is marked resumable only at the local branch that never attempted routing.

## 1. Over-block

Request IDs reused with a different body still return the existing conflict. Old unmarked 503 responses still replay because the record cannot prove whether routing was attempted. If current policy would change the saved text or attachment metadata, the retry returns a refusal with a request to review the message.

## 2. Under-block

A process crash after a claim can leave delivery uncertain. Boot recovery continues to report that outcome without dispatching the send again.

## 3. Level-of-abstraction fit

The request store owns the durable claim and the route owns the existing dispatch. The decision uses the saved event and serving lease.

## 4. Signal vs authority compliance

See [Signal vs Authority](../../docs/signal-vs-authority.md). The existing dispatch authority uses a protocol invariant. A saved event can resume only when the prior execution recorded that it did not attempt routing.

## 4b. Judgment-point check

The request hash, delivery state, lease and request-store claim are deterministic protocol facts. No new static heuristic was introduced at a judgment point.

## 5. Interactions

- The existing signed device and conversation checks still govern the route.
- A claimed request reads in progress on overlapping retries. A settled delivery is returned from its record.
- The resume reads the existing event and skips storage append and upload claims.
- A subsequent routing error follows the existing uncertain-outcome handling.

## 6. External surfaces

The endpoint and response schema are unchanged. A same-ID retry may now advance a known unsent message. The request ledger gains one optional field. No new operator action or setting is introduced.

## 6b. Operator-surface quality

No operator interface files changed.

## 6c. Delight the user

No screen changed.

## 7. Multi-machine posture

The existing serving lease and pool router still govern delivery. A failure returned after a routing attempt remains outside the resume path.

## 8. Rollback cost

Revert the code. Existing send records remain readable and older code will replay each stored response.

## Conclusion

The policy-drift revision passed independent source review and the Studio integration, unit and lifecycle runs. It awaits shared verification.

## Second-pass review

The initial independent review identified policy drift between the saved event and the current credential scrub. The patch now compares the current text and attachment metadata with the saved values before claiming the retry. A focused regression for a stricter setting is staged. The independent reviewer rechecked the revised patch and concurred. The review was read-only.

## Evidence pointers

The Studio follow-up passed 50 integration tests, 21 unit and error-handling checks, and two lifecycle tests, exit 0. Evidence is in `mobile-owner-retry-checks.d6pzkY` under the Apple handoff directory.

## Class-Closure Declaration

Scope covers the saved native app send that fails before its first routing attempt. Other causes of owner-unavailable may have attempted delivery. Existing replay and uncertainty handling cover those cases.
