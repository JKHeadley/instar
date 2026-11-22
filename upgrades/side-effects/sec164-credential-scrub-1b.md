# Side effects: live keys are masked in new incoming messages, with a one-tap resend notice for team members (SEC-164 part 1b)

Spec: `docs/specs/credential-scrub-at-rest.md` §3.5 and §4.5 (converged, approved under option A, Chief of Staff 3d4ab7c7; split per 19aa907f). Stacked on part 1a (PR 3621).

## What changes for running agents

Only when `security.credentialScrub.enabled` resolves on (dev-gated: on for the development agent, off on the fleet). With it off, every path below returns the text unchanged and sends nothing.

- **One masking object** (`src/server/inboundCredentialNotice.ts`) built in `createRoutes`, over `maskInbound` (`src/messaging/inboundCredentialMask.ts`) and the shared detection from part 1a. Every key masks to `[credential removed]`.
- **Telegram, lifeline forward** (`routes.ts` forward handler): masked before `normalizeForwardedInbound`, so the travelling text, the history form, the trust-account receipt, `logInboundMessage` (and the authorship hash it feeds), the exactly-once ledger and the session all see one masked text. The session's message content gets a one-line note. A team member gets the fixed notice after `onTopicMessage`, unless the inbound gate refused the message.
- **Telegram, server polling** (`TelegramAdapter.processUpdateDelivered`): text and caption masked right after the pairing-code scan, before the trust-account receipt and the unknown-user path. Voice transcripts are masked right after transcription.
- **Slack** (`SlackAdapter._handleMessage`): masked right after the subtype check, before the trust-account receipt, dedup, the ring buffer, the auth gate and the session; history recovery replays come through the same function. Team: an authorized user, never a bot, and never a user whose `user_team` differs from the event's `team` (Slack Connect).
- **WhatsApp and iMessage**: masked at the top of `handleIncomingMessage` and after the sender checks in `_handleIncomingMessage`, before the log and the event bus. No notice on these channels in part 1.
- **App ingress** (`mobileConversationRoutes`, `mobileSlackRoutes`, `mobilePairingRoutes`): after the device signature, masked before `removeAuthorityTokens`; the kinds join `removedKinds`, so the signed record carries a redaction attestation and the raw body is not kept. Media file names and transcripts follow the switch (`maskCredentials` on the preflight), server transcripts follow it (`credentialScrubEnabled` on `AppConversationService`), and the read path (`transcriptForDelivery`) always masks, because it only shows text.
- **App to a Telegram topic**: the route passes `credentialRemovedKinds` to the inbound core, which then sends the notice to the owner or team member.
- **Lifeline down**: `MessageQueue.enqueue` masks before writing the queue file and records the kinds (never values) in `credentialRemovedKinds`; the replay sends them, and the server accepts them only from a lifeline-proven forward or the in-process app route, and sends the notice. The dropped-messages record and the Slack lifeline queue mask too. The switch is read fresh for each message.
- **Between the agent's own sessions** (`MessageRouter.send`): subject and body masked before the envelope is saved or signed. A queued envelope is never rewritten.
- **Agent-to-agent, outgoing** (`POST /threadline/relay-send`): the message is masked where the route reads it, so the local route, the relay send, the thread log, the outbox and every mirror carry the masked text. The one exception is from the Chief of Staff (c835d801). A send that the credential-share gate itself allowed carries the raw text, only on the pinned encrypted send. To be allowed, the send must be marked as a share and the gate's own decision must find a verified paired recipient with the encrypted path. Our own records still hold the masked text. The caller's flag alone never unmasks anything. `credentialShareGateAllowed` is set only on the gate's allow branch.

## The notice

Fixed server wording from `teamMemberNotice`, sent once per message per process (a bounded set keyed by channel, conversation and message id). The link is a fresh Secret Drop request (`mintAuth: 'master'`, bound to the Telegram topic) using the tunnel address; with no tunnel, the notice says to try again in a minute. Team rule: the owner id, or a person `UserManager` resolves from the Telegram id; never a forward, a chat post, a bot or `via_bot`. Unreadable team data means only the owner counts. A wrong answer costs one notice at most, because nothing is saved.

## Known limits and open items

- **Native app conversations get no notice or session note yet.** The app conversation store has no server-written message path; adding one goes beyond this slice. The stored record and the session both see the masked text, and the attestation records the removal. This is tracked as the first item of slice 1c.
- Inbound agent-to-agent is part 2, as the spec says.
- **The Slack lifeline queue masks but does not carry the kinds**, so a Slack team member whose message was queued while the server was down gets no notice after the replay. The text is still masked. The Telegram lifeline does carry them. This is tracked for slice 1c.
- **The session note lands in the stored text on the polling, Slack, WhatsApp and iMessage paths** (their maskers return the text with the one-line note). The forward handler keeps the note out of the logged text. The note holds no key, and it is the same on replay.
- **A Slack resend link is not tied to a conversation** (Secret Drop binds only Telegram topics). Anyone who sees the notice in a shared channel could submit a value to it. A submission lands in the vault under the fixed label and can only add a value, never read one, so the risk is low.
- Telegram edited messages are not handled anywhere in the adapter or the lifeline today, so there is nothing to mask. Slack edits are skipped by the subtype check, as before.
- A replayed queue entry has lost its forwarded flag, so a forwarded owner message replayed from the queue may draw one notice. The cost is one message.
- A non-key that matches a wall pattern loses those characters. This is the accepted residual in §4.5.

## Signal vs authority

Masking changes stored text and never refuses or holds a message: every failure delivers unchanged (`maskInbound` falls back to patterns only, then to the original), as the operator-channel standard requires. The notice is information only. The removed-kinds field on a forward can only cause a notice; it never changes text and grants nothing, and only a lifeline-proven forward or the in-process app route may set it.

## Rollback

Set `security.credentialScrub.enabled` to false (read live, within the reader's short cache). Text already masked stays masked by design.

## Second-pass review

**Reviewer:** Claude Sonnet (independent subagent), which read the full diff and the real code paths and ran the new unit tests.
- **Round one: CONCUR, no blocking defect.** It confirmed that no way in stores, logs, hashes or hands raw text to a session before the mask, and that no stranger, forward, bot, unverified lifeline caller or app device can trigger a notice or set the removed-kinds field. Every failure delivers the text unchanged, and authorship, replay identity and app signed-origin verification hold.
- It left six non-blocking notes. The empty-id dedupe is fixed, with a test. The Slack lifeline kinds, the session note in stored text and the Slack link scope are recorded above. The per-call `UserManager` is accepted, because it is built only when a key was removed. This line was filled in.
- **Round two: CONCUR, no blocking defect.** It covered the outgoing agent-to-agent masking, added after round one on the Chief of Staff's decision. It confirmed that `rawMessage` is read only by the mask and by the pinned send. The flag is set only on the gate's allow branch. With verified pairing off, the send goes through the masked path, and a standby never forwards a share. Its non-blocking gaps: a test for verified pairing off was added (case d). A share to a same-machine agent never takes the plaintext local route (5c), so it goes through the gated pinned send or is refused; it is never sent raw anywhere else. No test asserts the thread log's text directly; the log takes `message`, which is the masked text.

## Tests

- `tests/unit/sec164-inbound-mask.test.ts` (new, 28 cases), covering masking, replay identity, the team rule, the notice (sent, once, no link, failure reported), the lifeline queue on disk, and source-order checks for every way in (forward handler, polling, voice, Slack, WhatsApp, iMessage, app ingress, router, lifeline replay, dropped messages, Slack lifeline).
- `tests/integration/threadline-verified-pairing-wiring.test.ts`: four new cases (not run on this machine; Local Verify is their first run). An unmarked send containing a key is masked even to a verified paired agent. A credential share the gate allows carries the raw key on the pinned send only. A share the gate refuses sends nothing. With verified pairing off, a marked share is masked like any other.
- `tests/integration/mobile-native-signed-records.test.ts`: a new case shows a signed app message with a key is stored masked, reads as redacted, and the key is in no file on disk.
- Unchanged and passing: forwarded-inbound-media, pairing-invite-never-persisted, telegramForwardHandshake, slack-message-dedup, TelegramAdapter-dispatchAgentMessageHook, MessageQueue-durability, droppedMessageNotify, message-router, ephemeralCredentialCommand, a2a-local-route-signed-envelope, app-conversation-identity, mobileConversationListPaging, mobile-slack-from-app, app-conversations-pool, mobile-media-to-platform, app-voice-transcript-event, sec164-credential-spans.

## Class-Closure Declaration

- **unbounded-self-action: n/a.** The team-member notice is one fixed message per incoming message from a person, deduped by channel, conversation and message id. It is never retried, re-driven or scheduled, and nothing the agent does itself triggers it. The lifeline replay was already bounded by its existing poison and transient budgets; this change only adds a field to it.
