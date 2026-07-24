# Side-Effects Review — Telegram reply bounded outcome

**Version / slug:** `telegram-reply-bounded-outcome`
**Date:** `2026-07-19`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `/root/cross_engine_completion` (independent reviewer subagent)

## Summary of the change

The shipped Telegram reply template bounds its final HTTP request and explicitly renders transport ambiguity. This closes `fb-9c139a25-11e` at the outcome-observability class level.

## Decision-point inventory

- Final relay curl — modified transport boundary — limits connection to 3 seconds and total time to 125 seconds.
- Curl transport-status branch — new — reports an ambiguous outcome and prevents automatic recovery classification when no HTTP status exists.

## 1. Over-block

No valid HTTP response is rejected. The overall client window is five seconds longer than the server's 120-second outbound route budget, so the server retains authority to return a structured success, timeout, or tone rejection. A transport failure exits as ambiguity rather than falsely blocking the message.

## 2. Under-block

The helper cannot prove whether the server accepted a request before a network failure. It therefore makes no delivered/not-delivered claim. The delivery id is surfaced for durable investigation, and the caller is explicitly told to verify before retrying.

## 3. Level-of-abstraction fit

The boundary belongs in the caller that owns curl lifecycle and transcript output. The server already owns semantic tone review and delivery; moving transport-process interpretation into that server would not help a caller that never receives an HTTP response.

## 4. Signal vs authority compliance

Per `docs/signal-vs-authority.md`, curl exit status is exact transport evidence, not a semantic heuristic. It has authority only to classify the HTTP outcome as unavailable. It does not claim delivery failure or authorize a retry.

## 4b. Judgment-point check

No competing-signals judgment. A nonzero curl exit with no completed HTTP response deterministically means the caller lacks an HTTP outcome; delivery remains explicitly ambiguous.

## 5. Interactions

HTTP 200, 408, 422, and recoverable status handling is unchanged. The new transport branch runs before HTTP parsing, so a synthetic `000` from a completed curl remains in the existing recovery matrix while an actual curl failure never gets blindly enqueued. The original shell did not enable errexit; the change preserves that state.

## 6. External surfaces

Agents now receive a non-empty, actionable ambiguity message after a bounded transport failure. Normal user-visible Telegram messages and tone rejection text are unchanged.

## 6b. Operator-surface quality

The output names uncertainty, prohibits blind retry, and includes the delivery id without exposing credentials or raw response internals.

## 7. Multi-machine posture

Machine-local by design: the helper calls the owning agent server resolved from the owning agent home. The reported delivery id is the same id sent to that server, so investigation remains tied to the correct machine-local ledger. No URL or replicated state is introduced.

## 8. Rollback cost

Pure template and test change. Revert and ship a patch; existing installed scripts will be refreshed by the normal template migrator. No data repair or schema migration is needed.

## Conclusion

The missing standard was outcome-bearing-call completeness: external calls must be bounded and must render success, rejection, or ambiguity. The process gap was HTTP-status coverage without transport-exit coverage. The behavioral curl-timeout test closes the class. Independent review is required because this changes an outbound messaging decision path.

## Second-pass review

**Reviewer:** `/root/cross_engine_completion`
**Independent read:** concur after correction. The reviewer initially found that the immediately prior shipped template SHA was absent from the safe migration allowlist, so existing agents would receive only a `.new` candidate, and that the emergency inline fallback retained an unbounded curl. Both were required corrections. The migration now recognizes the exact prior SHA and behaviorally proves in-place stock upgrade while preserving customized scripts; the fallback now has equivalent finite transport bounds and explicit non-HTTP ambiguity handling. The reviewer independently re-inspected both closures and reported no remaining over/under-block, timeout, dedup/recovery, shell, or signal-vs-authority concern.

## Evidence pointers

- `tests/unit/telegram-reply-bounded-outcome.test.ts`
- `tests/unit/PostUpdateMigrator-telegramReply.test.ts`
- `tests/unit/telegram-reply-recoverable-classification.test.ts`
- `tests/unit/telegram-reply-port-resolution.test.ts`
- Feedback `fb-9c139a25-11e`

## Class-Closure Declaration (display-only mirror)

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: { enforcementType: gate, citation: src/templates/scripts/telegram-reply.sh#CURL_STATUS, howCaught: the helper makes no delivery claim without a completed HTTP result; every final request has finite bounds and every nonzero transport exit renders explicit ambiguity on stdout and stderr without authorizing retry }`.
