# Side-Effects Review — R8-M1 Arm B: adapter-send timeout → 408 (not 500)

**Version / slug:** `slack-outbound-robustness-r8m1-arm-b-adapter-timeout`
**Date:** `2026-07-03`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

The second arm of the accepted build residual R8-M1 (spec §2.4 / `accepted-build-residual` frontmatter). The deployed `/slack/reply` handler wraps the outbound adapter call (`ctx.slack.sendToChannel`) in a bare `try/catch` that answers `500` on ANY error (`routes.ts` slack-reply catch). A SLOW send (Slack API accepted the post but the call hasn't returned) that trips the route budget therefore surfaces as `500` → `recovery-policy` classifies `5xx` as RETRY → the sentinel redrives → the message double-posts. The fix bounds the adapter call with an explicit timeout STRICTLY BELOW the §2.4 single-flight reservation TTL (`SLACK_ADAPTER_SEND_TIMEOUT_MS = 30_000` < 60s) via `sendWithAdapterTimeout`; a timeout throws the typed `AdapterSendTimeoutError`, which the catch maps to `408 { error: 'adapter-send-timeout', ambiguous: true }` — the AMBIGUOUS class both the reply scripts (`slack-reply.sh:108-117`) and `recovery-policy` (`finalize-ambiguous`) already treat as NEVER-re-posted. A genuine adapter error still answers `500`.

Files touched: `src/server/routes.ts` (the `sendWithAdapterTimeout` helper + `AdapterSendTimeoutError` + `SLACK_ADAPTER_SEND_TIMEOUT_MS` constant, and the `/slack/reply` send-and-catch wiring), `tests/unit/adapter-send-timeout.test.ts` (both sides of the boundary), `tests/integration/slack-reply-adapter-timeout.test.ts` (route mapping: timeout→408, real-error→500, success→200).

## Decision-point inventory

- `sendWithAdapterTimeout(send, timeoutMs)` — add — races the send against a bounded timer; on timeout rejects `AdapterSendTimeoutError` and abandons the still-running send. Clears the timer in `finally` (no dangling handle).
- `AdapterSendTimeoutError` — add — a typed marker so the catch can distinguish "ambiguous timeout" from a real server error without string-sniffing.
- `SLACK_ADAPTER_SEND_TIMEOUT_MS = 30_000` — add — pinned strictly below the §2.4 reservation TTL (60s) so a still-in-flight handler can never outlive its reservation and race a retry.
- `/slack/reply` catch — modify — `AdapterSendTimeoutError` → `408 ambiguous`; every other error keeps today's `500`.

## 1. Over-block

None. The change only RE-CLASSIFIES a timeout that used to be a `500`. A `408` is strictly SAFER than the `500` it replaces (408 → finalize-ambiguous vs 500 → retry → double-post). No legitimate delivery is newly rejected; a successful send still answers `200`, a genuine error still `500`.

## 2. Under-block

The 30s budget is a heuristic ceiling: a send that returns at 29.9s is delivered normally; one at 30.1s is abandoned and reported ambiguous even though it may still land. That is the CORRECT ambiguous direction (the message MAY have posted → never blindly re-post). The full §2.4 single-flight reservation (a later increment) is what makes the ambiguous outcome converge to exactly-once via the durable id-ledger + content dedup; this arm only stops the 500→retry→double-post terminal. The Telegram `sendToTopic` path is out of scope for Arm B (its own error handling is unchanged; the spec cites the slack 500 catch-all as the grounded defect).

## 3. Level-of-abstraction fit

Yes. The timeout wrapper sits at the route — the single place that owns the HTTP response class for a send — and the classification (`AdapterSendTimeoutError` → 408) is one visible branch in the existing catch. The wrapper is a pure, injectable-timeout helper unit-testable in isolation; the route test proves the mapping.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this is deterministic transport classification, not a brittle string-matcher gaining blocking authority. It relaxes a double-post-causing 500 toward the loss-free ambiguous 408; it never withholds a message (the tone gate remains the sole withholding authority, unchanged).

## 5. Interactions

Composes with R8-M1 Arm A (recovery-policy already maps 408 → finalize-ambiguous) and with the deployed `slack-reply.sh` 408 branch (verify-before-resend guidance). The §2.4 single-flight reservation (a later increment) reads the same 30s budget as its `adapter-call timeout < reservation TTL` invariant. No change to the success or genuine-error paths.

## 6. External surfaces

New exported symbols (internal): `sendWithAdapterTimeout`, `AdapterSendTimeoutError`, `SLACK_ADAPTER_SEND_TIMEOUT_MS`. New response shape on `/slack/reply`: `408 { error: 'adapter-send-timeout', ambiguous: true }` on a send timeout (previously a `500`). No new route, config key, env var, or CLI.

## 6b. Operator-surface quality

No operator-facing surface changes — the 408 is consumed by the reply script + sentinel, which already render ambiguous guidance to the agent.

## 7. Multi-machine posture

The timeout wrapper is machine-local and stateless (a per-request timer). No cross-machine state.

## 8. Rollback cost

Trivial: revert the `/slack/reply` catch branch + the three symbols + the two test files. A rolled-back binary answers `500` on a slow send again (the deployed behavior). No schema, config, or persisted state.

## Conclusion

A minimal, deterministic route-level classification that closes the R8-M1 Arm B regression (a slow adapter send terminalizing as 500 → retry → double-post) by mapping an adapter-send timeout to the ambiguous 408 both the script and recovery-policy already handle as never-re-posted.

## Second-pass review (if required)

Not required — pure additive transport classification, fail-toward-not-double-posting direction, trivially reversible, both boundary sides tested.

## Evidence pointers

- `src/server/routes.ts` — `sendWithAdapterTimeout`, `AdapterSendTimeoutError`, `SLACK_ADAPTER_SEND_TIMEOUT_MS`, the `/slack/reply` send wrap + catch mapping.
- `tests/unit/adapter-send-timeout.test.ts` — resolves-fast / hangs-past-budget / real-error-propagates / TTL-invariant.
- `tests/integration/slack-reply-adapter-timeout.test.ts` — 408-on-timeout / 500-on-real-error / 200-on-success.
- `docs/specs/slack-outbound-robustness.md` §2.4, `accepted-build-residual` frontmatter (arm b).

## Class-Closure Declaration (display-only mirror)

Class: the adapter-send-timeout member of the R8-M1 status-composition class. Arm A (recovery-policy 409) and this Arm B (route timeout→408) both close status members that would otherwise drive a double-post; Arm C (script 409 classification) closes the last member in its own increment.
