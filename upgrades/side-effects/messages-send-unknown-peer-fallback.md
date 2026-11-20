# Side-Effects Review — cross-machine /messages/send: real relay path, unknown-peer fallback, honest failure

**Version / slug:** `messages-send-unknown-peer-fallback`
**Date:** `2026-11-20`
**Author:** `Echo (instar-dev agent, outage repair run E2)`
**Second-pass reviewer:** `not performed by a separate reviewer: this work ran in a worker fork that cannot start subagents; an independent read is requested on the PR (see Second-pass review)`

## Summary of the change

Tier 1 (declared). 3 source files and 3 test files plus artifacts, about 300 lines of source and 500 of tests. One review round, no spec rounds.

`src/messaging/MessageRouter.ts`:
1. **Relay URL fix.** `relayToMachine` posted to `<peer>/messages/relay-machine`, but the receiving route has always been mounted at `/api/messages/relay-machine` (`src/server/machineRoutes.ts`, Machine-HMAC). Every cross-machine relay got a 404 and fell into the outbound queue as "relay failed (machine unreachable)". Live evidence: the Studio's outbound queue holds the 17:32 message to the Mama PC with exactly that reason, 84 ms after send, while the Mama PC was paired and online. This is why the outage workaround was POSTing to the peer's own `/messages/send`.
2. **Revoked target:** fail with a clear reason, no fallback.
3. **Unknown target** (not in this registry at all): offer the envelope, signed by this machine, to up to 4 active registered peers over the same Machine-HMAC relay route. A peer that knows the target carries it exactly one hop: it adds itself to the relay chain, re-signs, and relays to the target. A peer that does not know it answers 409 and the next peer is tried.
4. **Forwarder side** (`relay()`): an inbound machine envelope addressed to another machine is never stored as if it were ours. It is forwarded only when its chain is exactly `[signer]` (came straight from its origin) and the target is active here with a URL; otherwise it is refused.
5. **Delivery on arrival:** a cross-machine envelope for this agent's own named session is typed into it through the existing `deliverSameAgentLocal` (ownership check, queued retry), the same as a same-machine send. `best` and other agents stay inbox-only as before.
6. **Honest result:** `SendResult` gains `delivered`, `failureReason`, `notice`, `via`. A terminal failure raises one `DegradationReporter` event per target per 30 minutes (bounded map).

`src/server/routes.ts`: `POST /messages/send` answers **502** (body: the result plus `error`) when the phase is `failed`; every other outcome keeps 201.

`src/messaging/types.ts`: the new optional `SendResult` fields.

## Decision-point inventory

- `MessageRouter.routeCrossMachine` (inactive-target branch): modify: revoked → refuse; unknown → peer fallback → refuse with notice.
- `MessageRouter.relay` (machine source, foreign-addressed): add: one-hop forward or refuse.
- `MessageRouter.relay` (machine source, own named session): add: inject via the existing same-agent delivery path.
- `POST /messages/send` status: modify: 502 for `failed`.

---

## 1. Over-block

The only new refusals are a forwarder refusing (a) chains longer than one hop, (b) chains whose first entry is not the signer, (c) targets it does not know. A legitimate two-hop route (origin knows only A, A knows only B, B knows the target) is refused. Pairing is pool-wide, so the pool does not normally create that topology, and the refusal produces an honest 502 notice at the origin, not silence. Direct relays between paired machines are unaffected by these checks (their envelopes are addressed to the receiver).

The 502 status: a caller that treated any non-201 as an exception now sees one for a send that never left the machine. Before, the same send returned 201 with `phase: failed`, which is the bug. In-repo callers read `phase` (`localVerifyWiring` uses the router directly, not HTTP); none depends on 201 for a failed cross-machine send.

## 2. Under-block

- A target unknown to every reachable peer still fails (now loudly). The remedy is pairing, which the notice names.
- A known target that is offline still goes to the outbound queue (unchanged; phase `queued`, `delivered: false`, no notice). Whether that queue drains is the git-sync transport's concern, unchanged here.
- The forwarder has no per-origin rate limit beyond the existing Machine-HMAC nonce/sequence checks and the route body budget. A paired machine could already send it any number of envelopes directly.

## 3. Level-of-abstraction fit

The fallback lives in `MessageRouter`, the single place cross-machine routing is decided, and reuses its existing primitives (signEnvelope, relayToMachine, the relay-chain loop check, the Machine-HMAC route). No new transport, no new endpoint, no bearer token sent anywhere new. The alternative suggested in the brief (POST the peer's bearer-authed `/messages/send`) was rejected: it would send the agent bearer token to a URL learned at runtime and would skip the envelope signature. The Machine-HMAC relay route already authenticates both legs with each machine's own key.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over content.

The new refusals are structural transport invariants (hop limit, chain/signer consistency, target known), not judgments about message content. The DegradationReporter event is a signal only.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The hop limit and chain checks are invariants of the relay protocol (loop prevention, provenance), enumerable by construction.

## 5. Interactions

- **Loop prevention:** the existing `isRelayChainLoop` still runs first; the forwarder adds itself before re-signing, so a bounce back to it is refused.
- **Dedup:** the target dedups by message id as before; if a send reaches the target through one peer, a later copy through another peer is a duplicate at the target (ACK, no re-store).
- **Signature semantics:** the envelope signature never bound `message.from.machine` to `signedBy` (unchanged). The target therefore already accepted any envelope the forwarder signs; re-signing grants the forwarder no new authority. It does mean the target cannot prove from the signature alone that the origin sent it; `relayChain[0]` records the origin and is covered by the forwarder's signature.
- **Session injection on arrival** reuses `deliverSameAgentLocal`, whose `isOwnSession` check prevents typing into a session this agent does not own. Before this change no cross-machine envelope ever arrived (the 404), so there is no prior inbox-only behavior for named sessions to preserve.
- **Threadline:** untouched (separate relay and `/messages/relay-agent`).

## 6. External surfaces

- `POST /messages/send` answers 502 for failed cross-machine sends (documented in the awareness entry).
- Peers now receive real `/api/messages/relay-machine` traffic where before they received 404 requests on the wrong path.
- Timing: the fallback tries at most 4 peers with the existing 10 s per-request timeout, so a worst-case unknown-target send now takes up to about 40 s instead of failing instantly.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

This change IS cross-machine transport. Posture: delivery, no replicated state (the message moves). Each machine decides from its own registry; registries that disagree (the 2026-11-20 split, where the Studio did not list the M5 Pro and the Laptop did not list the Mama PC) are exactly what the peer fallback bridges. User-facing notice: returned to the sending session only (one voice, the sender); the DegradationReporter event is machine-local and deduped.

## 8. Rollback cost

Pure code revert; no state migration, no config. Envelopes already delivered stay delivered. Reverting restores the 404 behavior.

## Conclusion

Ship as Tier 1. The URL fix alone restores cross-machine `/messages/send` between paired machines; the fallback and the honest 502 close the unknown-peer case named in E2.

## Second-pass review (if required)

The change touches inbound message dispatch, which calls for an independent reviewer. This worker fork cannot start subagents, so no separate reviewer ran. The self-review above was checked against the code paths the unit, integration and e2e tests drive. The PR body asks for an independent read of the forwarder trust argument (section 5, "Signature semantics").

## Evidence pointers

- Live: Studio outbound queue entry for the Mama PC, `reason: outbound: relay failed (machine unreachable)`, 84 ms after send, target paired and online.
- `git log -S` shows the `/messages/relay-machine` vs `/api/messages/relay-machine` mismatch dates from the commit that introduced cross-machine routing (9be3cdddf).
- `tests/e2e/messages-send-cross-machine-alive.test.ts` fails on the old path (`expected 'queued' to be 'received'`) and passes with the fix.
- `tests/unit/message-router-unknown-peer-fallback.test.ts` (8), `tests/integration/messages-send-unknown-peer-fallback.test.ts` (4, real Machine-HMAC over real ports), e2e (2). Related suites: 14 unit files / 372 tests, 13 integration files / 254, 9 e2e files / 124 green.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a source code defect in the transport, not a prompt/hook/config/skill/standards artifact; no self-triggered controller added).
