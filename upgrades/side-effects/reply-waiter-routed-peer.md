# Side-Effects Review — Threadline send-and-wait answered only by the routed peer

**Version / slug:** `reply-waiter-routed-peer`
**Date:** `2026-11-16`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1, 3 source files + 1 new module + 2 test files + 3 docs. New `src/threadline/replyWaiterMatch.ts` (`replyWaiterAccepts`) holds the rule for which inbound message may resolve a waiting send. `waitForThreadlineReply` (`src/server/routes.ts`) now records `routedFp`, the full fingerprint the send was delivered to (relay path: the resolved routing fingerprint; local path: `resolvePeerFingerprint(localTarget)`). Both inbound paths call the rule: the relay socket (`src/commands/server.ts`) with the relay-authenticated sender and `allowUnprovenSender:false`; the local `/messages/relay-agent` route with the sender's verified signature fingerprint (now taken in any signature mode, not only enforcing) or, failing that, the registry fingerprint for the name it claims, also with `allowUnprovenSender:false`. When a waiter has a routed fingerprint, only a sender identified as that fingerprint resolves it, on every agent. Multi-person agents keep their rule on top (addressed peer, proven sender, never under post-only); the local path never uses the name lookup for them. Waiter types in `AgentServer.ts`, `routes.ts`, `server.ts` gain the optional `routedFp`. Class of problem: a waiting send was matched by conversation id alone, so another peer on the same thread could answer it. Found by the standing security review.

## Decision-point inventory

- Reply-waiter resolution — modify — deterministic identity match on top of the existing thread-id key.

---

## 1. Over-block

A reply from the routed peer that arrives under a different fingerprint (the peer re-keyed, or a stale `known-agents.json` entry for a local send) no longer resolves the synchronous wait; the tool times out and returns no reply. The message itself is still delivered through normal routing (the waiter block does not return), so nothing is lost. An unsigned local reply from a peer whose name is not in `known-agents.json` (or matches more than one fingerprint) no longer resolves a routed wait; it is still delivered normally.

## 2. Under-block

The local route accepts unsigned envelopes unless local signatures are enforcing (off/dry-run by default). There, a same-machine agent that claims the routed peer's NAME in an unsigned envelope is identified by that name and can still resolve the wait. It is limited to same-machine agents holding the route's token, and it closes once local signatures are enforcing. A waiter with no routed fingerprint (registry entry with neither fingerprint nor key) keeps the old single-person behaviour.

## 3. Level-of-abstraction fit

One pure rule module used by both inbound paths, so the two copies of the rule cannot drift again.

## 4. Signal vs authority compliance

- [x] Deterministic identity match; no content judgment.

## 4b. Judgment-point check

No new heuristic.

## 5. Interactions

- **Routing:** unchanged; the waiter only feeds the synchronous send-and-wait result.
- **Standby forwards:** forward with `waitForReply:false`; the holder's own wait uses the forwarded resolved fingerprint, consistent with `routedFp`.
- **Daemon-handled relay:** no change (no gate-passed listener there, as before).

## 6. External surfaces

None. No route shape, config or file format change.

## 6b. Operator-surface quality

No operator surface.

## 7. Multi-machine posture

Machine-local BY DESIGN: waiters live in the sending server's memory for one request; a peer agent on several machines shares one identity fingerprint.

## 8. Rollback cost

Pure code change: revert and ship a patch. No migration.

---

## Conclusion

The relay path, where untrusted network peers arrive, is closed. The local path no longer resolves a routed wait for a sender it cannot identify. Second pass concurred on the relay path, and its local-path concern is fixed below. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the diff and the transport code)
**Independent read of the artifact: concur on the relay path; concerns on the first local-path version, now fixed.** Relay: the sender is the relay-authenticated envelope `from`, the same `computeFingerprint` format as the routing id, both lower-cased; nickname, standby-forward and cross-machine delivery paths stay consistent; legitimate mismatches fail safe (message still routed, only the wait times out); multi-person rule preserved exactly. Local: the first version kept the old behaviour for unsigned senders, justified by the route's token, but every same-machine agent holds that token and local signatures are not enforcing by default, so the route stayed open. Fixed: any verified signature counts in every mode, otherwise the registry fingerprint for the claimed name, never an unidentified sender; multi-person never uses the name lookup. Its test suggestions are applied: integration cases on the real route, an `allowUnprovenSender` wiring assertion, and a multi-person no-routed-fingerprint case.

---

## Evidence pointers

`tests/unit/reply-waiter-match.test.ts` (16 tests, including source wiring checks for both paths). `tests/integration/threadline-relay-agent-result.test.ts` → `routed-peer waiters on /messages/relay-agent` (3 tests; the two refusal cases fail on the previous code; 10/10 for the file when run as a temporary unit-config copy on 2026-11-16, since the integration config is not run by hand on the Studio). Related unit files (ack-stage wiring, router peer place, credential gate): pass. `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in reply matching, closed by the tests above).
