# Side-Effects Review — Chief of Staff needs a verified owner; refused messages are never "delivered"

**Version / slug:** `chief-of-staff-verified-owner`
**Date:** `2026-11-10`
**Author:** `Echo (instar-dev)`
**Second-pass reviewer:** `independent subagent (see below)`
**Tier:** 1 (narrow, reversible; a revert restores the old behaviour). Size: 6 source/test files, about 330 lines including tests. Spec review rounds: 0 (Tier 1, bug fix). Commit attempts: see PR.

## Summary of the change

Echo Bugs topic 10000002533 / feedback fb-bb47cf7b-72a. Inspec switched Chief of Staff on with no owner configured. The CoS owner-only inbound gate (server.ts) read only the configured owner id, so it refused the operator, the agent's sole verified operator, six times. The standby proxy started on each inbound before or regardless of that refusal and sent "…Your message has been delivered to the session."

- `src/core/chiefOfStaffOwner.ts` (new): pure rules. `chiefOfStaffInboundVerdict` (not-cos-topic / owner / no-owner / not-owner / unverified), `chiefOfStaffRefusesInbound`, `chiefOfStaffRefusalLine` (each starts "This message was not delivered."), `chiefOfStaffActive`, and `makeChiefOfStaffGate`. The gate is the switch AND a verified owner, and it reports the ownerless state once per episode.
- `src/messaging/TelegramAdapter.ts`: public `getVerifiedOwner()` returns the configured owner, else the one verified operator (the existing ACT-115 `getCallbackApprover`). CoS taps use it; with no owner, the tap answer says so.
- `src/messaging/ChiefOfStaffTopic.ts`: optional `ownerKnown`. Switched on without an owner gives `held-no-owner`: nothing is created, and an existing topic or pin is not touched.
- `src/commands/server.ts`: the inbound gate, the renewal hook and `ownerResolvable` all use `getVerifiedOwner()`. The loop and protocol `enabled` and the topic ensure use one shared `chiefOfStaffActiveGate`, which reports through DegradationReporter once. Wiring still follows the switch alone, because the verified-operator half of the owner is wired with the routes, after the CoS block. The topic ensure re-checks a held result three times, 60 s apart, for the same boot-order reason. PresenceProxy gets `isInboundRefused`, which uses the same verdict.
- `src/monitoring/PresenceProxy.ts`: optional `isInboundRefused`. A refused user message starts no watch, and an existing watch is left as it was.
- `TelegramAdapter.isInboundRefused` (set by server.ts next to the routing wiring) is the one refusal check that every "delivered" acknowledgement asks.
- `src/server/routes.ts` `/internal/telegram-forward`: asks that check before routing, using the cleaned sender id (an unverified sender is 0). It still hands the message to `onTopicMessage`, so the gate logs it and sends the "not delivered" line, and it replies `refused: true`.
- `src/lifeline/TelegramLifeline.ts`: reads `refused` from an accepted forward (`readForwardRefused`; an older server or an unreadable body reads as not refused). It sends no "✓ Delivered" for a refused text, photo or document message, and a refused replay is marked handled but not counted in the "has now been delivered" notice.

## Decision-point inventory

- CoS inbound owner-only gate — modify. The owner source widens from "configured only" to "configured, else the one verified operator".
- CoS tap owner check — modify, same widening.
- CoS activation (topic, loop, protocol) — modify. Now also requires a verified owner.
- PresenceProxy standby start — modify. Skips messages the inbound gate refused (it consumes the gate's verdict and adds no judgment of its own).

---

## 1. Over-block

Activation is now refused in one more case: switched on with no configured owner and no single verified operator. That is exactly the state in which the feature could only refuse everyone, so nothing usable is lost. A boot-order gap could hold a verified-operator-only install's topic creation at the first boot. It is mitigated by the three 60 s re-checks and by the system-topic adoption `ensureOwn` path, and an existing topic is never rolled back while held. The loop and protocol read the gate live, so they pick the owner up as soon as the routes wire the resolver.

## 2. Under-block

Widening the owner to the inferred verified operator lets that person in when no id is configured. `resolveApprovalOwner` only infers when exactly one Telegram user was ever verified on this machine and the current bindings agree. Asserted (manual route) bindings never count. This is the same bar approval buttons already use. A configured owner always wins. The proxy predicate reads the sender from the logged entry. An unverified forwarded inbound carries no sender id, so it reads as unverified and is refused, which matches the gate.

## 3. Level-of-abstraction fit

The rules live in one pure module that every seam calls. Owner resolution reuses the existing ACT-115 resolver rather than adding a parallel one. The standby proxy consumes the gate's verdict rather than re-deriving ownership.

## 4. Signal vs authority compliance

- [x] Yes, but the logic is a deterministic identity check, not a brittle content heuristic. Ownership is an authenticated id comparison (Know Your Principal), the kind of hard floor the principle allows. No message content is judged.

## 4b. Judgment-point check

No competing-signals judgment. The decision is an id equality against a verified principal.

## 5. Interactions

- The server's own "✓ Delivered" injection confirmation is unaffected: the gate returns before routing. The lifeline's "✓ Delivered" (lifeline-owned polling) did fire for refused messages. The second-pass review found this, and it is now gated on the server's `refused` reply.
- Mixed versions: an older lifeline with a newer server ignores `refused` and still sends "✓ Delivered" until it restarts on the same update (the lifeline restarts with server updates). A newer lifeline with an older server sees no field and behaves as before.
- The PresenceProxy refusal check runs before `getSessionForTopic`. It does not cancel a running watch for an earlier accepted owner message, so a stranger's message cannot silence the owner's standby.
- The refusal notice changes from once per sender per day to once per sender and reason per hour, so the operator in the incident would have seen a "not delivered" line instead of five silent drops. Spam exposure is bounded by the hourly limit.
- Tunnel-consent taps still require a configured owner. They are not touched (their prompt is only sent to a configured owner's DM).

## 6. External surfaces

User-visible: refusal wording in the CoS topic, the tap answer when no owner exists, and one degradation report when the feature is switched on without an owner. No routes, config keys or agent-installed files change. No migration is needed: existing ownerless installs bind to the established operator at runtime through the resolver, or stay off with the report.

## 6b. Operator-surface quality

Every refusal names what happened ("not delivered") and the path to act: message the agent elsewhere to be verified, or set ownerUserId. The degradation report gives the same path.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN, on the existing seams. The lifeline-to-server forward is same-machine. The inbound gate runs on the machine that receives the Telegram update, the verified-operator record is per machine by design (ACT-115: replicated bindings never count, as a security boundary), and the CoS loop already acts only on the lease holder. The degradation report is per machine. A standby that resolves no owner simply stays off, which is the safe side. One-voice: refusal notices come from the receiving machine only. No durable state is added and no URLs are generated. Status surfaces: none changed.

## 8. Rollback cost

Pure code change. A revert restores the old gate and proxy behaviour on the next patch. No persistent state is added.

## Conclusion

This closes the three gaps the bug named: activation without a verified owner, existing ownerless installs (they bind to the established operator or stay off with a report), and a delivery claim for a refused message. It reuses the existing owner resolver and standby seams. Clear to ship once the second-pass review concurs.

## Second-pass review (if required)

**Reviewer:** independent subagent, 2026-11-10.
**First read: concern.**
- The lifeline's "✓ Delivered" still fired for refused messages, because the forward route always answered `forwarded: true`. **Fixed** with `refused` on the route, the check in the lifeline at all three acknowledgement sites, and the replay count.
- A false "no owner" report on every boot for installs whose owner is the inferred operator (the lookup is wired after the first check). **Fixed:** `ownerSourcesReady` holds the report until a configured owner exists or the lookup is wired. The gate still reads OFF until then.
- Overlapping retry chains from adoption passes. **Fixed:** one chain at a time (`_cosTopicRetryPending`).
- Text-only wiring tests. **Added:** a route integration test (`tests/integration/telegram-forward-refused-inbound.test.ts`) and lifeline tests (`tests/unit/lifeline/refused-forward-no-delivered.test.ts`).
Confirmed by the reviewer: no new way in for a non-owner; unverified senders are refused consistently; when the gate reads false at runtime, the loop and protocol stand down without rolling the topic back.

**Re-check (same reviewer):** concurred, on two conditions: update the stale text match in `chief-of-staff-surfaces-wiring.test.ts`, and confirm the integration test passes. Both are done: the wiring test passes 9/9, and `telegram-forward-refused-inbound.test.ts` passes 4/4. `chief-of-staff-loop-wiring.test.ts` pinned the old renewal line and was updated the same way.

Concur with the review

## Evidence pointers

- `tests/unit/chief-of-staff-owner.test.ts`: 15 tests. Both sides of every verdict; the gate is held and reported once per episode; topic held, existing topic kept; standby silent for a refused message and normal for the owner and for other topics; taps accept the verified operator and refuse others and the ownerless case.
- `tests/unit/chief-of-staff-surfaces-wiring.test.ts`: static wiring of each server seam.
- `tests/integration/telegram-forward-refused-inbound.test.ts`: the real forward route replies `refused: true` for the incident case, still hands the message to the gate, and leaves other conversations and older adapters unchanged.
- `tests/unit/lifeline/refused-forward-no-delivered.test.ts`: `readForwardRefused` on both sides; all three "✓ Delivered" sites check it; a refused replay is not counted.
- Follow-up: the standby proxy's new `isInboundRefused` option now sits after `speakerElection` in the server wiring, so `tests/unit/ws3-one-voice-wiring.test.ts` (which looks for `speakerElection` near the start of the `PresenceProxy` config) passes again. Ordering only; no behaviour change.
- Existing `tests/unit/chief-of-staff-topic.test.ts`, `ChiefOfStaffLoop.test.ts`, `chief-of-staff-protocol-wiring.test.ts` and `callback-owner-fails-closed.test.ts` all pass.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect. This is a server code defect (owner source and proxy ordering).

**unbounded-self-action: closure n/a.** The only self-triggered action added is the held-topic re-check. It is bounded and one-shot, not a loop: at most 3 re-checks, 60 s apart, one chain at a time (`_cosTopicRetryPending`). Each check only reads state, and nothing restarts, spawns or notifies in a cascade. The single notice (the ownerless degradation report) fires once per episode.
