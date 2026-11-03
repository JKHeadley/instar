# Round 2 — Integration + Scalability review: THREADLINE-PROMISED-REPLY-SPEC (v3)

Checked against /Users/dawn/Projects/instar-wt-ledger/src. Spec not modified.
Verdict: NOT CONVERGED. Round-1 findings unsettled: 3 (all partial). New DESIGN: 4. New MINOR: 6.

## A. Round-1 findings, one by one

### Integration
- D1 (close on inReplyTo vs reply validation): SETTLED. Decision 3 (L55-68) closes on `hasCanonicalReplyFor` OR any non-ack outbound after `ackedAt`; L125-126 notes the validator accepts the canonical inbox union. A refused reply never closes (stays open, honest). Residual: `tryClaimReply` 409 not mentioned (MINOR, below). But see new N1, which undermines the second rule's data source.
- D2 (forwarded/session fallback): SETTLED in intent (L62-68 drops session fallback, forward carries `inReplyTo`). Depends on N1.
- D3 (settle() plumbing): SETTLED. L49-54 gives the new settle shape per branch, canonical id, nullable name. Listener branch handled at L83-84.
- D4 (trust/downgrade gates): PARTIALLY SETTLED. Encrypt-to-pin (L77-79) avoids the refuseDowngrade exemption; own op + files named (L80-83). But see N2 (level table wrong) and N3 (unpinned invite-paired peers). UNSETTLED.
- D5 (at-most-once): SETTLED. L155-158, `sending` state L116, `unknown` verdict L118, test 14.
- D6 (wire payload, symmetry): PARTIALLY SETTLED. Payload defined L69-74; sender records via recordThreadMessage L170-173; four ingress paths L175-186. But the `kind` field the spec records with does not exist (N1). UNSETTLED.
- D7 (awareness/migration/MCP): SETTLED. L195-212 names tool, HTTP route, templates, PostUpdateMigrator, warm-session prompt, config keys.
- D8 (multi-machine posture): PARTIALLY SETTLED. Section 2 (L127-135) declares unified via canonical history. But the whole claim rides on the per-thread log, which the spec itself calls unreliable (L122-124), and which cannot hold what the spec puts in it (N1). UNSETTLED until N1 resolved.
- D9 (Standard B / P20, unmeasurable): SETTLED. L159-163, decision 11 L95-98.
- D10 (wrong endpoint): SETTLED. L190-193 uses `/threadline/peers/health`; `isPeerHealthBody` updated.
- P1 backup: settled L134-135. P2 rollback: settled L223-225. P3 sender view: settled L192. P4 config keys + per-sweep read: settled L211-212.

### Scalability
- D1 (id/sessionName plumbing): SETTLED (same as Int D3).
- D2 (hook point, claim ledger): SETTLED by moving the check to the sweep (decision 3). The claim-ledger reuse suggestion is dropped; acceptable.
- D3 (fallback sessionName, race on "exactly one open"): SETTLED. Fallback removed; sweep is single-threaded so no race.
- D4 (timers/store at scale): PARTIALLY SETTLED. One 60s sweep, in-memory index, O(open) per tick (L139-141). Still missing: bound on open obligations per peer (a flooding peer creates unbounded open rows until the ack rate limiter, which the spec never ties to obligations; round-1 asked for explicit "skipped acks create no obligation" and a per-peer cap) and append-off-hot-path / batching (the append is on the ack path). Also compaction: state-transition rows are append-only in a hash-chained log, so there is nothing to compact (see N1). UNSETTLED.
- D5 (trust, crash): SETTLED except the sendNoticeToPinned reuse suggestion, not taken; v3's own per-peer cap (L159) duplicates that limiter. MINOR (N9).
- P1 ownerMachine: settled (holder wording L129-130; `ackedByMachine` field remains, MINOR). P2 degradation signal for unwritable store: NOT addressed (MINOR N8). P3 fold-forward: settled L160-162.

### Decision-completeness
- D1 forgery: SETTLED (decision 6 + 8). D2 gates: see D4 above. D3 wire: SETTLED (decision 4). D4 four ingress paths: SETTLED (L177-186); older-peer bound corrected (decision 9). D5: SETTLED. D6: SETTLED (sweep-based). D7: SETTLED modulo N1. D8: SETTLED. D9: SETTLED. D10: SETTLED (decision 10 sends `no-reply-needed`). D11: SETTLED (wire final, deadline file, OVERDUE surface L216-221; but see N7 on its surface). P1-P4: settled (collapse reasons per item; mixed-reason precedence no longer needed).

Unsettled round-1 count: 3 (Int D4, Int D6/D8 jointly via N1, Scal D4). Counting individually: Int D4, Int D6, Int D8, Scal D4 = 4 line items; they collapse to 3 root causes (gates, thread-log schema, open-set bound).

## B. New findings introduced by v3

### DESIGN
N1. The per-thread log cannot hold what v3 puts in it. L104-105 appends `kind: 'promise'` entries plus state transitions to the thread's canonical log, and L137/L172 call `recordThreadMessage` with `kind: 'reply-notice'`. In source: `RecordThreadMessageInput` (recordThreadMessage.ts ~62-77) has no `kind`; `ThreadLogEntry` (ThreadLog.ts 63-85) has `direction: 'outbound'|'inbound'` only, no outcome, no inReplyTo, no kind; the log is hash-chained, append-only, idempotent on `(messageId, direction)` first-write-wins (ThreadLog.ts 224-259), with a symmetry head compared against the peer's copy. Consequences: (a) state transitions for one obligation reuse one messageId and are deduped or flagged as collisions; (b) local-only promise/sending/noticed entries would break the symmetric head against the peer; (c) decision 3's second rule needs "non-ack, non-notice" and "outcome not relay-rejected" from this log, but neither exists there (outcome and inReplyTo live in the canonical OUTBOX, ListenerSessionManager.ts 312-318); (d) the replicate-via-CANONICAL-HISTORY story (L129-133) assumes the log carries obligation state, which it cannot without a schema/digest-version change. Fix: keep obligations in their own append-only event store (keyed by obligation id, rebuilt into the index), declare its multi-machine posture explicitly (replicated how, or holder-local with a justified key), and run the close check against the canonical outbox (which has outcome/inReplyTo) plus a notice-id exclusion set. Only the notice itself goes through `recordThreadMessage` as an ordinary message with a distinguishing marker the spec defines (or is excluded by messageId set).
N2. Trust table level mismatch. L80-83 allows `verified`, `trusted`, `invite`; AgentTrustManager.ts 252-257 has levels untrusted/verified/trusted/autonomous. `invite` is a pairing method, not a level (refuseDowngrade.ts 5), and `autonomous` is omitted (an autonomous peer would be refused a notice while a verified one gets it). Also `DEFAULT_ALLOWED_OPS` is a default only; existing profiles carry persisted `allowedOperations` (line 387 pattern) so a new op needs a migration for existing profiles or it silently never works for already-paired peers. Say: allowed for verified and above, add to defaults, PostUpdateMigrator backfills persisted profiles.
N3. Transport gap for unpinned peers. L77-79: encrypted to the pinned key when a pin exists, plaintext otherwise. A peer that is trusted but not invite-pinned gets plaintext, which is the forgeable channel (the relay's word) decision 8 has to defend against. Decision 8's checks (id we sent, fingerprint, 24h window) do bound forgery, but a forger who can inject plaintext under the peer fingerprint can also learn our sent ids only if they saw them; fine. State this residual explicitly, or limit notices to peers with encrypted capability. (Combined with capability source, see section C.)
N4. Open set is unbounded and has no write-failure behaviour. No per-peer open cap; acks skipped by the rate limiter (autoAck createAckRateLimiter) must create no obligation (state it); append is on the relay receive hot path (L102-105 appends at settle). Add: cap open per peer (e.g. 100, beyond that oldest-first expire without notice or no new obligation), batched/async append, DegradationReporter signal on failed write so an outage is visible.

### MINOR
N5. `tryClaimReply` (ListenerSessionManager.ts 321) gives a second reply to the same inbound a 409; a legitimate follow-up after a notice but on an already-claimed id is refused. Say replies after a claim use the other-outbound rule (decision 3, rule 2) or a fresh `inReplyTo`.
N6. Decision 3 rule 2 closes on any outbound to that peer on that thread, including one sent BEFORE the model finished reading a different inbound. Accepted trade is stated; add a test that a reply about subject B closes obligation A (test 2 covers it) and that a notice from us never closes (exclusion by id).
N7. Rollout deadline surface: L219 reports `rollout: OVERDUE` on the peers-health surface, which is hit only if someone calls it. The Shadow-Mode lesson wants something that fires: add a session-start or sweep-tick log/attention item, not only a field.
N8. No degradation signal when the obligation store is unwritable or the sweep throws (round-1 Scal P2 residual).
N9. Per-peer hourly cap duplicates `sendNoticeToPinned`'s limiter (refuseDowngrade.ts ~197-320). Reuse or state why not.
N10. `ackedByMachine` retained while decision says only the holder acks and sweeps; name `ownerMachineId` semantics or drop the field.
N11. Test gaps: no test for the persisted-profile migration (N2), for skipped/rate-limited ack creating no obligation (N4), for a notice not mistakenly closing other obligations, or for a notice sent to a pinned peer on an older build (should not occur by decision 9; test the capability absence path with encrypted pin).

## C. The open choice (spec L254-258): capability source for decision 9

Recommendation: CARRY THE CAPABILITY ON THE RELAY HANDSHAKE (option b), with fail-closed as the fallback for peers whose capabilities are unknown, and also learn it in-band.

Reasons, from source:
1. The handshake already has the field. RelayClient.ts ~299 sends `metadata.capabilities` in the auth frame; ConnectionManager.ts ~303 stores it; PresenceRegistry.ts ~111 filters by capability. Adding the string `reply-notice` to the default capabilities is a one-line change, not a protocol change.
2. The HTTP health-ping source (AgentDiscovery) misses exactly the peers who matter: relay-only peers, and invite-paired peers who never exposed an HTTP health endpoint. Failing closed on them means the notice never reaches the population gap H affects.
3. Fail-closed is still the right default when the capability is unknown: the harm of a notice sent to an older peer is that it routes as content to a session and may trigger a real reply loop (decision 9's own reasoning).
4. Presence only shows online peers and may hide private-visibility agents (auth frame has `visibility`). So add an in-band source: record `reply-notice` capability on any peer that has itself sent us a valid notice, or that advertises it in a pairing/handshake message. Resolve with order: in-band record, then relay presence, else suppress.
5. Cost of option (a) alone is a silent, unobservable no-op for relay-only peers, which is the Advisory-Only failure shape. Option (b) plus the dry-run log of "would notify, capability unknown" makes the gap measurable before the flip.

Add to spec: a `capabilitySource` field in the dry-run log, and a flip criterion that counts would-be notices suppressed for unknown capability.

## D. Convergence call

NOT CONVERGED. N1 is a structural mismatch with the log schema that blocks the multi-machine posture, the close check, and the notice recording; N2 is a verifiable factual error in the trust levels; N3 and N4 are real but smaller. Everything else from round 1 is genuinely settled. A v4 that moves obligations to their own store, closes against the canonical outbox, fixes the level list with a profile migration, bounds the open set, and adopts the handshake capability should converge in one more round.
