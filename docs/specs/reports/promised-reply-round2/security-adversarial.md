# Round 2 — security + adversarial review: THREADLINE-PROMISED-REPLY-SPEC (v3)

Lenses: security, adversarial. Spec read in full (268 lines). Round-1 reports read in full. Code was NOT re-audited except two greps (sendInviteControlToKey exists at ThreadlineClient.ts:659; INBOUND_INGRESSES has 4 entries, InboundIdLedger.ts:36). Where a verdict depends on code behaviour the spec only asserts, it is marked "asserted".

Result: 3 round-1 findings unsettled (S-D4, S-D9 partial, adv-P ties), 3 new DESIGN, verdict NOT CONVERGED. Detail below.

## A. Round-1 SECURITY findings

| # | Status | Evidence |
|---|---|---|
| D1 trust gate / downgrade | SETTLED | Decisions 6 (encrypted to pin, so refuseDowngrade needs no exemption) and 7 (own op, verified/trusted/invite; untrusted and unknown-under-enforcement refused), test 18. |
| D2 wire format, text vs structure | SETTLED (one inconsistency, see N5) | Decision 4: structured `notice`, strict parse, closed `reason`, receiver renders from `notice`, ignores `text`. |
| D3 inReplyTo vs relay-send 400, unkeyed id | MOSTLY SETTLED | Decision 2 (canonical inbox id; UUID when unkeyed), decision 3 rule 2 (any non-ack outbound closes, so a 400 on inReplyTo no longer strands the close), test 10. Residual: lines 124-125 assert the recorded id passes `isAuthenticatedThreadlineInbound`; not shown, and the spec never says how a session learns a server-generated UUID for an unkeyed inbound. Rule 2 covers it. MINOR. |
| D4 obligation identity is a peer-chosen id | NOT SETTLED | Line 110/53: `inboundMessageId` is the "canonical inbox entry id", which for a keyed inbound is still the peer's own id; line 197 close route is `/promises/:inboundMessageId/close` with the id alone; `hasCanonicalReplyFor(threadId, id)` is thread-scoped but the close tool is not. Round 1 asked for (peer, thread, messageId) keying. Two peers reusing an id still alias in the close route and index. Fix is small: key on (peer, threadId, id), put threadId in the route. |
| D5 at-most-once across crash | SETTLED | Line 155-158 `sending` then `noticed`, startup marks `unknown`, never resent, test 14. Residual MINOR: fsync not stated; and a failover holder reading a replicated log where the `sending` entry lags behind sees `open` and can send a duplicate (the per-peer cap is local memory). See N4. |
| D6 receive-side per ingress, waiter hole | MOSTLY SETTLED | Section 5 lists the four ingresses, "not a reply for the waiter logic", skip delivery bookkeeping. Residual MINOR: test 8 does not assert `waitForReply` stays waiting (round 1 asked for it explicitly), and no shared `isReplyNotice` predicate is named. |
| D7 `/threadline/peers` path | SETTLED | Section 6 uses the real routes. |
| D8 unbounded growth / fan-out | PARTLY | Outbound is capped (line 159: 1/peer/h, 20/agent/h) and the log ceiling is 24h. Still absent: a cap on OPEN rows / the in-memory index, a trust floor for recording an obligation, 0600 (rides the thread log, unstated). See N1 for the new problem the global cap creates. MINOR on the memory side. |
| D9 sessionName + close authorization | PARTLY | sessionName: settled (decision 2; listener has none, stated). Authorization: line 199-200 binds close to the recorded name unless `operator: true`. See N2: that bind is self-asserted. Also "record who closed it" (round 1) is not adopted. Awareness text: settled (section 8). |
| P1 perms/backup | MINOR, partly (backup exclusion stated line 134-135) | |
| P3 unverified peer label | NOT SETTLED, MINOR | Line 111 still says "relay address if unverified" with no stored marker. |
| P4 T bounds | NOT SETTLED, MINOR | Line 212 `noticeAfterMin (30)` has no min/max. A 0 turns it into a notice on every message. |
| P5 dates | SETTLED | ISO `ackedAt` on the wire. |

Unsettled (count): D4, D9 (authorization half), P3, P4 = 4 items; of these D4 is the only one a round-1 reviewer rated DESIGN that remains DESIGN-sized. Reported count below uses DESIGN-origin items still open: D4 and D9 = 2, plus P3/P4 as MINOR carry-overs.

## B. Round-1 ADVERSARIAL findings

| # | Status | Evidence |
|---|---|---|
| D1 trust/downgrade | SETTLED | as S-D1. |
| D2 forged notice poisoning | SETTLED, with MINOR gaps | Decision 8 covers all four checks and a 10/peer/24h cap. Residual MINOR: no cap on `items` per notice; for an UNPINNED (plaintext) peer a relay can forge a notice naming real ids we sent, and section 6 does not say `lastReplyNotice` is labelled verified/unverified (round-1 security D7). Harm is a false "no reply yet" label only. |
| D3 crash window | SETTLED | as S-D5. |
| D4 inReplyTo vs 400; warm-bound must equal latest inbound | SETTLED via rule 2 | Rule 2 makes the exact-id match non-load-bearing. |
| D5 session-based close, no session source | SETTLED | Same-session fallback dropped (line 62-64); rule 2 chosen and its false-close trade is stated. |
| D6 silent deliberate close | SETTLED in intent | Decision 10. Residual: see N3 (caps and capability gating can make it silent again). |
| D7 close authority | SEE S-D9 | |
| D8 wrong path | SETTLED | |
| D9 symmetry/awareness | SETTLED | Sections 4 and 8. |
| D10 collapse mixed reasons | SETTLED | Decision 5, per-item reason. |
| P1 handover detection | SETTLED | Section 2: only the holder sweeps; unreplicated means silent. |
| P2 wedged-alive session | SETTLED | At-most-once, no escalation (line 158); worked timeline. |
| P3 cap vs ceiling | SETTLED | Line 160-161, 166-168. |
| P4 forwarded sends | SETTLED | Decision 3 last sentence, test 11. |

## C. NEW findings introduced by v3

**N1. DESIGN: the 20/agent/hour global cap is a starvation lever.** Line 159-161. Acks go to any non-`untrusted` sender and first-contact profiles are created at `verified` unless enforcement is on (round-1 security D8). An attacker rotating fingerprints, each sending one promised-ack message and getting no reply, takes the 20 per-agent slots; a legitimate peer's notice is "held back" and expires at 24h (line 167-168) with no notice, which is gap H again for that peer, produced on demand. Needs one of: per-peer fairness (reserve/priority for established peers), a trust floor before an obligation is recorded, or an explicit statement that this is accepted. Currently nothing says so.

**N2. DESIGN: the close-authorization bind (line 198-200) is not a security boundary.** `operator: true` is a flag the caller supplies, the server token is shared by all sessions of the agent, and session identity is a self-asserted `INSTAR_SESSION_NAME` header. A prompt-injected session passes `operator: true`, or when `listener-delivered` (no recorded name; the common warm path) just closes with `duplicate` or `answered-elsewhere`, which send nothing (line 201-203) and silence the notice. The spec must either state the threat model as "accident prevention only" and say so, or require a credential the session does not already hold, and record the closer (round 1 asked; not adopted). Also, `answered-elsewhere`/`duplicate` are unverified assertions by the caller; consider checking rule 2 before accepting them.

**N3. DESIGN: capability gating (decision 9) plus caps defeat decision 10, and the capability source is still open.** (a) Decision 10 says a deliberate close "must not be silent", but the notice is subject to the per-peer 1/hour cap (a held-back item waits or expires) and to the older-peer rule, so the deliberate-close path can still leave the peer with a bare "Composing response..." and nothing after. State whether `no-reply-needed` bypasses the per-peer cap (it is a one-shot, session-initiated, so a bypass seems safe) and accept the older-peer residue explicitly. (b) Lines 254-258: the capability source is an open question the spec itself defers to this round. Because the stall that motivated the work (thread-ff759fcf) is a relay path, and the HTTP-health list is empty for relay-only peers, "fail closed" may mean the feature reaches nobody it was built for. This must be decided in the spec, not left open at convergence.

**N4. MINOR: replicated-log lag can duplicate a notice at failover.** Section 2 plus line 155: the at-most-once guarantee is per-machine startup logic. A new holder that has the replicated `open` entry but not yet the old holder's `sending` entry may notice again; the per-peer cap lives in memory. Add: new holder suppresses for one replication-grace window after taking the relay, or the cap check reads the replicated log.

**N5. MINOR: decision 4 carries `text` "for peers that render it as content", but decision 9 sends only to peers advertising the capability**, who by definition render from `notice`. The fallback text serves nobody and widens the parse surface; drop it or say who consumes it.

**N6. MINOR: non-deferred path (decision 1 end).** It records `consumer: 'unknown'`; decision 11 then suppresses every notice for `unknown` with no reader, so these obligations are recorded and can never fire. Say whether this path is expected to be notified; if not, do not record it.

**N7. MINOR: new `kind: 'promise'` and `'reply-notice'` entries in the shared per-thread log.** Spec does not list the log readers (history injection into sessions, `hasCanonicalReplyFor`, replication, Telegram mirror) that must skip or render them. Decision 3 rule 2 correctly says "non-ack, non-notice"; `promise` entries need the same explicit exclusion plus a test.

**N8. MINOR: rollout forcing function is a report only.** Section 9: `rollout: OVERDUE` is a field on a health surface; nothing acts on it. Per the standing enforcement-over-advisory standard, name the consumer (auto-flip or auto-disable at the deadline, or a session-start nag).

**N9. MINOR: restart detection source unspecified.** Section 3 uses "the server restarted since `ackedAt`"; the spec does not say where the boot timestamp comes from or that it survives a crash.

## Summary
- Round-1 findings still unsettled: 4 (D4 identity keying; D9 close authorization; P3 unverified label; P4 T bounds). DESIGN-sized: 2.
- New DESIGN findings: 3 (N1, N2, N3).
- New MINOR: 6 (N4-N9).
- Verdict: NOT CONVERGED.
