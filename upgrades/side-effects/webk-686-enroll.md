# Side-Effects Review — Telegram Web K 686 enrollment, unreadable-result outcome, snapshot error logging

**Version / slug:** webk-686-enroll
**Date:** 2026-11-08
**Author:** Echo
**Second-pass reviewer:** independent subagent (see end)

## Summary of the change
Tier 1. Three runtime files (about 30 runtime lines), one evidence report, and unit, integration and production-boot E2E tests. (1) `ReviewedWebKBuilds.ts` adds Web K 2.3 (686) with its three exact asset names and digests, backed by `docs/specs/reports/telegram-message-origin-evidence/web-k-2.3-686-review.md`. (2) `TelegramWebKDriver.invoke` reads 686's new client-side `NETWORK_RESULT_UNREADABLE` 400 as an unknown outcome instead of a refusal. (3) The snapshot route logs the error class and message it used to swallow, server-side only. Effort: no spec rounds; one source-map review.

## Decision-point inventory
- Reviewed-build list: an existing authority (enrollment admits only listed builds). This adds one reviewed entry. The CLI canary still requires exact bytes, the account and self-peer resolution.
- Broker outcome classification: refusal → `known-failed`, otherwise `outcome-unknown`. One error type moves from refusal to unknown. That makes the system more conservative: the operation stays held and is never resent blind.
- The snapshot route: no decision change. The 409 body is unchanged.

## 1. Over-block
A genuinely refused send can never carry `NETWORK_RESULT_UNREADABLE`, because that type is produced only client-side, after the server returned an `rpc_result`. So no real refusal is turned into an unknown outcome. The only cost: an unknown outcome holds the operation for receipt resolution rather than closing it as failed.

## 2. Under-block
Other future client-side synthetic errors would still map by code. Any later Web K build needs a new review before enrollment, and that review is where such errors are found.

## 3. Level-of-abstraction fit
The mapping lives in the driver, the only layer that sees Web K's error `type`. The broker's code-based classification stays unchanged.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. No new blocking authority. The build list is a reviewed-code allowlist (an existing authority). The outcome change moves toward holding, not toward sending.

## 4b. Judgment-point check
None.

## 5. Interactions
The outbox and receipt resolution already handle `outcome-unknown` from the broker (deadline and uncorrelated-result paths). The log line goes to the server's console log next to other `[telegram-origin]` warnings. It holds the profile id, the error class and up to 200 characters of message. Broker and driver errors are fixed codes and carry no message text.

## 6. External surfaces
The browser routes start working on Web K 686 once the operator machine runs the reviewed enroll CLI. The HTTP response bodies are unchanged.

## 7. Multi-machine posture
The build list ships in code to every machine. Enrollment is machine-local BY DESIGN: each machine's managed profile is enrolled by its own canary.

## 8. Rollback cost
Plain revert. A machine enrolled at 686 would fall back to holding (409) until a new reviewed release ships. The prior reviewed build (684) is kept in the profile's enrolled list.

## Second-pass review
Concur with the review.
- A NETWORK_RESULT_UNREADABLE error becomes a plain Error, which the broker's catch never counts as a refusal; since `invoked` is already true it returns outcome-unknown (reason browser-transport-failed), never a resend-safe known-failed.
- Only that exact Web K type string is diverted; every other rpcError (genuine 400/401/403/404/406/420 server refusals) still goes through TelegramRpcRefusal unchanged. A misread here errs toward "unknown", the safe direction.
- The snapshot route response body is unchanged (fixed 409 code); the log carries profileId, error class and a 200-char error message only. Driver errors are fixed strings or Web K error text, not message bodies or session tokens; low residual risk.
- The 686 entry is well-formed, newest-first, and all three asset names and full SHA-256 digests match the evidence report exactly.
