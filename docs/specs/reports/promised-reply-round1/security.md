# Round 1 — security review: THREADLINE-PROMISED-REPLY-SPEC (DRAFT v2)

Verdict: SERIOUS ISSUES (9 DESIGN, 5 PRECISION). Code claims checked against /Users/dawn/Projects/instar-wt-ledger/src.
Echo's five inputs are LISTED at the end of the spec but only partly addressed in the body; status per input is in the last section.

## DESIGN findings

### D1. Trust-gate and downgrade handling of `reply-notice` is undecided, and the send path contradicts the spec's own goal
Observed: `classifyRelayPlaintextOperation` (relayUnknownSenderTrust.ts:54) returns any non-chat string as the operation name. `resolveRelayUnknownSenderTrust` allows only `ack` unconditionally, `untrusted` denies everything else, and other levels allow only what `getAllowedOperationsByFingerprint` lists (DEFAULT_ALLOWED_OPS, AgentTrustManager.ts:251). `shouldRefuseDowngradedPlaintext` exempts only `'ack'` (refuseDowngrade.ts:159). `sendPlaintextTyped` (ThreadlineClient.ts:~500) encrypts to the pin ONLY for `type==='chat'`; every other type goes out as plaintext via `sendPlaintextRaw`.
Consequence: a notice to a pinned invite peer goes plaintext, is relay-forgeable/alterable, and is refused as a downgrade once that peer has an `encryptedSeenAt` mark. To an untrusted/low-level peer it is dropped. The spec must decide, not defer.
Resolution: pin the decision in the spec. Recommended: pinned peers get the notice via `sendToPinned` (encrypted, like `sendNoticeToPinned`, ThreadlineClient.ts:629); unpinned peers get plaintext; add `reply-notice` to the allowed-ops table for verified+ and exempt it in `shouldRefuseDowngradedPlaintext` ONLY for the plaintext case. Add tests for each (trust level x pinned/unpinned x enforce/watch).

### D2. Wire format is undefined; §3 and §5 contradict each other; plaintext wire cannot carry structure
Observed: the plaintext payload is `{text, type, resend}` only (`encodePlaintextPayload`/`decodePlaintextPayload`, autoAck.ts). The unknown-sender decoder drops any other field. §3 says "receiver renders the template itself" (Echo input 2) but §5 says an older peer sees "ordinary message content", which requires a sender-rendered text.
Consequence: either (a) the notice is rendered text and the receiver stores peer-authored text (the thing input 2 forbids), or (b) the plaintext wire is extended with `reason`, times and `inboundMessageId` and the decoder/validator is changed (an unlisted change to a shared parser).
Resolution: specify the payload (`reason` enum, ISO times, `inboundMessageId` checked with `isValidMessageId`, fixed size caps), send BOTH a fixed fallback text (for older peers) and the structured fields, and have a current receiver ignore the text and render from the validated enum. Reject unknown `reason` and malformed times (store nothing). Test it.

### D3. "Close on matching `inReplyTo`" is unreachable in exactly the case the spec says it must work (test 9)
Observed: `/threadline/relay-send` rejects any `inReplyTo` that `isAuthenticatedThreadlineInbound` cannot find in the HMAC inbox or the thread log with HTTP 400 (routes.ts:38430-38437). The spec states relay inbounds are mostly absent from the canonical log. A session replying with the real inbound id therefore gets a 400 and the reply is not sent; one replying without it falls to the fuzzy fallback.
Also: the inbox entry id is `opts.messageId || crypto.randomUUID()` (ListenerSessionManager.ts:207/253), so for an UNKEYED inbound the id a session can cite differs from anything the ack stage captured.
Consequence: test 9 as written cannot pass; the primary close path degrades to the single-open-obligation heuristic, which can close the wrong obligation or leave false notices.
Resolution: state the real dependency (the symmetry fix lands first, or the ack stage records the inbound through the funnel at settle time), define the id the obligation stores when the envelope has none, and rewrite test 9 to what is actually reachable.

### D4. Obligation identity is a bare peer-chosen message id
Observed: `inboundMessageId` is chosen by the sender. The inbound ledger keys on (senderKey, messageId) (InboundIdLedger.ts:593/658), but the obligation model, `threadline_promise_close { inboundMessageId }` and the existing reply claim (`tryClaimReply(inboundMessageId, owner)`) are keyed on the id alone. Unkeyed messages (messageId undefined, ThreadlineBootstrap.ts unknown-sender path) have none at all.
Consequence: peer B can send a message reusing peer A's open id, closing/aliasing A's obligation (so A gets no notice), or an `inReplyTo` meant for one peer matches another. `inboundMessageId: string` is not satisfiable for unkeyed messages.
Resolution: key obligations on (peer fingerprint, threadId, messageId); state what happens for unkeyed inbounds (recommend: synthesise a local id at ack time and use thread+session fallback only); validate with `isValidMessageId` at every edge including the close tool.

### D5. At-most-once across a crash is not designed in the body (Echo input 3)
Observed: §3 moves to `noticed` "only after the relay verdict comes back". That is the exact window: crash after the send but before the verdict write re-sends on startup. "There is no retry on any verdict" does not cover a crash.
Resolution: write a `sending` mark (fsync'd) BEFORE the send; on startup a `sending` row with no verdict becomes `noticed` with verdict `unknown` and is never re-sent. Add the state to the interface and a crash-injection test (the spec's test list has none).

### D6. Receive-side handling is not specified per ingress, including the reply-waiter hole (Echo inputs 1/4)
Observed: there are four ingresses (`INBOUND_INGRESSES`: relay, relay-unknown-sender, threadline-http, relay-agent). Acks are consumed separately at ThreadlineEndpoints.ts:738, routes.ts:37118 (relay-agent: "not stored, not routed") and commands/server.ts:19238-19297. A `reply-notice` is not matched by `isAutoAckInbound`, and its text does not start with "Message received.", so server.ts:19262-19268 would `waiter.resolve(textContent)` and deliver the notice to a `waitForReply` caller AS THE REPLY, then fall through to the warrants gate and routing (session spawn).
Resolution: specify one shared `isReplyNotice` predicate (type-based only, like `ack`) consulted before the waiter check, the ack stage, the inbox append and the router in all four ingresses; each calls `recordThreadMessage` itself; the sender records the outbound notice through the funnel too. Add a per-ingress test and a "waitForReply stays waiting" test (the spec states the behaviour, the test list does not assert it).

### D7. `/threadline/peers` does not exist; the health surface has no place to show a notice
Observed: routes are `/threadline/peers/health` and `/threadline/peers/:fp/health` (routes.ts:19184/19265), backed by `a2aDeliveryTracker.allPeerHealth`, which models delivery, not received prose.
Resolution: name the real surface and add the field (for example `lastReplyNotice { reason, at, inboundMessageId }`, structured, capped); say how it is bound to the verified fingerprint so a spoofed plaintext notice (see D1) is labelled unverified and cannot overwrite a verified one.

### D8. Unbounded growth and fan-out
Observed: acks are sent for any non-`untrusted` sender, and first-contact profiles are created at `verified` unless `relayUnknownSenderTrust` enforces (relayUnknownSenderTrust.ts, "level a NEW fingerprint profile is created at"). The only per-peer cap is notices per hour (§4); fingerprints are free to mint.
Consequence: an attacker rotating fingerprints grows the open-obligation store (24h ceiling, no count cap) and, at T, forces one outbound notice per fingerprint (and, to older peers, one spawned session each).
Resolution: add global and per-peer caps on OPEN rows (drop oldest, log), a global notices-per-hour cap, no obligation for peers below a set trust level, and file mode 0600 for the store.

### D9. `sessionName` capture and `threadline_promise_close` authorization are unsupported / unspecified (Echo input 5 partly)
Observed: the ack settler's outcome is a bare enum (`RelayRoutingOutcome`, autoAck.ts:228); it carries no session name, and `listener-delivered` has no single owning session. The spec says the obligation records "the session that held the message when the ack settled" and bases the fallback close and the `session-ended` reason on it.
The close tool takes only `{inboundMessageId, reason}`; nothing says it must come from the owning session. Any session (including a prompt-injected one) can silently close anyone's obligation, suppressing the notice.
Resolution: add `sessionName` to the settle outcome for each path (or state it is unknown for warm-listener and degrade to `still-working`); bind close to the caller's session (`INSTAR_SESSION_NAME`, as `mcp-http-client.ts` already sends) and record who closed it; write the agent-awareness text and the warm-session prompt text in the spec (input 5 is still only listed).

## PRECISION findings
- P1. Store file permissions and inclusion in backups/support bundles are not stated (0600, same exclusion as the thread logs). Folded into D8's fix if accepted.
- P2. "Older peers" bound ("at most one round") rests on the older peer's ack being typed or exact text; an older peer with a custom `autoAckMessage` is not recognised by `isAutoAckInbound` (autoAck.ts:41-46) and reaches the warrants gate. Say so.
- P3. `peer` recorded as "relay address if unverified" should be labelled in the stored row as unverified so logs and the health surface do not present it as an identity.
- P4. `T` is "configurable per agent" with no min/max; a 0 or tiny value turns the feature into a notice on every message. State bounds.
- P5. Times in the notice are rendered "HH:MM UTC" with no date; a notice for an obligation over 24h old (collapse listing) is ambiguous. Include the date for non-same-day entries.

## Echo's five inputs: actually addressed?
1. Trust gates: NOT addressed (listed only); see D1, D6.
2. Untrusted text: PARTLY (closed reason set stated) but contradicted by §5 and unimplementable on the plaintext wire; see D2.
3. At-most-once across crash: NOT addressed; §3 as written has the re-send window; see D5.
4. Symmetry: NOT addressed beyond the sentence; see D3, D6.
5. Agent awareness: NOT addressed; see D9.
