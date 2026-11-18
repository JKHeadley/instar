# Side-Effects Review — Trust journey stage 0, PR B: the account path

**Version / slug:** `trust-journey-stage0-b`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `independent security review subagent (see below)`

## Summary of the change

Spec: `docs/specs/trust-journey.md` (approved by Justin, telegram 142440, 2026-11-15 22:15 PST), stage 0, decision 5 and sections 2, 6 and 6a. Second of three stage-0 PRs, stacked on PR A (#3222), which made every widening need an `OperatorProof` and refused all of them because nothing could issue one. This PR adds the one issuer: the account path.

- The agent opens an exact request (`POST /trust/requests {change}`). The server writes the card from structured data, with a six-character code, and sends it into the owner's own direct chat (Telegram private chat with the bot, or a Slack DM). The first time, it sends the acceptance statement instead, which the person sends back unchanged; the card follows.
- Only a platform receipt counts: on the lifeline path, a forward the lifeline itself verified with its secret (not the server's own re-forward, not a bypass, not an unarmed guard) from a private chat whose id is the sender's own; on the server-poll path, a message read from Telegram's own `getUpdates`; on Slack, a DM thread reply that reached the Socket Mode handler. Mobile inbound, lifeline replays, mesh redelivery and every internal route never count. The reply must be `approve <code>` (any other text approves nothing and is answered once), a platform reply to that card's message, from the owner id read from config no route writes, under a current acceptance, unexpired, and its single-use key (Telegram `update_id`, now forwarded by the lifeline; Slack channel+ts) unused.
- The holder sends a threaded "recording" reply (no unthreaded fallback), records the consumption durably, issues the proof, applies the exact change through its owner (each applier re-checks that the proof covers that change), and replies with the disclosure ("approved from your account, which your agent can also use; this does not prove who approved").
- A new replicated store, `trustJourney` with kind `trust-grant-record`, holds requests, receipts, acceptances, consumptions and the durable trust change log. Forced on wherever the coherence journal runs; where it does not, a local append-only fsynced file is the store. An emitter answer other than `emitted` is a failed write.
- Proof check at load: each stored trust level is compared with the committed change log; a level wider than the last committed change, a raise with no recorded consumption, or a key with a record this build cannot read (the `minReader` reader rule) is restored to the stricter level, and the owner gets one notice. It never widens and never removes a restriction.
- A console feature toggle whose setting is refused as a raise opens the matching request.
- The lifeline keeps `approve <code>` out of its outage queue (a replay could never approve) and says so in the chat.

Size: 5 new modules (`src/core/trustJourney/`), edits to 15 source files, 6 new test files. Tier 2.

## Decision-point inventory

- **Does this receipt approve this request?** `invariant`: deterministic over structured fields (adapter, sender id, chat id and type, reply-to id, the exact command, code, expiry, single-use key, acceptance). A reading of words never approves (spec section 2: natural-language replies come only in stage 3).
- **Is this inbound message offered to the account path?** `invariant`: lifeline-verified (or read from the platform itself) and a private chat whose id is the sender's own. Anything not claimed continues to normal routing.
- **Load-time restoration.** `invariant`: compares levels against the committed log; it can only narrow.

## 1. Over-block

- A person who has not opened a chat with the bot cannot receive the card; the request answers `undelivered` and nothing is approvable until they do.
- A reply typed as a new message instead of a reply to the card is answered with the instruction and approves nothing.
- An older lifeline that does not forward `update_id` still works: the single-use key falls back to chat id + message id, which Telegram keeps unique per chat.
- Work board policy approvals are not wired in this PR (the applier answers "the work board is not running"); the per-kind board work is PR C (CMT-1838). Such a raise stays refused, as in PR A.
- Members' approvals are not wired: only the owner approves in stage 0, as the spec's team posture keeps member settings off the board until its member phase.

## 2. Under-block

- An agent that controls its own host can read the lifeline secret and forge a verified forward, or use the owner's account directly. The spec's threat model says so, and the disclosure on every approval says so to the person; the custody work replaces this proof kind later.
- Multi-machine: a non-holder writes the receipt and the holder consumes it from the replicated stream; if the journal is off and more than one machine runs, receipts on a non-holder never reach the holder (fails closed: nothing is approved).

## 3. Level-of-abstraction fit

The rules live in one pure module (`accountPath.ts`), the flow in one service on the holder, persistence in one store, and wiring in one runtime. The adapters only hand over receipts; the trust owners only accept a proof. No parallel gate: PR A's owners already asked for exactly this proof.

## 4. Signal vs authority compliance

The new authority is narrow and deterministic: exact structured matches decide whether a receipt approves, and the change applied is the exact change hashed into the request. It makes no judgment about meaning. Every other path (bearer, PIN, phone, mobile, replay) stays a signal or nothing.

## 4b. Judgment-point check

No competing-signals decision point is added (see inventory).

## 5. Interactions

- Lifeline forward route: the new block runs after the ingress guard and before the desktop-code block; it claims only private-chat messages from the sender's own chat, so topic messages are untouched.
- Telegram server-poll path: the same claim, before pairing invites and auth gating; unclaimed messages continue.
- Slack: DM messages are offered before dedupe; the store dedupes by (channel, ts).
- `AdaptiveTrust` gains a change observer (the change log) and a narrowing-only restore. The coherence journal gains one kind with the same retention and rate settings as the work board.
- Backup includes every origin's `trust-grant-record` files and the local store file.

## 6. External surfaces

- New routes: `POST /trust/requests`, `GET /trust/requests`, `POST /trust/acceptance/withdraw`. The 403 refusal text now names `POST /trust/requests`.
- New messages to the owner's direct chat: the acceptance statement, request cards, threaded replies, and at most one notice per boot when the load check restored a setting.
- The lifeline forward body gains `updateId`; an older server ignores it.

## 6b. Operator-surface quality

No dashboard renderer or markup changes. The person's surface is the chat card: it leads with what will change in plain words, gives one exact reply to approve, says any other reply approves nothing and when it expires, and carries the disclosure. No ids, hashes or JSON are shown except the code.

## 6c. Agent Proposes, Operator Approves

(1) The person approves a server-prepared request; they never construct one. (2) The card text is written by the server from the structured change (`summarizeChange`), never from agent free text, and the hash the person approves covers exactly what is applied.

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated: the `trustJourney` store rides the coherence journal (`trust-grant-record`), forced on wherever the journal runs. The receiving machine writes the receipt; the serving-lease holder consumes it and commits every consumption and change. Where the journal is off, the local file is the store (single machine). The load check runs per machine against the replicated log. Notices: the owner notice is sent only by the machine that restored a setting, once per boot. No URLs.

## 8. Rollback cost

Reverting the code leaves the store records (inert to older builds) and any raise approved through the path in place in `trust-profile.json`. PR A's refusals stay (they are on main first). No migration.

## Conclusion

Built as designed, then hardened by the second-pass review (one must-fix, seven should-fixes, all closed). Release together with PR C.

## Second-pass review (if required)

**Reviewer:** independent security review subagent (general-purpose, Claude Opus 5.5), given the spec and the code, not this artifact; two rounds.
**Independent read of the artifact: concur** (round 2). Round 1 found no way to obtain a proof or an applied raise without the owner's genuine reply to the genuine card, and raised:

- Must-fix (closed): the card could misstate the change (a config patch shown cut at 300 characters; computed widenings not shown; agent-chosen names unquoted, newlines possible). The card now leads with every widening computed from the real settings, shows the whole change (a card too large to show whole is refused), and quotes and cleans agent names (control, line-separator and direction characters rejected); Slack cards are escaped so markup reads literally.
- Should-fix (all closed): a config patch approved after the settings changed now refuses (`basedOn`, the expected revision); two quick replies apply once (the request is claimed before any wait; a write to an existing key fails); used and closed state no longer depend on load order; receipts are pre-filtered before anything is written, so a stranger's DM or the owner's ordinary message is never recorded or swallowed on a non-holder; unreadable restricting records still restrict; the load check no longer skips entries labelled `default`, and checks the autonomy profile too; a raise whose record cannot be written is undone and the reply says so; at most three open requests per person.
- Notes acted on: the lifeline path requires `update_id`; the agent's response never carries the code.
- Left to PR C (CMT-1838), per the reviewer's condition that B and C ship in the same release: keys with no logged history (the legacy import labels them), config and Slack-role state at load, and the work board policy approval. The stage-0 proof "a hand-edited raise is replaced" is claimed only once PR C lands.

## Evidence pointers

- Unit: `tests/unit/trust-journey-account-path.test.ts`, `trust-journey-account-path-service.test.ts`, `trust-journey-proof-check.test.ts`, `trust-journey-store.test.ts` (79 with the profile tests).
- E2E: `tests/e2e/trust-account-path-alive.test.ts` (real AgentServer, real coherence journal through the replicated emitter, restart load check).
- Integration: `tests/integration/trust-account-path-routes.test.ts` (5): the token cannot raise; the card flow raises; no secret, the server's own re-forward, and a group chat approve nothing; a yes in words is answered; a replayed update is a duplicate.
- Live proof on a throwaway agent running this build with a real Telegram test bot (2026-11-16 01:02 PST; record `.instar/lanes/work-front-doors-1114/stage0-prB-live-proof.txt` in the agent home): the account path booted on the replicated store and ran the load check; a direct raise with the token was refused; a request opened and the real Telegram send of the acceptance statement was attempted; a forged approval through the forward route with the token alone was refused (401, no lifeline secret); a change carrying a newline in a name was refused (400); the fourth open request was refused (429); the gate-off toggle's setting was refused; no trust level changed. It also found that an undelivered acceptance statement was reported as "awaiting acceptance"; that now answers `undelivered`, with a unit test.
- Not yet proven live: the genuine owner reply (the acceptance sentence, then `approve <code>` to a real card). The agent cannot produce that reply through the owner's account: the typed Telegram browser route cannot send an exact reply, by design. The test bot is also being polled by another process right now. This needs Justin's one reply to a test card, which is not requested at night. It is the remaining live step before merge.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
