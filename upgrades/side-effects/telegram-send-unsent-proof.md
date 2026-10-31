# Side-Effects Review — connect-phase send failures are retried

**Version / slug:** `telegram-send-unsent-proof`
**Date:** `2026-10-31`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see end)`

## Summary of the change

`src/messaging/telegram-egress.ts` (origin-managed network call): when native `fetch` rejects with connect-phase evidence (`provedUnsentCode` in `OriginTransportCancellation.ts`), it throws `OriginTransportUnsent` instead of the raw error. `TelegramOriginService` treats that like the existing pre-network cancellation: `known-failed` with reason `telegram-connect-failed` and the bounded retry schedule. All other post-invocation failures keep `transport-acceptance-unknown` and now log one redacted line naming the error code. Tier 1, ~90 source LOC.

## Decision-point inventory

- Outcome classification of a failed managed send — modify — a narrow class (connect phase) moves from outcome-unknown (never resent) to known-failed (bounded retry).

## 1. Over-block

No block surface. The change only makes more sends retryable.

## 2. Under-block

The risk runs the other way, toward duplicates. A duplicate needs a connect-phase code on a request that did reach Telegram. ECONNREFUSED, EHOSTUNREACH, ENETUNREACH, ETIMEDOUT and EADDRNOTAVAIL count only when `syscall === 'connect'`, and a multi-address connect counts only when every attempt was a connect failure. DNS codes and `UND_ERR_CONNECT_TIMEOUT` occur before any socket exists. Resets, socket closes, read timeouts and errors without a code stay outcome-unknown, so this change does not recover the losses in those classes. The new log line exists to show which class the remaining losses fall in.

## 3. Level-of-abstraction fit

The proof is made at the only place that sees the native error (the egress network closure), next to the existing pre-network cancellation proof, and is consumed by the same service branch. No new layer.

## 4. Signal vs authority compliance

No new authority. The service's existing known-failed/outcome-unknown decision gets more precise evidence.

## 5. Interactions

The retry uses `nextOriginKnownFailure` with the operation's existing attempt budget and deadline, so it adds no unbounded retries. A forwarded send that hits this on the holder returns a held/known-failed refusal to the forwarder, which retries through the existing forward ladder instead of retaining an outcome-unknown forever. Content dedup and capacity are unchanged. The capacity grant was already consumed, so the debit stands.

## 6. External surfaces

More replies reach Telegram after transient connect failures. One new warn-level log line per outcome-unknown send (an error code and message, never the token or the text).

## 6b. Operator-surface quality

No operator surface changes; fewer "a reply may not have reached you" notices.

## 7. Multi-machine posture

Per machine by design: each credential owner classifies its own sends. Forwarders benefit because the holder now answers with a retryable refusal.

## 8. Rollback cost

Revert the PR. No state migration; rows written as known-failed are ordinary retryable rows.

---

## Second-pass review

Independent reviewer (subagent, staged diff + artifact): found no path where a "proved unsent" classification could cover a request that reached Telegram. The reviewer checked undici's connect timeout (TCP and TLS, before any request byte), the connect-syscall requirement, reused keep-alive sockets (stay unknown), AggregateError with every inner error proved, DOMException timeouts (no code, stay unknown) and proxies. The service branch matches the pre-network cancellation (same retry budget and deadline, no localRefusal flag). The log line is redacted and capped. The reviewer noted two non-blocking test gaps: no explicit DOMException case, and a hand-built AggregateError fixture. Concur with the review.
