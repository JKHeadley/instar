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

Wire ops (step 5), HTTP routes (step 6), Telegram interception and buttons (step 7), the dashboard card (step 8).

## 6b. Operator-surface quality

The dashboard card follows spec §8 (see Step 8): nothing resets while open, the PIN is asked once, waiting decisions are first with a tab count, and there is a reload prompt. Spec §8.5 (a person doing the whole flow end to end) is step 11.

## 7. Multi-machine posture

The invite store is machine-local (it lives where the relay identity lives). The verified result replicates through the existing pairing replication, and a demotion revokes it on the other machines.

## 8. Rollback cost

The feature is behind `threadline.verifiedPairing`. Turning it off stops all routes. `invite-accepted` profiles are inert, and a code rollback leaves an unknown state string that v2 code treats as not credential-eligible.

## Conclusion

Steps 1–9 are safe to merge behind the flag. The routes are reachable only with `threadline.verifiedPairing.enabled`. Approval needs the PIN, or a lifeline-verified owner tap in enforce mode.

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

## Step 6: routes (added 2026-10-14)

- New routes, registered before `/threadline/pairing/:peerFp` so "invites" is never read as a fingerprint: `POST /threadline/pairing/invites` (make; `ttlMinutes` 1–1440, optional `bindFp`), `GET /threadline/pairing/invites` (the invites without secret or MAC key, plus the recipient's pending accepts), `DELETE /threadline/pairing/invites/:iid` (revoke an open invite), `POST .../invites/inspect` (recipient reads an invite; grants and sends nothing), `POST .../:iid/approve` (PIN), `POST .../:iid/decline`, `POST .../:iid/finish` (PIN), `POST .../:iid/not-them` (PIN). All are Bearer-gated and 503 when verified pairing is off or the machine has no relay identity.
- Authority (spec §6): the Bearer token alone makes, lists, revokes, inspects and declines, none of which grants anything. Approve, Finish and Not-them need the dashboard PIN through `checkMandatePin`, with its shared failure counters and lockout.
- Engine changes found by writing the routes: the inviter now records its operator's decision (`decision: finished|rejected`, set once and persisted), so Finish cannot be repeated or flipped. A second valid accept is recorded on the invite (`secondAccept`), and Finish is refused afterwards: two agents accepting means the invite leaked, and the operator makes a new one. The recipient can list its pending accepts (claimed names, check code, expiry; never the secret; expired ones dropped).
- Write domain: the invite routes are classified `cluster-shared` beside `/start` (WriteDomainRegistry), the same reasoning.
- Server wiring: `bootstrapThreadline` receives `ownerName` (the admin user's name, else the first user's; self-described, shown as "claimed"), and the engine reaches the routes as `ctx.pairingInvites`.
- Over-block: an operator who taps Not-them cannot change their mind on that invite and needs a new invite. Under-block: none new; the routes add no path that skips the engine's checks.
- Evidence: `pairing-invite-production-path.test.ts` scenario 2 drives the whole flow over HTTP on two real agents and a real relay (401 without Bearer, 403 approve/finish without PIN, decided-once 409s, revoked invite refused by the inviter, no secrets in the list). New unit tests for decisions, the second-accept block and the pending list. Breakages: 7 of 7 caught (each PIN check, the decided-once guard in engine and store, the second-accept block, the pending-list expiry, the list's secret stripping). Regression: threadline unit/e2e/integration 185 files, 2949 tests; every test that scans routes.ts, 60 files, 1047 tests; tsc clean.

## Step 7: Telegram (added 2026-10-14)

- `PairingInviteTelegram` (new): one controller for the Telegram surface. A message carrying `tlinv1:` is consumed by `/internal/telegram-forward` right after the lifeline guard and before the emergency-stop sentinel, so the secret reaches no classifier, session, inbound log or topic-intent extractor. An Approve/Decline prompt opens only when the forward was verified by the lifeline secret, the guard ENFORCES, the lifeline is this agent's Telegram ingress, and the sender is the configured owner. Otherwise the reply points at the dashboard and nothing is decoded.
- Buttons carry `pi:<24 hex>`, a one-time token bound to one invite and one step. `/internal/telegram-callback` judges them with the lifeline proof it holds (the adapter never sees them). A tap counts only when verified, enforcing, from the owner and in the agent's chat. A refused tap does not spend the button, so the real owner can still use it. One decision per prompt: using one button spends its sibling. Finish/Not-them prompts go to the lifeline topic, and so do the leak alarm and the "used elsewhere" notice.
- Never persisted: `MessageQueue.enqueue` refuses invite text (the lifeline's on-disk queue), and the lifeline tells the sender to forward it again rather than queueing. The direct-polling adapter path drops an invite before logging or routing it and points an authorized sender at the dashboard. It has no lifeline proof, so it never offers buttons, and a `pi:` tap there gets a dashboard pointer.
- Deviation from §6.1 (stricter): the spec has history store `tlinv1:<iid>` with the secret removed. This writes nothing to history at all. `PairingInviteTelegram.scrub` exists for any recorder that needs the redacted form.
- Over-block: in observe mode (the fleet default until a lifeline has proven itself), Telegram approval is off and the dashboard is the only path. That is the spec's stated behaviour. An invite forwarded while the server is down is not kept, and the sender is told to forward it again.
- Under-block: the boundary is cooperative (spec §6.1 "Honest boundary"). An agent that reads the lifeline secret file, or drives the owner's own Telegram, could approve. The agent's Bearer token alone cannot.
- Interactions: the forward route returns `{ pairingInvite: true }` with 200, so the lifeline shows its usual "✓ Delivered". Other callbacks still reach the adapter unchanged (tested).
- Evidence: `PairingInviteTelegram.test.ts` (16: the authority matrix for prompts and taps, single use, siblings spent, refused taps not spent, observe mode, operator notices). `tests/integration/pairing-invite-telegram-routes.test.ts` (4, real routes with the real guard: an owner forward opens a prompt with nothing reaching a session or the log, a forged tap 401s, a verified tap approves via the engine and never the adapter, a duplicate tap has one effect, a non-owner gets no prompt, observe mode gets no prompt, other callbacks are unchanged). `tests/unit/pairing-invite-never-persisted.test.ts` (2: queue refusal; the direct-polling adapter neither routes an invite nor writes its secret anywhere under the state dir). Breakages: 10 of 10 caught (both route intercepts, each tap condition, single use, sibling spending, button expiry, the queue refusal, the adapter drop). Regression: 325 files, 4744 tests (threadline, lifeline, every Telegram suite, every test that scans routes.ts). The one failure, the silent-fallback ratchet (496 vs 494), was mine: two best-effort catches in the adapter, now marked with their reasons. 494 again.

## Step 8: dashboard (added 2026-10-14)

- The Threadline tab's pairing card is rebuilt around invites and moved to the TOP of the tab (spec §8.3). It has: decisions waiting for the operator first (Approve/Decline an invite they were sent, Finish/Not-them for someone who accepted theirs, and a leak alarm), "Make an invite" (1 h or 24 h) with the invite shown in a read-only box with Copy, a cancel button for each unused invite, a paste box for an invite they were sent, and the list of paired agents in plain words. The 12-word controls are gone (§9): an old `pending-verification` record says to pair by invite instead.
- §8.1, nothing resets while open: only the three list sections refresh (every 10 s), and only when their HTML changed. None of them holds an input. The invite box, the paste box and the PIN field are never rendered by a timer. A likely cause of Justin's resets, from reading the old code (not reproduced): its 30 s refresh skipped only when an input held text, and "Show my words" emptied the PIN field, so the next refresh replaced the whole list, including the words just shown.
- §8.2, PIN once: the first PIN-gated action uses the PIN field. An accepted PIN is held in the module's memory (never storage) until the page reloads, and the field hides. A refused PIN (403/429) is forgotten and the field returns. Cancel and Decline need no PIN.
- §8.3, a count on the tab: the panel now starts at login, not only when the tab opens, so the Threadline tab shows "(n)" for waiting decisions.
- §8.4, a reload prompt: the vital-signs poll (authenticated `/health`, which reports `version`) remembers the first version and shows a fixed "The agent was updated… Reload" bar when it changes.
- The paste box is emptied once the server has read the invite, so the secret leaves the page.
- When this machine does not hold the relay identity, the card says to open the dashboard on the machine that does, instead of claiming pairing is off.
- Over-block: none new. Under-block: holding the PIN in memory means someone at an unlocked, already-used dashboard page can approve without retyping it. The page already holds the Bearer token, and the spec chose one PIN entry per person.
- Evidence: `tests/unit/dashboard-pairing-panel.test.ts` (13, jsdom): the renderers (claimed names, decided and leaked invites ask nothing, the alarm, open invites, no 12-word controls, escaping), the invite box surviving refreshes as the same DOM node, unchanged refreshes re-rendering nothing, typed paste text and PIN surviving refreshes, the PIN asked once and held, a refused PIN forgotten, the paste box emptied, the tab count, cancel/decline without PIN, and the page wiring (the card before the bridge settings, starting at login, the reload bar). Breakages: 8 of 8 caught (re-render only on change, the held PIN, forgetting a refused PIN, the finish-prompt filter, emptying the paste box, the tab count, the no-PIN refusal, the version check). Every test that reads the dashboard files: 19 files, 300 tests pass.

## Step 9: failure paths on the production path (added 2026-10-14)

No production code changed. `tests/e2e/threadline/pairing-invite-failure-paths.test.ts` drives real `bootstrapThreadline` agents over a real in-process relay:
- A leaked invite used by a third agent AFTER the inviter finished: the inviter's first acceptor stops being credential-eligible, the inviter gets the alarm, and the late acceptor is told the invite was used elsewhere and never trusts the inviter.
- An invite edited in transit is refused at the recipient before anything is recorded or sent. An invite made with the inviter's real key that expired an hour ago is refused as expired. The shortest real lifetime is one minute by design, so the test builds an already-expired invite rather than waiting.
- The inviter restarts between the accept and Finish: the same identity comes back, Finish works from the persisted store, and both sides become credential-eligible.
- Breakages: 3 of 3 caught (no demotion on a second accept, no expiry check at the recipient, no save when the invite is used).

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action` — closure **n/a** (negative declaration). The only repeated action this change adds is the finish send in `PairingInviteFlow.sendFinishWithRetry`. It starts only when an operator approves Finish, sends at most 5 times over about 10 minutes, and stops on the peer's ack. It is not self-triggered and cannot re-arm itself. Covered by `tests/unit/threadline/PairingInviteFlow.test.ts` ("finish retries are bounded (5)").
