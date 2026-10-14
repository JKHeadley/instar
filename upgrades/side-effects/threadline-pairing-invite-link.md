# Side-Effects Review — Verified pairing by invite link

**Version / slug:** `threadline-pairing-invite-link`
**Date:** `2026-10-14` (living document: extended at each build step)
**Author:** `Dawn`
**Second-pass reviewer:** `Echo — approved the spec (r3, 21d5fcd1, PR #2180); code review on the build PR`

## Summary of the change

Replaces the human step of verified pairing v2 (read, compare and type 12 words), which Justin rejected on 2026-10-13, with an invite: one send and one approval per person (spec `docs/specs/a2a-pairing-invite-link.md`). Built so far:
- `PairingInvite.ts`: pure encode/decode (checksum), transcript, HKDF MAC key, tag, optional check code.
- `PairingInviteStore.ts`: the inviter's open invites. 0600 file; S deleted on use, revoke or expiry; one per bound peer.
- `AgentTrustManager`: new pairing state `invite-accepted` (pinned, NOT credential-eligible), `markInviteVerified`, `demoteInvitePairing`.
- `PairingInviteFlow.ts`: the protocol engine for both roles (accept, finish, ack, and the second-accept response).
Wire, routes, Telegram and dashboard follow in later steps of the same branch.

## Decision-point inventory

- `PairingInviteFlow.receiveInvite` — add — B's gate on an invite (checksum, expiry, self, bind, relay-key compare).
- `PairingInviteFlow.handleAccept` — add — A's gate on an accept (rate limit, sender == named agent, MAC tag, signature, bind, relay-key compare); single use.
- `PairingInviteFlow.handleAccept` second-accept branch — add — demotes a previously verified pairing.
- `PairingInviteFlow.handleFinish` / `handleUsed` — add — B accepts only signatures by the pinned inviter key.
- `AgentTrustManager.markInviteVerified` — add — grants the credential-eligible state; refuses to swap a pinned key.
- `AgentTrustManager.demoteInvitePairing` — add — removes eligibility and revokes the replicated copy.

## 1. Over-block

- An invite whose key differs from the key the relay presents is refused at both ends. An agent that rotated its identity key since the relay last saw it would be refused until the relay catches up. That is fail-closed and rare.
- A second VALID accept pauses the first acceptor even when the first acceptor was the right one, for example if the recipient forwarded the invite to two of their own agents. The operator re-confirms, so the cost is one extra decision.
- Invites expire after 1 hour by default (24 h maximum), so a slow recipient needs a new invite.

## 2. Under-block

- Names are self-described, and nothing can stop an operator approving an agent they don't know. The prompts say "claimed", and that is the honest limit.
- A leaked invite used by an impostor before the real recipient, when the real recipient never accepts: nothing alarms. The defences are privacy, expiry and binding (default for known peers). Stated in the spec (§7).
- Deviation from spec §4.4.4: after use, the derived MAC key is kept (0600 store) until expiry, to verify a second accept. Someone who reads that file could forge second accepts, which only PAUSES pairings (denial of service, not impersonation). The alternative, accepting unauthenticated second accepts, would hand that same pause to the relay. To be confirmed with Echo on the PR.

## 3. Level-of-abstraction fit

The pure format is in its own module, persistence in a store module, trust state in the single writer (AgentTrustManager), and the protocol in an engine with injected I/O. The transport stays in ThreadlineClient, and the inbound gate dispatches control ops. Each layer is testable alone, and no parallel trust store was added.

## 4. Signal vs authority compliance

Authority to pair is always an operator act (an approval at both ends). The engine only raises prompts (`notify`) and records state on approval. The MAC tag and signature are mechanical checks, not judgments.

## 4b. Judgment-point check

No LLM or heuristic is involved. Every decision is deterministic cryptography or state.

## 5. Interactions

- `isCredentialShareAllowedForProfile` already requires state in {mutual-verified, identity-verified} and source mutual-verified, so `invite-accepted` is ineligible with no change to the gate.
- Replication: `markInviteVerified` emits the verified result like `markMutualVerified`, and `demoteInvitePairing` emits a revoke.
- Later steps must decide `invite-accepted` at each pairingState branch site (bootstrap resolver, receipts, routes, MCP, dashboard). Tracked in the build plan.

## 6. External surfaces

None yet (no routes or messages wired in this step). Later steps add the routes, wire ops, Telegram buttons and dashboard.

## 6b. Operator-surface quality

Not applicable until the dashboard step. The UI requirements from Justin's test are in spec §8.

## 7. Multi-machine posture

The invite store is machine-local (it lives where the relay identity lives). The verified result replicates through the existing pairing replication, and a demotion revokes it on the other machines.

## 8. Rollback cost

The feature is behind `threadline.verifiedPairing`. Turning it off stops all routes. `invite-accepted` profiles are inert, and a code rollback leaves an unknown state string that v2 code treats as not credential-eligible.

## Conclusion

Steps 1–4 are safe to merge behind the flag. Nothing is reachable until the wire and route steps.

## Second-pass review (if required)

Echo approved the spec; code review happens on the PR.

## Evidence pointers

- `tests/unit/threadline/PairingInvite.test.ts` (15), `PairingInviteStore.test.ts` (7), `invite-trust-states.test.ts` (8), `PairingInviteFlow.test.ts` (15).
- Breakages run in scratch: 4 + 5 + 4 + 9, each caught by at least one test.
- Pairing/trust regression suite after step 3: 121 files, 2714 tests pass.

## Step 5: wiring (added 2026-10-14)

- `ThreadlineClient.sendInviteControlToKey` (encrypted to any key whose fingerprint matches) and `sendInviteControlPlaintext` (the accept). A narrow exception in `handleIncomingMessage`: a plaintext envelope typed `pair-invite-*` from a sender whose keys are cached goes to the unknown-sender path, not `decrypt-error`. Every other undecryptable message behaves as before.
- `InboundMessageGate`: the four invite ops are trust-level-exempt control-plane messages under the same replay check as `pair-verify`. They are dispatched to `onInviteControl` and never routed onward. Only when verified pairing is enabled.
- `ThreadlineBootstrap`: builds the store and engine, and the pinned-key resolver also returns the key for `invite-accepted` (so B can decrypt the finish). **Found by the production-path E2E:** a plaintext invite op from an unknown sender went to `handleRelayUnknownSender`, which routes to the router as ordinary text and could spawn a session. Invite ops now go to the gate before that point.
- `markInviteVerified` records the same pairingId v2 uses (HKDF over both identity keys), so CredentialShareGate's own-key-rotation check (check 3) applies to invite pairings too. Without it every credential to an invite pairing was refused (`encryption-key-not-bound`), also found by the E2E.
- Interactions: an untrusted peer's invite op is no longer routed as a conversation message, an improvement. A peer whose verified pairing is `invite-accepted` can now be decrypted via the pinned key, the same as `pending-verification` already was.
- Evidence: `tests/e2e/threadline/pairing-invite-production-path.test.ts` (real bootstrap + in-process RelayServer): invite → plaintext accept → finish → ack → credential both ways. Breakages: the resolver without invite-accepted, and the gate without dispatch, each fail it. Regression suite: 139 files, 2893 tests pass.

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action` — closure **n/a** (negative declaration). The only repeated action this change adds is the finish send in `PairingInviteFlow.sendFinishWithRetry`. It starts only when an operator approves Finish, sends at most 5 times over about 10 minutes, and stops on the peer's ack. It is not self-triggered and cannot re-arm itself. Covered by `tests/unit/threadline/PairingInviteFlow.test.ts` ("finish retries are bounded (5)").
