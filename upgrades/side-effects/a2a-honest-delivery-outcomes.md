# Side-effects review: a2a-honest-delivery-outcomes

Spec: docs/specs/a2a-honest-delivery-outcomes.md (converged 8 rounds, approved 2026-10-06).

## Change summary
Sender consumes the relay's per-message verdicts (ack delivered/queued/rejected, delivery_expired, socket-level banned) via one dispatcher on ThreadlineClient; A2ADeliveryTracker records them (six additive columns + `unconfirmed` state); a 15-min silence sweep relabels verdict-less relay rows to `unconfirmed`; `/threadline/relay-send` waits ≤3 s and answers `relayStatus` (502 on refusal); pool-scope peer health (token-checked); counters on authed `/health`; `hasCanonicalReplyFor` treats a lone `relay-rejected` outbox entry as unsettled; CLAUDE.md awareness section + migration.

## 1. Over-block
No new gate. The only refusal surface is a relay-refused send answering 502 instead of 200 — the relay already refused it; the 200 was the bug. A slow relay adds ≤3 s to a send (route latency only; delivery is unchanged). Waiter cap (1 000) resolves excess waits to `unconfirmed` — reporting only.

## 2. Under-block
Verdicts the relay never sends (relay restart drops its in-memory queue; flush/expiry while the sender is disconnected; a late verdict landing on a different machine of this agent) end as `unconfirmed`, not `failed` — honest unknown, documented in the spec. A sender ban without a messageId cannot be attributed per message (hint only). Unsigned/unacked `delivered` rows stay pending until a reply (Layer B of the parent spec is the exit).

## 3. Level of abstraction
Verdicts are consumed at the one client that receives them (ThreadlineClient) and recorded by the existing tracker; the route only reports. The sweep and wiring live in one module server.ts calls, so tests run production wiring.

## 4. Signal vs authority
Pure recording/reporting. No path blocks, reroutes or resends a message. The 502 reports a refusal the relay already made. Relay prose is mapped to fixed codes and never reaches an agent. The sweep only relabels to a non-terminal state.

## 5. Interactions
- A2ARedeliverySentinel (off by default): `findOverdue`/`markAttempt`/`markEscalated` now include `unconfirmed` so swept rows stay reachable.
- Reply claims: refusal no longer calls `retainReplyClaimFailure`; the existing ≥400 finish handler releases the claim. Claim release on 2xx moved after the verdict wait (closes a double-reply window).
- Outbox: written once with the final outcome (append-only, HMAC); `hasCanonicalReplyFor` ANY-settled predicate, legacy entries unchanged (settled).
- Canonical thread log: the outbound leg is recorded before the verdict; a refused leg reads `diverged` until the next exchange (stated limit).
- `/health` auth check extracted to `bearerMatches` — byte-identical behaviour (verified by existing /health tests).
- Existing relay-send test stubs extended with the verdict API; one assertion updated to the new honest wording.

## 6. External surfaces
`threadline_send` result gains `relayStatus`, `relayReasonCode`, `retryLater`, `banSuspected`; refusal is now `success:false` / HTTP 502. `GET /threadline/peers/health` gains `failedCount`, `unconfirmedCount`, `lastRelayStatus`, `instarVersion` (accepted small unauthenticated disclosure — the version is public on npm) and a token-checked `?scope=pool`. Authenticated `/health` gains `threadline.relayVerdicts`. New audit file `logs/a2a-delivery-verdicts.jsonl` (ids + fingerprint, no bodies; 10 MB + one rotation). Depends on relay timing only through the bounded 3 s wait.

## 7. Multi-machine posture
Unified (default). Each machine's tracker holds the rows for the sends it made (only the relay-owning machine can send); `?scope=pool` merges every machine's rows (machine-tagged, dark peer → `pool.failed`, `mixedVersion` flag). A late verdict landing on another machine is ignored there and the row falls to `unconfirmed` — honest. No user-facing notice, no state that strands on topic transfer, no generated URL.

## 8. Rollback cost
Revert the release. Older code ignores the added columns, indexes and meta table; `unconfirmed` rows go inert under older code (omitted from its state lists). One-line reverse migration restores them: `UPDATE a2a_delivery SET state='awaiting-ack' WHERE state='unconfirmed'`. No agent-state repair beyond that; the CLAUDE.md section is advisory text.

## Deviations from the spec text (recorded)
- Reason mapping: wording that matches no known prefix is `unmapped` (retryability unknown, `retryLater: null`) rather than the spec's catch-all `routing-refused`. The safer direction — a transient refusal is never misread as permanent — and consistent with the spec's own unmapped row. Three extra prefixes the relay's router really emits (`Recipient not connected`, `Sender fingerprint mismatch`, `Envelope too large`) are mapped to `routing-refused`.

## Second-pass review (round 1)
Concern raised: (1) `waitForReply:true` ran the verdict wait BEFORE registering the reply waiter (a reply landing in that window was missed); (2) the reason-mapping deviation was unrecorded; (3) `expired` accepted a frame with no `recipientId`.

Resolution: (1) the reply waiter is now registered immediately after the send, before any await, and runs concurrently with the verdict wait; a refusal cancels only this request's own waiter (identity-checked), never a retry's. Pinned by `tests/integration/threadline/relay-send-reply-wait-concurrency.test.ts` (reply during the verdict wait is captured; a retry's waiter survives a refusal). (2) recorded above. (3) `expired` now requires `recipientId === peer_fp`; a frame without one is ignored and counted (unit test added).

## Second-pass review (round 2)
Concur with the review.
