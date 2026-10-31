# Adversarial review, round 1: THREADLINE-PROMISED-REPLY-SPEC (v2)

Verdict: SERIOUS ISSUES (10 DESIGN, 4 PRECISION). Checked against src/threadline/autoAck.ts, relayUnknownSenderTrust.ts, refuseDowngrade.ts, client/ThreadlineClient.ts, ThreadlineBootstrap.ts, ThreadlineReplyValidation.ts, and src/server/routes.ts (relay-send, ~38378-38450). Nothing edited.

## Echo's five inputs: listed, not addressed
The "Inputs for spec-converge" section says "must be settled" but §§1-6 and the Tests do not settle any of them. Detail in D1, D2, D3, D4, D9.

## DESIGN

**D1. Trust-gate and downgrade handling for `reply-notice` is undecided, and the obvious fix opens a hole (Echo #1).**
- `classifyRelayPlaintextOperation` returns any non-chat string as its own operation. `resolveRelayUnknownSenderTrust` allows only `ack` for every level (ACK_OP), so `reply-notice` is checked against the level table. Untrusted is always refused.
- `shouldRefuseDowngradedPlaintext` exempts only `=== 'ack'` (refuseDowngrade.ts:159). A notice to an invite peer with an encryptedSeen mark is refused, and that refusal emits a "loud refusal" notice back.
- `sendPlaintextTyped` only upgrades `type === 'chat'` to encrypted-to-pinned. A `reply-notice` goes out via `sendPlaintextRaw` in the clear, so the relay can read it, and it is relay-spoofable for invite peers.
- If the fix is "treat it like ACK_OP", then any sender at any level can write into our thread history (see D2).
- Resolve: decide the allowed-level table, whether it is encrypted to the pinned key when one exists, and whether it is exempt from refuseDowngrade. Add tests for each.

**D2. Forged-notice poisoning (bad-input, provenance).**
The spec stores the notice as an inbound entry in canonical history and on peer health, but defines no receiver-side validation. A peer, or a relay-forged plaintext, can name any `threadId`/`inboundMessageId`.
- Needed: the receiver accepts only if (a) the thread exists with that exact peer fingerprint, (b) `inboundMessageId` is a message WE sent on that thread, (c) times parse as ISO and sit in a sane window, (d) `reason` is in the closed set. Also needed: a per-peer cap on stored notices.
- Wire format is undefined. `encodePlaintextPayload` carries only `{text,type,resend}`, and `decodePlaintextPayload` falls back to `JSON.stringify(parsed)` for non-text objects. Specify the structured body and a strict parse that drops any free text (Echo #2).

**D3. "At most once" contradicts the described order, and the crash case is not in the body (Echo #3).**
§3 moves to `noticed` only AFTER the verdict. A crash between send and verdict leaves the row `open`, so startup re-sends it, which is duplicate delivery. Specify a `sending` mark written before the send. A `sending` row without a verdict on startup becomes verdict `unknown` and is never re-sent. Add a test (the current list has none).

**D4. `inReplyTo` close path conflicts with route validation.**
- relay-send (routes.ts:38430) returns 400 unless `isAuthenticatedThreadlineInbound` finds the inbound in the listener inbox or the ThreadLog.
- The spec itself says relay inbounds are mostly absent from canonical logs. If so, a session that passes the correct `inReplyTo` for the acked relay message gets a 400 and the reply never goes out.
- Test 9 ("inbound absent from log: closes on inReplyTo") is therefore not reachable through this route. Either the spec fixes the receive-side recording first (a prerequisite), or the close key cannot be `inReplyTo` for relay inbounds.
- Warm-bound replies must equal `readLatestCanonicalInboxForThread`, which is the latest inbound, not necessarily the acked one.

**D5. The session-based fallback close and reason logic rest on data that does not exist.**
- `createRelayAckSettler.settle(outcome)` receives only an outcome enum. No session name reaches the ack settlement, so `sessionName` in §1 has no source. The outcomes include `pipe-spawned` and `listener-delivered`, whose session identity is not in that call.
- relay-send sets `replyClaimOwner = originSessionName` or `relay-send:<uuid>`, so many outbounds carry no session name at all.
- A reply from a different session (warm pool successor, user-facing session) never closes the obligation, and a false "no reply yet" notice goes out after a reply was sent.
- A same-session message on another subject can close wrongly (silently, the failure mode this spec exists to remove).
- Resolve: name the real source of session identity at settle time, and decide what counts as a reply for closing (suggest: any outbound non-ack to that peer on that thread after `ackedAt`, with `inReplyTo` as a stronger match).

**D6. Deliberate close with no peer signal recreates gap H.**
The peer was told "Composing response..." (a promise). A session closes with `threadline_promise_close` and the peer sees nothing. That is the same lying-ack symptom the spec set out to fix. At minimum send a `reply-notice` with reason `no-reply-needed` (structured, no free text), or state why silence is acceptable.

**D7. `threadline_promise_close` authority is unspecified.**
No route, MCP tool or auth exists today (grep: none in ThreadlineMCPServer.ts). Any session could close any obligation, silently cancelling someone else's notice (authority ambiguity). Bind it to the owning `sessionName` or an operator token. The caller-supplied `reason` must be from a closed set or length-capped, since it is stored.

**D8. `/threadline/peers` does not exist (factually wrong).**
The surface is `GET /threadline/peers/health` (PostUpdateMigrator.ts ~9315). §3, §5 and test 7 cite the wrong path, and that health payload has no field for notices. Specify the new field.

**D9. Symmetry and awareness are listed but not designed (Echo #4, #5).**
- The spec never enumerates the receive paths. Relay inbounds flow via ThreadlineBootstrap `gate-passed` to server.ts, plus the local-route and listener paths. It never says the sender records its own outbound notice through `recordThreadMessage`.
- `threadline_promise_close` is not in the warm-session prompt or in PostUpdateMigrator-seeded agent awareness. State the parity work as a deliverable with a test, not a footnote.

**D10. Collapse and mixed-reason logic is unspecified.**
"Several open obligations on one thread" are folded into one notice with one reason field, but their reasons can differ (one session dead, one alive). A single `still-working` or `session-ended` would be false for some. Define per-time reasons or take the weakest honest claim. (Could be PRECISION if the wire carries per-time reasons; as written it changes behaviour.)

## PRECISION
- P1. §4 handover: "adopts open obligations only if the store is shared" never says how a holder change is detected, or what logs the miss (test 10 asserts a local log line only).
- P2. A wedged but alive session yields `still-working` indefinitely. "One may still follow" is honest, but state that no escalation follows.
- P3. T=30 min vs the 24h ceiling and the one-per-peer-per-hour cap: say what happens to an obligation that is `open` at the cap (folds into the next notice or expires at 24h; state both outcomes in one sentence).
- P4. Cross-machine forwarded sends (`forwardedFromMachine`): unverified whether a reply sent from another machine's session is observed by the owner machine's close hook. Confirm during D5.
