# Round 1 cross-model review: THREADLINE-PROMISED-REPLY-SPEC (DRAFT v2)

Reviewer note: no non-Claude CLI was available, so this is a fresh independent second read using the cross-model template. Every code claim below was checked against /Users/dawn/Projects/instar-wt-ledger/src in this session. No files were edited.

**Verdict: SERIOUS ISSUES** (6 DESIGN, 4 PRECISION)

## Echo's five inputs: are they addressed?

All five are listed under "Inputs for spec-converge" and none is folded into the design body, the state enum, or the tests. Echo's input 1 (trust gate) is confirmed real by the code. Details in D1 and D2.

## DESIGN findings

### D1. Trust gate and downgrade refusal are unresolved, and the send path would trip both (sections 3, input 1)
- `resolveRelayUnknownSenderTrust` (src/threadline/relayUnknownSenderTrust.ts) exempts only operation `ack`. Any other type is looked up in the trust table. An `untrusted` sender is always denied. So `reply-notice` is dropped for unknown or untrusted peers under enforcement.
- `shouldRefuseDowngradedPlaintext` (src/threadline/refuseDowngrade.ts:159) exempts only `ack`. A plaintext `reply-notice` to an encryption-paired peer is refused as a downgrade.
- On the sending side, `ThreadlineClient.sendPlaintextTyped` re-routes only `type === 'chat'` to the pinned key. Every other type goes out as plaintext. So the notice would be plaintext by default.
- `sendNoticeToPinned` is encrypted, but it carries no `type`, so the receiver could not tell a notice from chat.
- Resolution: decide explicitly. Either add `reply-notice` to the ack-style exemptions in both gates, or send it encrypted with a typed control op (as `sendInviteControlToKey` does). Add tests for both gates.

### D2. Echo inputs 2, 3, 4 and 5 change the design but are not in it (sections 3, 4, state enum, Tests)
- The obligation state machine has no `sending` mark and no `unknown` verdict. A crash between send and verdict can re-send, which breaks the stated at-most-once. No test covers it.
- Section 3 says the notice carries a text template. Input 2 requires structured fields only (reason code, times, `inboundMessageId`), with the receiver rendering the text. That changes the wire format.
- Input 4 requires the outbound notice to go through `recordThreadMessage` (src/threadline/recordThreadMessage.ts) on the sending end as well. The body of section 3 only mentions the inbound append.
- Input 5: `threadline_promise_close` does not exist in ThreadlineMCPServer.ts. The tool, its HTTP route, the awareness text, and the PostUpdateMigrator and scaffold/templates parity are all new build items. They are listed as "still owed" but they are scope.
- Resolution: move each input into the design and the Tests list, and add the missing state.

### D3. Closing on `inReplyTo` fails for forwarded sends, and no closure hook point is named (section 2, section 4)
- src/threadline/relayForward.ts:341 says `inReplyTo` and `originSessionName` are NEVER sent on a forwarded send. A reply sent from a standby machine reaches the relay holder's route with neither field. Neither the primary rule nor the same-session fallback can match. The holder then sends a false `still-working` notice for a reply that was sent.
- The spec says "outbound reply" but names no hook. Replies leave through several paths: the relay-send route (routes.ts around 38378), the MCP `threadline_send`, and the listener outbox.
- Reusable primitive: `ListenerSessionManager.hasCanonicalReplyFor(threadId, inboundMessageId)` already answers "was this inbound settled", and it excludes `relay-rejected`. Re-checking it when the timer fires removes the need to hook every outbound path.
- Resolution: choose a single closure check at timer-fire time, and say how a forwarded reply is seen (carry `inReplyTo` in the forward, or check the shared outbox).

### D4. The ack-settlement point cannot supply the recorded fields, and some promising acks are not covered (sections 1, 4)
- `createRelayAckSettler.settle` takes only a `RelayRoutingOutcome` enum (src/threadline/autoAck.ts). It carries no `sessionName`, no inbound message id, and no machine. The spec's `sessionName: the session that held the message when the ack settled` needs new plumbing from every routing branch.
- `pipe-spawned` sessions are one-shot, so `session-ended` is the expected state for them. The spec does not say what the reason selection does there.
- The non-deferred path (autoAck.ts:157, `!input.deferSend`) sends the promising ack with no delivery knowledge. The spec does not say whether an obligation is recorded there.
- The trigger is "sends `DEFAULT_AUTO_ACK_MESSAGE`", but the code sends `deps.autoAckMessage ?? DEFAULT_AUTO_ACK_MESSAGE`. A configured custom ack is also a promise and would get no obligation.
- Resolution: define the obligation trigger as "a promising ack was sent" (not the constant), and specify what each routing branch passes.

### D5. The notice receive path has side effects the spec does not account for, and its surface does not exist (section 3)
- The relay receive handler (src/commands/server.ts around 19238 to 19340) writes the canonical inbox entry, calls `recordRelayDelivery()` (a reply on the thread counts as a processed-ack of our prior send), and mirrors to the Telegram bridge. If the notice is appended as an ordinary inbound, it would mark our pending sends as acked, set `lastInboundAt` (A2ADeliveryTracker.ts:693), and clear `stale` and `dark` on that peer. A notice that says "no reply yet" would make the peer look alive and acknowledged.
- The spec says the notice is shown on `/threadline/peers`. That route does not exist. The real routes are `/threadline/peers/health` and `/threadline/peers/:fp/health`, with a fixed row shape and no place for a notice.
- Resolution: a distinct record kind that is excluded from liveness and ack accounting, an explicit list of receive-handler calls to skip, and a named new field on the health rows.

### D6. The older-peer bound is understated (section 3, Tests 8)
- The spec says an older peer "may answer with one auto-ack and possibly start one session", and the exchange ends after one round because our side ignores the ack.
- autoAck.ts (the ACT-091 comment) states that a peer from before the wire type routes any non-ack message to a session. The older peer's session would write a real reply to the notice. That reply is an ordinary message and is not recognised by `isAutoAckInbound`, so our side routes it to a session as well.
- Test 8 only covers the auto-ack branch.
- Resolution: gate the notice on peer capability (a peer that does not advertise `reply-notice` gets no notice), or state the real bound and add a test for the session-reply branch.

## PRECISION findings (left behind)

- P1. The problem statement says relay inbounds "do not reliably reach" the log. The code appends every relay inbound to the canonical inbox (`appendCanonicalInboxEntry`), and `isAuthenticatedThreadlineInbound` accepts the union of inbox and thread log. Narrow the wording to "the per-thread log", and note that Test 9 therefore passes through the inbox leg.
- P2. Relationship to existing machinery is not stated: HONEST-PROGRESS-MESSAGING-SPEC section B2 (listed under builds-on), `peerDarkNotice`, and the caller-side alternative (the asking side already knows an ack arrived and no reply followed, with no wire change). One short "alternatives considered" paragraph would answer why the receiver pushes a notice.
- P3. T (30 min), the 24h ceiling, the one-notice-per-peer-per-hour cap, and the 7-day prune interact; a worked timeline would remove ambiguity (for example, what happens to an obligation at 23h with the hourly cap in effect).
- P4. Status line says "DRAFT v2" and "ELI16 owed"; the document also refers to Echo's evidence (3 inbound vs 465 outbound) that this review could not verify.

## Not verified
- Issue and PR references (#2117, #2149, #2174, #2176) and the Echo log counts.
- Exact semantics of `PromiseBeacon` (found by file name only).
