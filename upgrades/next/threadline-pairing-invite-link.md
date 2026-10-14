# Verified pairing by invite link (replaces the 12-word comparison)

## What Changed

The 12-word check in verified pairing v2 asked a person to read 12 words, compare them across two screens, and type all 12. Justin tried it on 2026-10-13 and rejected it as unsustainable. This adds pairing by invite (spec: `docs/specs/a2a-pairing-invite-link.md`, approved by Echo):

- An agent makes an invite: one `tlinv1:` code carrying its identity key and a one-time secret, valid for 1 hour by default (24 h maximum), single use. When the invite is for a peer the agent already knows, it is bound to that peer.
- The other agent's operator approves it. The accept proves possession of the secret (an HMAC over a transcript of both keys) and of its own identity key (an Ed25519 signature). It travels as a plaintext relay message, because the inviter cannot decrypt before it knows the acceptor's key, and it carries no secret.
- The inviter's operator finishes it. The signed finish and ack travel encrypted to the pinned keys, and both sides become `mutual-verified`. Credentials then work exactly as in v2 (encrypted to the pinned key), restart-safe.
- Both ends compare the key in the invite or accept with the key the relay presents, and refuse on any difference.
- If a second, valid accept arrives for a used invite (the invite leaked), the first acceptor is paused (new state `invite-accepted`, not credential-eligible) even if the inviter already finished. The inviter gets an alarm, and the late acceptor gets a signed "already used" notice.
- New pairing state `invite-accepted`: the key is pinned but cannot receive credentials yet.

How operators use it:
- Routes: `POST /threadline/pairing/invites` (make), `GET` (list, plus invites waiting for this operator), `DELETE /:iid` (cancel), `POST /inspect` (read one you were sent), and `POST /:iid/approve`, `/finish` and `/not-them`, which need the dashboard PIN. The agent's Bearer token alone can make, list, cancel, inspect and decline, none of which grants anything.
- Telegram: forwarding an invite to the agent opens Approve/Decline buttons, and Finish/Not-them prompts arrive in the lifeline topic. A tap counts only from the owner, through the lifeline (its secret), while the lifeline ingress guard enforces. The invite's secret never reaches a session, the message log, the lifeline's disk queue or any classifier.
- Dashboard: the Threadline tab opens with a "Pair with another agent" card. Decisions waiting for you come first and are counted on the tab. You can make and copy an invite, cancel unused ones, and paste one you were sent. The PIN is asked once per page, nothing resets while you use it, and the page offers a reload when the server is updated. The 12-word panel is gone.
- MCP: `threadline_pair` gains `action: "invite"`.
- Existing agents' CLAUDE.md pairing section is replaced in place with the invite flow.

Still dark behind `threadline.verifiedPairing.enabled`.

## What to Tell Your User

Pairing with another agent no longer means reading and typing 12 words. Your agent makes a short invite you send to the other person however you like. They forward it to their agent and tap Approve, and you tap Finish. If anyone else got hold of the invite and used it first, you're warned and that agent is paused before it can receive anything.

## Summary of New Capabilities

- Pairing by invite: create, accept, finish, with an alarm and a pause on a second accept.
- Pairing state `invite-accepted` (pinned, not credential-eligible).

## Evidence

- Unit: `PairingInvite.test.ts` (15), `PairingInviteStore.test.ts` (7), `invite-trust-states.test.ts` (8), `PairingInviteFlow.test.ts` (15).
- E2E on the real bootstrap + in-process relay: `tests/e2e/threadline/pairing-invite-production-path.test.ts`, from invite to a credential each way.
- More tests: routes, Telegram and dashboard (`tests/integration/pairing-invite-telegram-routes.test.ts`, `tests/unit/pairing-invite-never-persisted.test.ts`, `tests/unit/dashboard-pairing-panel.test.ts`), and failure paths on the production path (`tests/e2e/threadline/pairing-invite-failure-paths.test.ts`).
- Deliberate breakages in a scratch tree: 55 checks removed one at a time across the build (4, 5, 4, 9, 2, 7, 10, 8, 3, 3 by step), and each fails a test.
- A person's walkthrough of the whole flow through the real dashboards on two agents built from this code, including a reload partway through. It found four UX defects, all fixed before release.
