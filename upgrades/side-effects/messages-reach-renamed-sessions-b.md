# Side-effects review: cross-machine session messages that deliver (PR-B, phase 1)

## Summary

This builds §D of `docs/specs/messages-reach-renamed-sessions.md` (converged, approved by the Chief of Staff 2026-11-18) on top of PR 3422. Same-agent messages to a session on another machine have never been delivered: the sender posted to a path that returns 404 (since 2026-08), and the receiver only stored relayed messages, never typed them.

**Sender side**
- **One queue per target machine.** One request at a time, and one pass over the machine's guarded addresses (`CrossMachineRelayQueue`).
- **Each attempt is re-signed** with a fresh timestamp and the message's `age`. `age` is signed only when present, so older envelopes still verify.
- **Only a verified answer ends the pass early.** A `relay-ack-v1` from the target means `received`; a `relay-nack-v1` means `failed` with its code. Any other answer moves on to the next address.

**Receiver side**
- **Arrival checks.** The receiver checks `to.machine`, `from.agent`, and that `from.machine` matches the signer, `relayChain[0]` and the request signer.
- **Order.** It verifies the signature before answering a duplicate, and refuses an expired envelope.
- **Storing.** It stores by a single temp-file-then-`link()` step (`saveIfAbsent`), acknowledges with a signed answer, then types through A and B with `asOf = arrival − age − 2W`.

**Failure path**
- A failure on the receiver goes back to the origin as a signed `delivery-notice`. The origin accepts it only for a message it sent to that signer, then moves its envelope to `failed` and tells the sender.
- At boot, a stored-but-unfinished relayed message is typed if typing never started. If typing had started, it is reported as `outcome unknown` and never retyped.

**Other changes**
- The legacy path is a permanent machine-auth alias, and the stale bearer exemption is removed.
- Session messages are no longer written to the undrained outbound folder.

Tier 2. About 900 LOC including tests, built in one pass after the spec. Phase 2 (retries for a machine that is away, automatic re-send to a moved topic) is tracked under CMT-1940.

## 1. Over-block

- **A message older than a session.** One written within 10 minutes before the target session started may be refused, because of the 2W clock margin. The sender is told and can resend.
- **Older senders whose caller wrote a wrong `from.machine`** are refused with `relay-sender-mismatch`. They fall back to their own outbound folder, as they do today.
- **A machine that is asleep** gets one pass. The sender is told "not reachable now (resend later)" rather than waited for. That is phase 1 by design.

## 2. Under-block

A paired machine with a valid key can still relay any text into this agent's sessions. That is unchanged: it is this agent's own machine, holding its own key.

## 3. Level-of-abstraction fit

The relay is the one cross-machine path for same-agent session messages, and delivery reuses the same `deliverSameAgentLocal` as local sends. Addresses come from the mesh's own resolver and credential guard.

## 4. Signal vs authority

The new refusals sit on the receiver's arrival checks. They refuse only envelopes that claim to come from a machine or agent other than the one that signed them, or that are expired. Those are deterministic identity floors, not judgment. Retries and notices are signals. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

- **The retry manager** skips `relaying` envelopes and keeps origin `received` copies open until the notice TTL.
- **`relay()`** is unchanged for the same-machine agent path. The machine path now uses `relayFromMachine`.
- **Git-sync pickup** (inert today) is not given the clock check, so messages arriving by it are stored but never typed.
- **The legacy alias** is mounted with the machine routes, before bearer auth, so removing the middleware exemption only turns a 404 into a 401 for unsigned callers.

## 6. External surfaces

- **New delivery phase** `relaying`.
- **New signed fields:** `transport.age` (signed when present) and the relay ack/nack JSON on the relay route, which now answers 200 `{ok, ack, sig}` or 409 `{code, nack, sig}`.
- **`GET /messages/:id`** shows `deliveryPending`, `arrivedAt` and `asOf` on the receiver.
- **The awareness entry** explains `relaying` and "resend later".

## 7. Multi-machine posture

- **Relay (§D): unified.** It reads the replicated machine registry and the mesh's guarded ropes.
- **Notices back to the origin: proxied.** They travel as a signed relay to the signer machine.
- **Local typing: proxied.** It happens on the machine that holds the session.

## 8. Rollback cost

Revert this PR. Envelopes left `relaying` are dead-lettered at their TTL by the old sweep. Older receivers ignore the new fields. No migration.

## Second-pass review

(appended below)

The independent second-pass reviewer (2026-11-18 06:55 PT) raised two concerns. Both are fixed and tested.

1. **A message still `relaying` lost its relay chain on disk across a restart, and would then be refused.** Fixed: `relayChain` is set on every re-sign and persisted before the phase write.
2. **Boot recovery could retype, or falsely fail, a message the retry manager had already delivered.** Fixed: recovery acts only on `received` envelopes, and `deliveryPending` is cleared once the phase moves on.

A re-check of the fixes follows below.
Re-check (06:58 PT): "Concur with the review. Both fixes hold."

## Fix 2026-11-18 09:15: silent-fallback guard

The no-silent-fallbacks ratchet counted 496 against 494. Two deliberate best-effort catches were marked `@silent-fallback-ok` with their reason: the sender-notice failure handler (the failure is already on the envelope) and the topic-registry read in SessionManager, whose block the guard now reads differently after the added registry cache. Comments only; no behaviour change.

## Follow-up: wiring test expected text (2026-11-18, after the M5 e2e lane)

The e2e wiring test `messages-reach-renamed-sessions-wiring.test.ts` still expected the retry manager's `onDeadLetter` to call the sender notifier directly. Since phase 1, dead letters go through `messageRouter.reportTerminalFailure`. That call sends a remote-origin failure back to its machine as a signed notice, and hands a local one to `onDeliveryFailure`, which is still the sender notifier (asserted in the same test case). The test now expects the router call. Test-only change. There is no runtime surface, so over-block, under-block, interactions, multi-machine posture and rollback are unchanged from the section above.
