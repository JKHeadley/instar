# Side-Effects Review — Pairing reports back to both sides (handshake, notices, same-owner Finish)

**Version / slug:** `pairing-both-sides-report`
**Date:** `2026-10-20`
**Author:** `Dawn`
**Second-pass reviewer:** `independent reviewer sub-agent (Phase 5), 2026-10-20: concern raised, resolved, then concurred on re-review; Echo reviews the branch before it is pushed`
**Spec:** `docs/specs/a2a-pairing-invite-link.md` §11 (r4 amendment, approved: false — see "Approval status" below); `docs/specs/threadline-standalone-pairing.md` §7 step 7 (r6, approved: false).

## Approval status, stated plainly

The spec's frontmatter carries `approved: true` for r3. The r4 amendment (§11) that this code implements says `approved: false` in its own section and in `amendment-r4`. This branch is committed and **not pushed**: Echo reviews §11 and the code together, and Justin approves §11, before it is pushed or merged.

## Summary of the change

On 2026-10-20 Justin paired PP and Echo: he tapped Approve on Echo, Echo said "waiting for the other side", and nothing else happened on either side. A reproduction on 1.3.1364 found five silent spots: refusals in `handleAccept` only `console.warn`ed; the accept was fire-and-forget with no relay verdict recorded; the inviter's Finish prompt went to the Lifeline topic (silent return without one, empty `catch {}`); only the acceptor ever said "Paired"; nothing reported expiry or a stall.

1. `packages/threadline-core/src/handshake.ts` (new, no imports) and its byte-identical Instar copy `src/threadline/pairingHandshake.ts` (core 0.1.0 is pinned from npm and lacks it; same precedent as `encryptedSeenMark.ts`). `PairingHandshake` wraps the unchanged core engine through its injected deps (`sendPlaintext`, `sendToKey`, `notify`) and its public methods:
   - the accept gains `hs: 1` and is resent (10 s, 30 s, 70 s, 150 s, 270 s) until the inviter answers;
   - the inviter answers every attributable accept (`hs: 1`, `fpB == first16(idB) == sender`) with a signed `pair-invite-received` or a signed `pair-invite-refused` (seven reasons; malformed/bad-tag/bad-signature/rate-limited accepts stay silent on the wire);
   - after Finish (inviter) and the verified finish (acceptor) each side sends a signed `pair-invite-hello` encrypted to the pinned key; `paired` is emitted only when the peer's hello has arrived; resends bounded; `no-hello` after 5 min, pins never undone;
   - timeouts (`no-answer`, `not-finished`, `no-hello`) and `invite-expired` on both sides;
   - `preauthorizeFinish(iid)`: an operator act that makes the first VALID accept finish without the prompt;
   - `pairingNoticeText()`: one plain sentence per notice.
2. `src/threadline/ThreadlineBootstrap.ts`: builds the handshake between engine and transport, routes inbound invite control through it, logs the relay verdict for every invite control message (`awaitRelayAck`, 15 s), emits notices as `'notice'` on the existing events emitter, `pairingHandshakeTimings` test hook, `dispose()` on shutdown. The unknown-sender intercept and `InboundMessageGate` use the 7-op set (`ALL_PAIRING_OPS`).
3. `src/threadline/PairingInviteTelegram.ts`: notices become messages in the invite's own topic (forwarded-into for the acceptor; posted-in for the inviter, learned from `/telegram/reply` or the create route's `topicId`), else Lifeline; no topic or a failed send goes to `reportUndelivered` (wired to `DegradationReporter`, feature `Threadline.pairingNotices`) instead of a silent return / empty catch; the engine's `paired` event is no longer announced (the handshake's is); the "It's one of my agents" button (`own-agent` step, same §6.1 tap checks).
4. `src/threadline/PairingTopicStore.ts` (new): `threadline/pairing-topics.json`, 0600, iid → topic, no secret, pruned 48 h after expiry.
5. `src/server/routes.ts`: operator acts go through the handshake; `topicId` on `POST /threadline/pairing/invites`; `POST /threadline/pairing/invites/:iid/own-agent` (PIN); `/telegram/reply` notes an outbound invite after a successful send; `GET /threadline/pairing/invites` gains `handshake` (secret-free session view).
6. `dashboard/pairing.js`: "It's one of my agents" on an open invite (PIN; the PIN row appears for it), approve/finish confirmation text.

## Decision-point inventory

- Inviter answers an accept with a receipt or a refusal — **add** — only to attributable accepts carrying `hs: 1`; rate limited.
- Acceptor accepts a receipt / refusal / hello — **add** — only when signed by the pinned key over the exact fields, for an invite it has a session (or store record) for.
- `paired` notice — **add** — only when own pin is `mutual-verified` AND a valid peer hello arrived (or the peer did not offer `hs`, worded as unchecked).
- Auto-finish of a pre-authorized invite — **add** — only for an invite pre-authorized while `open` by a verified operator tap or PIN; the engine's own Finish checks (decided once, no second accept) still apply.
- `InboundMessageGate` invite-control classification — **modify** — three more `pair-invite-*` ops are control-plane (never routed to a session).
- Engine accept/finish/ack/used validation — **pass-through**, unchanged.

---

## 1. Over-block

- An accept from an agent that does not send `hs: 1` (any older Instar or `threadline-mcp`) gets no receipt or refusal, exactly as today. That is deliberate: those agents would treat the new ops as ordinary messages.
- A refusal whose `exp` differs from the acceptor's record (non-empty) is dropped. The inviter always signs the invite's own `exp` or an empty one, so only tampering produces a mismatch.
- A receipt or refusal arriving after the acceptor restarted is dropped (no session; receipts are not rebuilt from the store). The finish and hello are rebuilt from the store, so a restart costs at most a missed "got it" line.
- After a restart, a side whose pairing was already complete answers the peer's hello but does not announce `paired` again (§11.4), so if the restart happened between its own finish and the peer's hello, its operator is not told "Connected ✓" by this side (the other side still is). Accepted: the alternative lets a replayed old hello produce a fresh "we've each checked" line.

## 2. Under-block

- A relay can strip `hs: 1` from an accept or finish. Result: that pairing runs the old way, and `paired` says the other agent looks older ("couldn't check we can talk"). It cannot create, alter or block a pairing.
- The hello shows the pinned keys work end to end through the relay at that moment; it does not show that later ordinary chat will be delivered (a peer can go offline afterwards).
- A refusal is not bound to one send of the accept, so a relay can replay an old genuine refusal. It cannot outlast a real pairing: a verified finish always wins and the operator is then told `finish-received` and `paired` (§11.5).
- An attributable accept naming a known `iid` with a wrong tag is told `expired`/`revoked`/`unknown-invite` (the engine checks invite state before the tag), revealing only the state of an invite whose id the sender already has (the relay sees every `iid`). Operator notices for refusals are limited to one per invite.
- Same-owner pre-authorization (§11.6) does not prove the approver on the other agent is the owner; a leaked pre-authorized invite pairs an impostor until the owner's agent also uses it (alarm, pause) or the owner unpairs. Stated in the spec's threat model and open question Q1.

## 3. Level-of-abstraction fit

The protocol rules live in threadline-core (D0: fundamentals in Threadline), injected and import-free so `threadline-mcp` can use the same module. The engine (`PairingInviteFlow`) is untouched and pinned at 0.1.0; the handshake wraps it through the dependency points the engine already exposes (its transport and notify callbacks), so no engine change is needed to ship. Instar only does Instar things: Telegram topics, the dashboard, degradation reports.

## 4. Signal vs authority compliance

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [x] Deterministic cryptographic checks only: accepting a receipt, refusal or hello is an Ed25519 verification against a pinned key over fixed fields. That is an invariant, not a brittle heuristic; a false "no" only means a notice is not shown (the pairing state is unaffected). The one new authority (auto-finish) is an operator decision made earlier, recorded only from a verified operator act.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The timers (5 min, the resend schedules) are fixed constants from the spec, with open question Q3 asking whether they should be longer for agents that sleep; they decide only when to tell the operator, never a pairing outcome.

## 5. Interactions

- **Shadowing:** the handshake runs the engine first for every inbound op and only adds behaviour after the engine's verdict; it never skips an engine check. The engine's own Finish retry (5 tries) and ack are unchanged.
- **Double-fire:** the engine still emits `paired` (pin recorded); the Telegram layer no longer announces it, so the operator sees one "Connected ✓". The dashboard approve/finish routes and the Telegram taps both go through the same handshake methods, so each emits one `approved`/`finishing` notice. The agent itself may also tell its person "I'm connected" (template step 6): a duplicate line, harmless.
- **Races:** a hello can overtake the finish (it is kept); a pre-authorization recorded after the accept was recorded as used is refused (the prompt is already out). One window remains and is stated in §11.6: a pre-authorization made while the first accept is still being checked (`await relayKeyFor` inside the engine) applies to it; the owner had seen no prompt yet, so that equals making it a moment earlier. A second VALID accept on a pre-authorized invite is handled by the engine's alarm path and never auto-finished (unit test). A failed automatic finish shows the ordinary Finish prompt (unit test).
- **Feedback loops:** a hello answer is sent at most once a second and at most 6 times per pairing (a replayed hello cannot drive sends without end); hello resends stop on the peer's `seen=1`; rate limits on receipts/refusals (5 s per sender per invite, 10 per minute per sender; operator decisions skip the 5 s gap only). Bookkeeping maps are pruned past 1000 entries.
- **Verified pairing off:** the three new ops are dropped as control messages in `InboundMessageGate` even when `threadline.verifiedPairing` is off, so a hello from a trusted peer never reaches a session as text. The four original ops keep their existing behaviour.

## 6. External surfaces

- **Other agents:** three new wire ops, sent only to agents that set `hs: 1`. Mixed versions pair as before.
- **Telegram:** more messages per pairing (approved, reached, got it, finished its side, Connected ✓), in the topic where the invite lives instead of Lifeline. One new button next to an invite the agent posts (only when Telegram approval is on).
- **Persistent state:** `threadline/pairing-topics.json` (0600, no secret). Nothing else new on disk; sessions and pre-authorizations are in memory.
- **Operator surface (Mobile-Complete):** every new operator act has a phone surface: the Telegram button and the dashboard button (PIN).

## 6b. Operator-surface quality

1. **Leads with the primary action?** The new button sits on the open-invite row beside "Cancel it"; the waiting decisions stay at the top of the card unchanged.
2. **Zero raw internals as primary content?** Yes: the row label is the invite's short id and time left, as before; the button text is plain ("It's one of my agents").
3. **Destructive actions de-emphasized?** "Cancel it" stays a quiet button; the new button is also quiet (it is optional).
4. **Plain language + phone width?** Plain words; buttons wrap in the existing `pair-row` flex row at phone width (no new layout).

## 7. Multi-machine posture

**Machine-local by design.** The invite store and the handshake sessions live on the machine that holds the relay connection, which is the only machine that sends and receives pairing ops (standalone D11: the invite store is machine-local; a moved relay makes the accept "unknown", which now produces a signed `unknown-invite` refusal instead of silence). `pairing-topics.json` annotates that store, so it is machine-local too. Notices go through the Telegram adapter of the machine that holds the relay; no other machine emits them, so there is one voice. No URLs.

## 8. Rollback cost

Pure code change. Revert and ship a patch. `pairing-topics.json` is ignored by older code. Peers that already speak `hs` keep sending the new ops to a rolled-back agent only for pairings that were in flight; a rolled-back agent's gate would no longer list those ops as control messages, so revert the gate change last (or keep it) to avoid them reaching a session.

## Conclusion

The second-pass review found two blocking defects, both fixed with tests: a refusal was sticky (a later verified finish was ignored, so the acceptor's operator kept "Nothing was paired" while both pins were verified; a relay could cause it by replaying a refusal), and a failed automatic finish left the owner with neither a prompt nor a notice. Its seven minor points were also fixed: no second announcement from a rebuilt session, a cap on hello answers, honest refusal wording and one notice per invite, deadline timers that re-arm instead of overflowing `setTimeout`, the race window stated, pruned maps, and the new ops dropped when verified pairing is off. Building the core package found one more: with no delivery verdict available, the operator was told "couldn't get my approval" before "Approved" (unknown was reported as failure); unknown now says nothing. Earlier, the review led to two design choices visible in the code: new ops only to peers that offer `hs` (the gate on an older agent does not classify them as control), and operator decisions (Not them, cannot-finish) skipping the per-invite reply gap so a refusal right after a receipt is not swallowed (a unit test caught it). Clear to hand to Echo for review together with §11; not to be pushed before §11 is approved.

## Second-pass review (if required)

**Reviewer:** independent reviewer sub-agent (instar-dev Phase 5), 2026-10-20.
**Independent read of the artifact: concern** — resolved:

- Blocking 1, a refusal blocks every later outcome (handshake `onFinish`/`onReceived` returned early on `s.refused`): a verified finish now clears the refusal and continues (§11.5 updated). Tests: "a verified finish wins over an earlier refusal", plus mutant `refusal-sticky`.
- Blocking 2, a failed auto-finish is silent: the held `finish-prompt` is forwarded. Test and mutant `auto-finish-fail-silent`.
- Minor 3, a rebuilt session re-announces on a replayed hello: rebuilt-for-hello sessions are marked announced; rebuilt-for-finish runs normally. Tests for both.
- Minor 4, unbounded hello replies: capped at 6 per pairing. Test and mutant `hello-reply-uncapped`. The Class-Closure line is corrected.
- Minor 5, the refusal oracle and notice wording: spec and artifact corrected; one notice per invite; "couldn't tell it why" when not told. Tests and mutants `notice-claims-told`, `notice-per-sender`.
- Minor 6, `setTimeout` overflow on a far `exp`: deadline timers re-arm (clamped to 24 h steps). Test and mutant `timer-no-rearm`.
- Minor 7, the pre-authorization race: stated in §11.6 and above.
- Minor 8, unbounded maps: pruned past 1000 entries.
- Minor 9, new ops with verified pairing off: dropped as control. `tests/unit/InboundMessageGate-pairing-handshake-ops.test.ts`, mutant `gate-handshake-off-passes`.

Re-review of the fixes (same reviewer): **concur**. Three further minor notes: (1) "I told it why" could be false when the rate limit held the refusal; fixed, the notice now uses whether the refusal was actually sent. (2) A side that restarts between its own finish and the peer's hello stays silent (and loses its no-hello timer); kept as a stated limitation, and raised as spec §11.10 Q3 (record "announced" in the store?). (3) One refusal notice per invite can be used up by a prober that knows an `iid`; the cost is now stated in §11.5.

## Review on the Studio (Echo, 69f8f595d) and the fix

Echo found `pair-invite-hello ... refused: bad signature` in the e2e "the inviter restarts between the accept and the Finish"; the test passed only because it checked the pins. Splitting the exp check from the signature check (distinct refusal reasons now) showed the real cause: **the acceptor's hello carried an empty `exp`**. That test drives the engine's `approveAccept` directly, so the handshake's approve context (which held the invite's `exp` and claimed name) was absent when the accept was sent, and the acceptor's session was created with `exp: ''`. The restarted inviter rebuilt its session from the store with the real `exp`, so every hello from the acceptor named a different expiry and was refused. Not a format mismatch: both sides hold the same ISO string; one side held none. Reproduced in a unit test before the fix ("hello names a different invite expiry (none, this side holds 2026-10-20T21:00:00.000Z)"). Reproduced on the e2e at 69f8f595d with only the exp check split out: `pair-invite-hello from 2338ed8a8385 refused: … peer="" mine="2026-10-21T13:28:44.303Z"`. The same empty `exp` made the acceptor refuse the inviter's receipt before the restart (`pair-invite-received from 166cb995f08d refused: bad signature`).

A second, separate defect on the same path: after a restart the inviter's `finish()` built a session with `peerHs=false` (the accept's `hs` flag was lost), so it announced `paired` unchecked at once and sent no hello, while the acceptor, which got a finish with `hs: 1`, did send one.

Fixes: (1) the acceptor's session takes `exp` and the claimed name from the engine's own waiting list when there is no approve context; (2) a session rebuilt by a post-restart Finish marks `hs` as unknown and waits up to 60 s (`unknownPeerHelloWaitMs`) for the acceptor's hello before reporting unchecked, so a current acceptor reaches `paired` checked on both sides. Tests: unit "the INVITER restarts…", "…acceptor is an OLDER agent…", "the engine driven directly…"; the e2e now drives Finish through the handshake (as every production surface does), asserts both sides `paired` with `checked: true`, and asserts no hello was refused. A new unit case pins the split itself: a hello or receipt correctly signed over a different expiry (same ISO format, 1 ms apart) is refused as "different invite expiry", one with the right expiry under another key as "bad signature", and the right key over the right expiry is accepted.

Mutation check (applied to core and the Instar copy alike, each killed): merging the hello exp check back into "bad signature"; the same for the receipt; removing the waiting-list fallback for `exp` (also kills the e2e restart case); not marking `hs` unknown on a post-restart Finish (also kills the e2e restart case); the `hs-wait` timer never reporting; removing both second-accept guards.

Echo's cheap insurance: a unit test asserts that a second accept never produces a `pair-invite-received` to anyone. With the clock moved past the reply gap, removing both guards on that path (`secondAccept` and the acceptor-fingerprint check) is killed; either one alone survives because the other covers it. The `resend-after-answer` guard is kept, with a comment that it is defence in depth (every answer path disarms `resend`, and `approveAccept` is synchronous).

## Evidence pointers

- `tests/unit/threadline/pairing-handshake.test.ts` (core and the Instar copy, real engine/stores/keys, manual clock): 37 cases per implementation plus the byte-identity check (75).
- `tests/unit/threadline/PairingInviteTelegram-notices.test.ts`: topic routing, fallback, degradation reports, own-agent offer and tap checks, topic store.
- `tests/unit/dashboard-pairing-panel.test.ts`: the own-agent button needs the PIN.
- `tests/e2e/threadline/pairing-handshake-production-path.test.ts`: two real agents on a real relay: Approve → immediate line → both "Connected ✓" after the hello; a refusal → both told; Not them → acceptor told; timeouts on each side; same-owner with no Finish tap.
- Mutation results: in the commit message.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect is fixed. The change adds bounded self-triggered sends: the accept is sent at most 6 times (first + 5 resends, stopped by any answer); a side sends at most 6 scheduled hellos plus at most 6 hello answers per pairing; receipts and refusals are rate limited (5 s per sender per invite, 10 per minute per sender). No send is triggered by its own output, so the loop settles within those bounds.
