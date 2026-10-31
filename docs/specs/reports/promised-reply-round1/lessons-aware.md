# Lessons-aware review, Round 1: THREADLINE-PROMISED-REPLY-SPEC (DRAFT v2)

Reviewer: lessons-aware (8th reviewer). No files edited other than this one.
Read: the spec; reviewer template; docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md (P2, P3, P5, P7, P10, P17, P19, P20, P21, L6, L9 read in full; the rest by heading only);
code: src/threadline/autoAck.ts, relayUnknownSenderTrust.ts, refuseDowngrade.ts, client/ThreadlineClient.ts (sendAck/sendPlaintextTyped),
ListenerSessionManager.ts (hasCanonicalReplyFor, tryClaimReply), ThreadlineReapRecovery.ts, ThreadlineBootstrap.ts (plaintext receive ~L730-760),
ThreadlineEndpoints.ts (~L700-770), commands/server.ts (relay inbound handler ~L19230-19565), server/routes.ts (relay-send ~L38405-38445).
Not read: `.instar/memory/feedback_*.md` (directory not checked), the parent THREADLINE-THREAD-LEDGER-SPEC.md, CLAUDE.md, B1-B39 bodies (only headings scanned).
Not verified: Echo's "3 inbound vs 465 outbound" log counts (Echo's machine). I did verify that no `recordThreadMessage` call exists in the relay inbound handler in commands/server.ts (calls are only in routes.ts and ThreadlineEndpoints.ts), which is consistent with the claim.

## Echo's five inputs: are they addressed or only listed?

| # | Input | Status | Evidence |
|---|-------|--------|----------|
| 1 | Trust gates for `reply-notice` | LISTED ONLY | Confirmed Echo's facts: `classifyRelayPlaintextOperation` returns any non-chat string as its own operation; `resolveRelayUnknownSenderTrust` allows only `ack` for an `untrusted` sender and checks the trust table for others; `shouldRefuseDowngradedPlaintext` exempts only `'ack'` (refuseDowngrade.ts L159). Spec §3 describes the receiver behavior as settled while the "Inputs" section says it is undecided. No decision, no transport choice. See F4. |
| 2 | Untrusted peer text | PARTLY | "Fixed template from a closed set" is in §3, but the structured-fields-only wire format and receiver-side rendering exist only in the Inputs list, not the design. Nothing validates `inboundMessageId` on receipt. See F4. |
| 3 | At-most-once across a crash | LISTED ONLY, and §3 contradicts it | §3 says the obligation moves to `noticed` "only after the relay verdict comes back". A crash between send and verdict therefore re-sends. The `PromisedReply` interface has no `sending` state and no `unknown` verdict. See F5. |
| 4 | Symmetric `recordThreadMessage` | LISTED ONLY | No receive path is enumerated; there are at least four (F6). |
| 5 | Agent-awareness for `threadline_promise_close` | LISTED ONLY, in "Still owed" | See F7. |

## DESIGN-class findings

### F1: The obligation's capture point has no session identity, and the ack text is not the right key
- **Severity:** high. **Class:** DESIGN. **Index:** P20 (verify the state, not its symbol), P21.
- **Spec section:** §1 `sessionName` ("the session that held the message when the ack settled"); §1 trigger "sends DEFAULT_AUTO_ACK_MESSAGE"; §4 reason selection.
- **Code:** `RelayAckSettler.settle(outcome)` takes only a `RelayRoutingOutcome` string (autoAck.ts). Outcomes are `pipe-spawned`, `listener-delivered`, `router-delivered` (plus late settle via `deliveryPending`). `listener-delivered` (server.ts ~L19492) is a write to a warm-listener inbox read by a heartbeat reader; no session name exists there. `settleDeferredRelayAck` sends `deps.autoAckMessage ?? DEFAULT_AUTO_ACK_MESSAGE`, so an agent with a configured `threadline.autoAckMessage` sends a promising ack typed `ack` that is not `DEFAULT_AUTO_ACK_MESSAGE`. It would get no obligation.
- **Problem:** (a) `sessionName` is undefined for the listener path, and the fallback close rule (§2) and the `session-ended` / `still-working` / `restart-lost` choice (§4) both depend on it. (b) Keying on the default text silently excludes custom-ack agents; the settle result `'sent'` is the true state. (c) "SessionManager reports the session alive" is a symbol: a live tmux session is exactly the state in thread-ff759fcf (alive, silent), so `still-working` is the only reachable reason for the motivating case. That is acceptable only if stated.
- **Required resolution:** Define the capture point: record the obligation where `settle` returns `'sent'` (not on text match), and extend `settle` to carry `{ consumer: 'session'|'listener'|'pipe', sessionName? }`. For the listener consumer, specify the liveness test (heartbeat reader, not a tmux name) and the reasons it can yield. State that a rate-limited or policy-skipped ack records no obligation.

### F2: "A real reply closes it" ignores delivery outcome and names no hook point
- **Severity:** high. **Class:** DESIGN. **Index:** P20; L5; existing primitive `ListenerSessionManager.hasCanonicalReplyFor`.
- **Spec section:** §2 closing rules.
- **Code:** `hasCanonicalReplyFor` already defines "settled" on `(threadId, inReplyTo)` and deliberately excludes `outcome: 'relay-rejected'` so a refused reply stays re-drivable (comment cites a2a-honest-delivery-outcomes §4). routes.ts relay-send (L38405+) validates `inReplyTo` via `isAuthenticatedThreadlineInbound`, and `originSessionName` exists only for MCP-originated sends.
- **Problem:** As written, a reply the relay REJECTED still closes the obligation, so no notice goes out and no reply ever arrived. That is the exact silent failure the spec exists to remove. The spec also never says which outbound code path calls "close" (relay-send, `/messages/relay-agent`, the MCP tool, the cold-spawn router reply), and does not say how it relates to the existing canonical-outbox settle predicate. Two competing definitions of "replied" is a level-of-abstraction problem (L6 dim 3).
- **Required resolution:** Close only on a non-`relay-rejected` outbound; name the single funnel that closes (preferably reuse or call `hasCanonicalReplyFor` semantics) and list every outbound path that must call it, with a wiring test.

### F3: No engagement with the existing reap-recovery mechanism
- **Severity:** high. **Class:** DESIGN. **Index:** Q4 foundation audit; L6 dim 6 (interactions).
- **Spec section:** §3 `session-ended` notice; §4 reason choice.
- **Code:** `ThreadlineReapRecovery.ts` re-drives an inbound whose session was reaped and for which `hasCanonicalReplyFor` is false.
- **Problem:** The spec's `session-ended` notice ("ended without replying") can fire while reap recovery is about to answer, or fire and then be followed by the recovery reply, telling the peer something false for a reply that is already on its way. The spec does not say whether an obligation should be suspended, closed, or re-owned when recovery re-drives, nor whether recovery itself counts as the "late real reply".
- **Required resolution:** Add an interaction section: define the obligation state when recovery re-drives (suggest: obligation stays open and `session-ended` is suppressed while a recovery entry exists for that inbound), and add a test.

### F4: Transport, trust gate and sender authenticity for `reply-notice` are undecided
- **Severity:** high. **Class:** DESIGN. **Index:** P2 (signal vs authority), L15 (trust-aware surface), Q4 (type predicate that outruns its runtime test).
- **Spec section:** §3 "new wire type, `type: 'reply-notice'`"; Inputs 1, 2.
- **Code:** `sendPlaintextTyped` sends every non-`chat` type as plaintext (`sendInviteControlPlaintext` and `sendAck` use it). Plaintext attribution is "the relay's word" (refuseDowngrade.ts doc). An invite peer with the `encryptedSeen` mark has plaintext refused as a downgrade unless the type is `ack`. An `untrusted` sender is allowed only `ack`. There is already an encrypted precedent: `relayClient.sendNoticeToPinned` (ThreadlineBootstrap ~L747).
- **Problem:** Until decided, the notice is dropped (trust gate), or refused (downgrade), for exactly the peers the spec most wants to reach, and in dry-run nobody would see it. Because plaintext attribution is unauthenticated, any relay-level party can forge a `reply-notice`, which the spec stores in canonical history and shows on `/threadline/peers`. The receiver is never told to check that `inboundMessageId` names a message WE sent on that thread.
- **Required resolution:** Decide and write into the design (not the Inputs list): (1) send encrypted-to-pinned when a pin exists, as `sendNoticeToPinned` does, else plaintext; (2) the trust-table operation name and which levels allow it; (3) the downgrade exemption (or not); (4) receiver validation that `(threadId, inboundMessageId)` is an outbound of ours, else drop and count; (5) the test that an older peer treats an unknown type as content (Echo's request) with the actual older-receiver code path.

### F5: The at-most-once guarantee is false as written
- **Severity:** high. **Class:** DESIGN. **Index:** P19 (brakes), P20 (unknown fails toward least harm).
- **Spec section:** §3 "Delivery is at most once"; §1 interface; Inputs 3.
- **Problem:** The write order in §3 is send, then record verdict, then `noticed`. A crash after send and before the verdict leaves `open`, and the next startup sweep re-sends. That makes "at most once" untrue, and "No second notice is ever sent" untrue. The interface lacks `sending` and the `unknown` verdict.
- **Required resolution:** Write the `sending` mark BEFORE the send, treat `sending`-without-verdict at startup as `noticed` with verdict `unknown` (never re-send), add both to the interface, and add the crash test (kill between mark and verdict).

### F6: "Symmetric on both ends, on every path" is not enumerated, and the main receive path records nothing today
- **Severity:** high. **Class:** DESIGN. **Index:** Parent D-B funnel; L5.
- **Spec section:** §3 "kept and readable"; Inputs 4; test 7.
- **Code:** Inbound `type: 'ack'` is consumed and returned in four places before any recording: server.ts relay handler (`ack-consumed`, ~L19298), ThreadlineEndpoints (`isAutoAckBody`, ~L738), plus the plaintext unknown-sender path in ThreadlineBootstrap and `/messages/relay-agent`. server.ts's relay handler has no `recordThreadMessage` call at all.
- **Problem:** The new receive case must be added at each, and each must call `recordThreadMessage` itself. The sender must also record the notice as an outbound through the funnel, or the sender's own history shows nothing it sent. The spec asserts "(both halves asserted)" in test 7 for one path only.
- **Required resolution:** List the receive paths explicitly, put the notice case before the ack stage in each, give the sender-side outbound record, and test each path (a wiring-integrity test like the existing `recordInboundAck` one).

### F7: Agent awareness, migration parity and supervision are deferred with no owner or ETA
- **Severity:** high. **Class:** DESIGN. **Index:** P3, P5, P7, P10, L9.
- **Spec section:** "Still owed"; Inputs 5; §6 config key `threadline.promisedReply.enabled`.
- **Problem:** P3 forbids "the migration is a later PR"; P5 requires the CLAUDE.md template text in the same PR; P10 requires a `principal-deferral-approval` for a deferral. The change adds a new MCP tool (`threadline_promise_close`) that needs a route, a registration in `ThreadlineMCPServer.ts`, a PostUpdateMigrator section (existing threadline sections are at PostUpdateMigrator.ts ~L9330, L9428, L9681), a config-default migration, and an update to the warm-session prompts that today tell the session only to reply with `inReplyTo` (ListenerSessionManager.ts ~L706; ThreadlineRouter.ts ~L221, L248). Without the prompt text, no session ever calls `promise_close`, and every deliberate no-reply produces a notice (a false-positive source). The new timer/sweep is a pipeline and needs a P7 `supervision` declaration.
- **Required resolution:** Move all of these into the design with the file list, add `lessons-engaged:` frontmatter, or add a `principal-deferral-approval` with ETA/owner for anything truly deferred.

### F8: The timer and startup sweep carry no declared brakes or burst bound
- **Severity:** medium. **Class:** DESIGN. **Index:** P19, P17, P7.
- **Spec section:** §3 "at T = 30 min", §4 "On startup".
- **Problem:** The mechanism is unspecified (per-obligation timer vs periodic sweep, interval, per-tick cost). "No retry on any verdict" covers the send, not the scan loop. The per-peer-per-hour cap is in §4, but there is no per-agent global ceiling and no burst test (P17 requires a 1,000-obligation burst proof). Test 13 covers one peer only. A peer outage that rejects every notice still scans and logs every tick.
- **Required resolution:** State the scheduler shape and cost per tick, a global per-hour ceiling, a sustained-failure test (permanently rejecting relay), a burst test across many peers, and the `supervision` tier.

### F9: Ownership/handover model can send a false notice and justifies machine-local state only by assertion
- **Severity:** medium. **Class:** DESIGN. **Index:** P21.
- **Spec section:** §4 "Which machine owns the timer", "Handover".
- **Problem:** The owner is the machine that sent the ack; the store is "JSONL beside the thread log" (machine-local, no justification from the closed taxonomy). If another machine of the agent becomes thread holder and sends the real reply, the owner's store never sees that outbound, so the owner sends `still-working` for a message already answered. The handover paragraph covers "owner goes away", not "owner still up, reply sent elsewhere". "No notice if not replicated" does not protect against this case.
- **Required resolution:** State the posture (unified / proxied-on-read / machine-local with justification). Either close obligations on mesh-observed outbound for the thread, or have the owner check the thread's canonical history (not just its own outbox) before noticing. Add a test.

## PRECISION-class findings (left behind)

### F10: Test 5 conflicts with §4 and test 14
Test 5 expects `restart-lost` after a restart with an open obligation; §4 says `restart-lost` only if the session is also gone, and test 14 says a surviving session gives `still-working`. Test 5 needs "and the session is gone".

### F11: Older-peer bound is stated more narrowly than the real cost
"The exchange ends after at most one round" is true for the auto-ack only. An older receiver treats an unknown type as content and may spend a session and send a real reply, which our side handles as ordinary inbound. The honest-bound paragraph should say each notice may cost an older peer one session, and that is accepted.

### F12: Frontmatter and process artifacts
No `lessons-engaged:` entry (the status line concedes spec-converge and ELI16 are owed, L9); no seven-dimension side-effects mapping (L6); the status text should be updated when the design absorbs the Inputs list.

### F13: Unverified evidence figure
The 3-vs-465 inbound/outbound count is Echo's measurement on a machine I cannot read; cite it as Echo's report, which the spec already does.

SUMMARY: 0 critical, 7 high, 2 medium, 0 low DESIGN findings (F1-F9); 4 PRECISION findings (F10-F13). Convergence-blocking: Y.
