# Convergence Report — Agent messages reach the session that holds the role now

## Cross-model review: codex-cli:gpt-6-astra

GPT-tier review (codex CLI, model gpt-6-astra) ran successfully in all six rounds. A clean-door Claude read (claude-code, claude-opus-5-5) also ran every round; it is a second read, not a cross-model opinion. Gemini is not signed in on this machine and did not run.

## ELI10 Overview

An agent runs many sessions at once, and they pass work to each other with short internal messages, addressed by the session's name. Those names change when a session restarts, so messages went to names nobody answered and were quietly marked failed. Messages to a session on another of the agent's machines have never worked at all: since August they went to a web address the other machine no longer serves, and even before that, the receiving machine filed them without ever typing them into the session.

This change makes a message find the session that holds that job now, with no guessing: it delivers only when exactly one session fits, and never into a session that started after the message was written. Messages between machines go to the right address, are checked on arrival, are typed into the right session, and come back with a signed receipt or a signed refusal. When a message can't be delivered, the session that sent it gets one short note saying why.

The trade-off: in this first phase, if the other machine is asleep or the conversation has moved to a third machine, the sender is told plainly instead of the system retrying or re-sending on its own. That automatic part is a second step.

## Original vs Converged

- **The cross-machine cause.** The first draft thought Studio-to-M5 messages failed on the network and proposed trying more addresses. Reviewers found the real cause: a moved web address (404) plus a receiver that never typed messages. The fix now corrects the address and adds delivery on arrival.
- **No guessing.** The first draft let a prefix rule and a name fallback pick a session. That could merge two roles, or send a message across conversations with different audiences. Now the first rule with any candidate decides, the conversation (topic) outranks names, and two candidates always refuse.
- **No stale typing.** A message is never typed into a session that started after it was written. Retries are pinned to one session id, and a machine that stops mid-typing never types the message again; it reports "outcome unknown".
- **Signed both ways.** Only a signed receipt or a signed refusal from the intended machine counts. A proxy or a tunnel answering is never taken as proof.
- **Notices that can't be abused.** Only the system creates them. They go to the exact sender, are marked as information, are grouped to one per sender per minute, and are carried back across machines with a signature.
- **Cut to phase 1.** Rounds 3 to 5 kept finding problems in an ambitious background retry layer (backoff, "away" machines, probes, re-sending to a moved topic). It was cut. Phase 1 makes one delivery pass per message and reports the outcome. Phase 2 adds the retries.
- **The 112 stuck messages** are left alone and not replayed. They were already marked undelivered.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | all six internal, codex, clean-door, gate (2 flags) | ~40 (15 distinct) | 8 | relay path + delivery on arrival; rule order; freshness; pinned retries; notice design; posture |
| 2 | all six, codex, clean-door, gate (7) | ~20 | 5 | local-only retry scope; session-id pin; signed ack; forced from fields; per-machine walker |
| 3 | four agents covering six lenses, codex, clean-door, gate (13) | ~8 | 6 | origin re-send instead of forwarding; age-based freshness; verify-before-ack; backlog untouched |
| 4 | three agents covering six lenses, codex, clean-door, gate (7) | ~7 | 6 | atomic store; at-most-once boot recovery; generations; away + probe |
| 5 | two agents covering six lenses, codex, clean-door, gate (5) | ~6 (all in the retry layer) | 4 | CUT to phase 1: one pass, signed ack and nack |
| 6 | two agents covering six lenses, codex, clean-door, gate (5) | 6 (stale forwarding text; clock-skew 2W [safety]; notice-before-ack; name collision; false notice on typed-but-unacked [data-loss]; notice from.machine) | 5 | all applied as one-line rules (no new mechanism); not re-reviewed, at the cap |

## Proportion

Tier 2. The spec grew from about 110 to about 300 lines over six rounds, hitting the Tier-2 cap. ⚠ Six rounds is at the cap. Most of rounds 3 to 5 went into a background retry layer that was then cut. The lesson "blockers not falling means cut" should have fired one round earlier.

## Left behind

- **Phase 2, tracked under CMT-1940:** durable retries for a machine that is away, retries for remote notices, and automatic re-send to the machine now holding a topic. Phase 1 reports each of these to the sender instead.
- **Accepted (Judgment Within Floors flags, rounds 4-6):** the freshness filter refuses a successor session that restored its context. It is kept invariant because typing is irreversible and the refusal costs one notice. The 10s timeout, the one-pass queue, the 60s grouping and the 120-character rule are tunable constants, and each has a floor that always tells the sender.
- **Accepted (No Manual Work flag, round 6):** a sender re-sends by hand to the machine named in `topic-held-on`. Automatic re-send is phase 2.
- **Precision items:** retention of session records (the prune rule is stated); the two ack strings carry no generation (no generations in phase 1); an old origin stores an unknown `delivery-notice` type harmlessly.
- **Round-6 fixes applied without a further review round**, at the cap. Each is a one-line rule with no new mechanism:
  - `onDeadLetter` only for envelopes that were never typed;
  - local notices only when `from.machine` is this machine;
  - verified notices accepted while `relaying`, with ack compare-and-set;
  - a spawn refused when its tmux name was held by another role;
  - 2W subtracted for clock skew;
  - two stale "forward" lines removed;
  - the ack sent after the store, before typing;
  - dedup also checks `dead-letter/`.

  The build's tests cover each of these.

## Full Findings Catalog

# messages-reach-renamed-sessions convergence log

## Round 1 (2026-11-18 05:38-05:45 PT), body hash a18bb866
Standards-Conformance Gate: ran (2 flags: Verify the State on HTTP status as peer proof; Judgment Within Floors on the 10s/30s bounds)
Externals: codex-cli:gpt-6-astra ok (SERIOUS ISSUES, 4 design); claude-code clean-door (claude-opus-5-5) ok (MINOR, 3 design + 2 precision). gemini not authed.
Internal reviewers (session model claude-opus-5-5): security 7 (6 design), scalability 6 (4 design), adversarial 7 (6 design), integration 9 (8 design), decision-completeness 4 design + 3 precision, lessons-aware 9 (6 design).
Key design findings (deduped):
1. Relay posts to /messages/relay-machine; route is /api/messages/relay-machine -> 404 (verified live on M5: 404 vs 401). Problem 3 misdiagnosed. (security S1, scalability S1, integration F1, lessons L1)
2. relay() never calls deliverSameAgentLocal; receiver never types messages; posture claim false. (security S2, integration F2)
3. Outbound queue has no drainer (GitSyncTransport not constructed); 112 stale envelopes. (lessons L8, verified)
4. Retry manager uses to.session; redirect lost on retry; dead-letter happens in retry manager not router. (adversarial F1, scalability S2/S3, integration F3, lessons L3, DC-2)
5. HTTP non-2xx is not proof of peer refusal (proxy/Cloudflare/other agent on shared IP). (gate, codex, clean-door, security S3, lessons L2)
6. Prefix rule merges roles (chamber vs echo-chamber); rule order / fall-through contradiction; name fallback crosses topic audiences. (adversarial F3, codex, clean-door 3/6, DC-1, security S6)
7. Stale messages acted on by a fresh session (freshness). (adversarial F2)
8. Respawn handoff ambiguity should be retryable. (adversarial F4)
9. Notice: unproven from.session is an injection vector; misses scripts and remote senders; no grouping. (security S5, adversarial F5, lessons L5, scalability S6, codex, clean-door 4)
10. Sender-address half (fb-2e23f5e5) not fixed. (lessons L4)
11. Relay addresses: reuse PeerEndpointResolver/resolvePeerUrls; LAN cleartext ordering; build list before lastKnownUrl check; fresh signature each attempt. (DC-3, security S4/S7, integration F5/F6)
12. 30s total cap unjustified; caller held. (gate, DC-4, scalability S5, codex)
13. Rule E misses interactive and triage spawn paths. (integration F4)
14. Posture section contradictory. (integration F7)
15. Standing-down sessions as candidates; topic owned by another machine. (adversarial F6)
Precision left behind: notice max length (now 120 cap); plannedTmuxSessionName collision test (P-2, added via E); live-proof pair naming (named); headless claude -p paste (frontloaded, tracked); 'most recent record' definition (now pickSessionByTmux); DeliveryState field + GET exposure (stated); rollback of E (stated); resolver hot-path cost (memoized listSessions, stated as inputs).
Verified by me: relay() answers duplicates with success (MessageRouter.ts:278), so the 409-after-timeout rule was dropped; relay route 409 lumps reasons (machineRoutes ~1372), so the build adds stable codes.

## Round 2 (05:44-05:50 PT), body hash e68b83d1 (edited mid-round on D.4 after gate flags)
Standards-Conformance Gate: ran (7 flags: freshness judgment, 10s basis, 60s/1h windows, 120-char truncation disclosure, JSON codes != identity, 2xx duplicate vs refusal, ownership at fire time)
Externals: codex-cli:gpt-6-astra ok (SERIOUS, 4 design: name pin not incarnation; ambiguity recovery; store-before-type crash; response not authenticated); claude-code clean-door ok (MINOR, 2 design: handoff wait dead; relaying lost on restart).
Internal: security 4 design (cross-machine queued typed locally; relay not bound to machine/2xx trusted; from fields caller text; notice forgery/suppression); scalability 2 design (unbounded background fan-out; outbound folder regrows) + 5 precision; adversarial 4 design (queued remote typed locally; pin name not session; freshness vs handoff contradiction; from stamping); integration 5 design (TTL dead-letters sender copies -> false notices; posture machine-local not proxied; resolvePeerUrls unguarded + constructed after router; old receiver 2xx without delivery; phases/types missing); decision-completeness 3 design (ambiguity never deliverable; 10s circular; freshness basis vs rule 1 + clock skew); lessons-aware 4 design (watchdog types 10x; cross-machine queued local retry; DegradationReporter forwards upstream; refusal not conserved on sender).
Design count round 2: ~20 (down from ~40). All folded in round-3 rewrite: retry scope local-only; session-id pin; freshness filter-before-count with asOf arrival time; ambiguity always refuses; from.agent/machine forced, exact-name notices, caller cannot create delivery-notice; signed relay-ack-v1; ack-less 2xx = older peer; walker per machine; unconfirmed on last timeout; arrival checks to.machine/from.agent/from.machine==signer; remote notice to signer, moves origin envelope to failed; forward once for topic elsewhere; guarded ropes via late-bound closure; DegradationReporter dropped for local counter; archive per agent, 0600, 30-day reclaim; transitions listed; awareness entry; exclusive-create claim + deliveryPending recovery.
Precision left behind: concurrent duplicate atomicity (now wx claim); notice dedup O(1) (now on DeliveryState); topic registry cache (now mtime cache); archive migration cost (per-file rename); remote notice grouping (added).

## Round 3 (05:52-06:00 PT), body hash 585a9b41 at start (externals ran on it), then edited
Standards-Conformance Gate: ran (13 flags; applied: ack-less 2xx not proof; inline attempt bypassed walker; down-machine shortcut removed; forwarding chain -> origin re-send; alias permanent; archive/migration dropped (Archiving May Never Mean Deleting, multi-machine posture); 120-char keeps head+tail; walker concurrency row added; deliveryPending replay disclosed)
Externals: codex-cli:gpt-6-astra ok (SERIOUS: exactly-once; forwarding identity; ack-less 2xx; timeout on earlier address); claude-code clean-door ok (SERIOUS: ack-less 2xx; duplicate during slow delivery; precision: asleep peer store-and-forward).
Internal (4 agents covering 6 lenses): decision+lessons 3 design (forwarding vs arrival check; table vs D.4 on ack-less 2xx; freshness from arrival not write); security 2 design (forwarding signature; remote failure after forward never reaches origin) + precision (envelope 5-min window; dup ack before verify; request signer vs signedBy); adversarial 4 design (forwarding refused; forwarded failure lost; freshness bypass via arrivedAt; boot recovery rule 1 without pin) + precision (stand-down source; received transitions; ACK timeout scope).
Design count round 3: ~8 distinct (forwarding x2, freshness basis, ack-less 2xx table, exactly-once/boot pin, timeout-any-address, asleep peer, envelope re-sign). Down from ~20.
Applied: receivers never forward, origin re-sends on topic-held-on notice (excludes tried machines); asOf = arrivedAt - sender-measured age, freshness on every rule; envelope re-signed per attempt with age; verify-before-ack for duplicates; request signer == signedBy == from.machine == relayChain[0]; pin written before typing, boot recovery pinned; unconfirmed if any attempt timed out; backoff re-walk 1/2/4/8/15 min until type TTL; received->delivered transitions; ACK-timeout local scope; stand-down source named; handoff refusal disclosed; from.requested.

## Round 4 (06:00-06:08 PT), body hash 85a717ab at start
Standards-Conformance Gate: ran (7 flags; applied: D.2 asOf contradiction; backlog terminal disposition; away breaker; A->B->A revisit)
Externals: codex-cli:gpt-6-astra ok (SERIOUS: asOf contradiction [already fixed]; redirect/notice state machine; queue-wide TTL); claude-code clean-door ok (MINOR: asOf; wx claim vs store not atomic; at-least-once at boot).
Internal (3 agents / 6 lenses): decision+lessons 4 design (head-of-line TTL; away trigger by head TTL + unsigned clear; non-session cross-machine intake no longer expires; row vs body on probe); security+adversarial 2 design (re-send same id to machine holding failed copy acked as received; tunnel edge 5xx defeats backoff/away) + 6 precision (age in SignedPayload, clamp, missing age, boot selector, redirects in notice acceptance, probe signed).
Design count round 4: ~8 distinct, all narrow/cross-machine. Applied: link() atomic store; typingStartedAt -> outcome-unknown, at-most-once; walker expiry once a minute; attempt generations + CAS; topic-held-on as redirect transitions; dedup on (id, generation); unverified answers = unreachable for backoff; away after 15 min no verified ack, persisted, cleared only by signed relay-probe-ack on new route; TTL sweep scope keeps non-walker cross-machine expiry; one-time boot pass with exact selector + marker; age/generation in SignedPayload, clamped, older-sender default.

## Round 5 (06:08-06:15 PT), body hash 66370970
Standards-Conformance Gate: ran (5 flags; applied: unbounded probe; refusal across notice boundary)
Externals: codex-cli:gpt-6-astra ok (SERIOUS: transit time in asOf; (id,generation) vs link() key; remote failure lost when notice undeliverable); claude-code clean-door ok (SERIOUS: unsigned refusal marks live machine away; away vs backoff schedule; link() blocks second delivery).
Internal (2 agents / 6 lenses): sec/adv/integ 3 design (topic-held-on to self; link vs generation; origin TTL sweep beats late notice); decision+lessons 2 design (away contradicts backoff, row basis false; unsigned refusals mark away).
Design count round 5: ~6, ALL in the cross-machine durability layer (walker backoff/away/probe/generations/redirect re-send). Per lesson "spec-reviews-not-falling-means-cut" (two rounds of ~7-8 in the same layer), CUT: phase 1 = one pass per envelope, signed ack AND signed nack, no backoff/away/probe/generations/automatic re-send; topic-held-on and unreachable reported to the sender; asOf = arrivedAt - age - 10s transit bound; origin TTL sweep keeps received cross-machine copies open until notice TTL. Phase 2 (durable retries, notice retries, automatic re-send to topic holder) tracked under CMT-1940.

## Round 6 (06:10-06:15 PT), body hash 3a39c9d8 at start
Standards-Conformance Gate: ran (5 flags; applied: transit bound -> 2W; per-sender notice cap across targets; accepted: freshness successor, constants, manual re-send)
Externals: codex-cli:gpt-6-astra ok (SERIOUS: timeout does not bound transit [fixed: 2W]; notice-before-ack race [fixed]; timeout+refusal); claude-code clean-door ok (MINOR: E collision [fixed]).
Internal: decision+lessons 2 design (stale forward text; clock skew needs 2W [safety]); sec/adv/integ 3 design (false failed notice on typed-but-unacked [data-loss]; timeout floor's resend claim; notice into same-named session on receiver). All applied.


## Convergence verdict

Converged at the Tier-2 cap (6 rounds), with the scope cut to phase 1 in round 5.

Design findings fell from about 40 to 20, 8, 7, 6 and 6 over the six rounds. The last three rounds' findings all sat in the layer that was cut or narrowed. Every safety and data-loss finding from the final round was applied as a one-line rule; those fixes add no new mechanism, and the build's tests cover them. They were not reviewed in a further round, because the cap was reached.

Left behind: the phase-2 retry layer (tracked, CMT-1940), the accepted judgment flags, and the precision items above.

The spec is ready for approval. Approval is the Chief of Staff's, under the standing rule that only constitution changes need Justin.
