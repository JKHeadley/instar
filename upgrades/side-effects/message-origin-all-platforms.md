# Side-Effects Review — Message origin on every platform (app, Slack, phone reads)

**Version / slug:** `message-origin-all-platforms`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 2. Spec: `docs/specs/message-origin-all-platforms.md` (3 review rounds, cap 3; cross-model `codex-cli:gpt-6-astra`). Every agent reply in a native app conversation is stored with its origin (machine, harness, model and how each was known) in the same append; every Slack post, edit, ephemeral and file share writes an origin row to `.instar/state/slack-origins.jsonl` before it leaves and is refused when that row cannot be written (a pre-recorded per-conversation notice keeps the agent reachable); the phone's three history reads return `origin` on agent rows with the agent's current display bits; Telegram rows join the existing origin store through one new batched, indexed, read-only lookup. Slack session replies get the same one-line footer Telegram has. New files: `src/messaging/messageOrigin.ts`, `src/messaging/slack/SlackOriginLedger.ts`, `src/server/replyOrigin.ts`. Changed: `SlackAdapter`, `FileHandler`, `routes.ts` (app and Slack reply routes, Telegram topic history, /health), `AppConversationStore` (plus the replicated wire field), mobile conversation and Slack routes, `AgentServer` and `server.ts` wiring, the origin store (index and method), `TelegramOriginService` (`sessionProducer` lifted out of `runWithSessionToken`), the display-settings route, relay scripts and installers, the CLAUDE.md template and migration. Effort: 3 spec rounds; build in one pass.

## Decision-point inventory

- **Slack send refusal when the origin intent cannot be written** — added. Deterministic: the local append landed or not. Scoped to an I/O failure; bad evidence is recorded as `unknown`, never refused.
- **Evidence ladder** — added, evidence only, never a gate.
- **Display bits** — presentation only.

## 1. Over-block

A Slack send is refused when the ledger file cannot be written (disk full, permissions). That refuses legitimate messages in that state, by design (the operator's "ALWAYS recorded"). Bounded: the refusal retries the write on the next send after 5 s, so it lifts the moment the disk does; a pre-recorded notice tells an affected conversation once per process run, only for a refused post, and only if a send to that conversation succeeded earlier in the run (edits, ephemeral messages and file shares get no notice); the operator exception `messageOrigin.recording.slackFailClosed: false` turns refusal into reported pass-through. Any failed ledger write (an intent, a receipt or a reserve) arms the 5-second window for every conversation, because it is the same disk. A test harness or adapter built with an unwritable state directory would refuse every Slack send: the adapter test files touched here pass.

## 2. Under-block

- WhatsApp and iMessage replies record nothing (ACT-023).
- A Slack message whose receipt write failed has a record the phone cannot link (`recorded: null`, `unlinked`).
- `SlackLiveSender` (the live-test harness, a separate test identity) bypasses the chokepoint by design.
- `SlackAdapter.send()` posts long messages in chunks, one call each; a refusal on a later chunk leaves earlier chunks posted. No reply route uses it.
- A reply whose evidence scope does not match the adapter's target (an unusual thread value) is recorded as server automation, not refused.
- On an agent without Telegram, harness and model come from the launch record (`configured`), not a runtime observation.
- Messages sent before this change read `false` (app, this machine), `not-found` (Telegram) or `not-retained` (Slack).

## 3. Level-of-abstraction fit

Recording sits at each platform's send chokepoint (the app reply append; `SlackAdapter.formattedApiCall` and `FileHandler.uploadFile`), not in agent prose or a hook. The evidence model and the session-producer derivation are the Telegram ones, reused (`OriginEvidence`, `sessionProducer`). The Telegram store is not duplicated; it gains one read method and one index.

## 4. Signal vs authority compliance

The only blocking authority added is the Slack "no record, no send" rule: deterministic (did a local append succeed), the same rule the existing standard applies to Telegram, with reachability preserved and an operator exception. Origin evidence itself is information: nothing reads it to decide anything; the bind token, not the evidence, decides which conversation a reply may reach.

## 4b. Judgment-point check

No competing signals: a file append succeeded or it did not. Not a judgment point.

## 5. Interactions

- `handleSlackReply` (both Slack reply routes): the origin scope wraps only the adapter send; the 503 branch sits before the generic 500 and after the 408 timeout branch, so the redrive and delivery-id rules are unchanged.
- Outbound review: the footer is added after `checkOutboundMessage` (it is not part of the reviewed authored text) and passes the deterministic credential wall; the LLM tone gate never sees it.
- App store replication: `agentOrigin` added to the wire allowlist; the receiver re-validates it and keeps it only when its machine id matches the event's.
- Telegram store worker: one indexed read per phone history page, bounded at 750 ms by the caller.
- Presence standby: the outage notice never calls `onMessageLogged`.
- Display-settings route: on an agent with no enabled Telegram entry it now reads and writes the top-level setting instead of answering 503.

## 6. External surfaces

- Slack users see a new italic footer line on the agent's own replies (on by default; the same display bits hide it).
- The phone's history rows gain an `origin` field (additive; older app builds ignore it). Values: display names, harness ids, model ids, statuses. Never tokens, session ids, paths, refs or channel ids.
- `/health` (authed) gains `messageOrigin` counters.
- `app-reply.sh` and `slack-reply.sh` send one more header; `slack-reply.sh` prints `NOT SENT` on the new 503.

## 7. Multi-machine posture (Cross-Machine Coherence)

- App origin: replicated with the event through the existing app store replication; a peer's record must carry its own machine id.
- Slack ledger: proxied-on-read through the machine that sent the message. Every Slack read names the machine that lists the conversation, and a message another machine sent reads `null`, `other-machine` here (the Slack connection moves with the serving lease).
- Telegram: per-machine store; pool reads fan out with `includeOrigin=1` and each machine joins its own rows; a peer's recorded origin fills a local `null` on collision.
- Display bits: read on the machine answering, never taken from a peer.

## 8. Rollback cost

Revert the release. Recorded fields are additive; older code ignores `agentOrigin` and never reads the Slack ledger. The Slack refusal alone has a live operator switch. No state repair.

## Conclusion

Ships live for every agent, as asked. The one new refusal is narrow, loud, recoverable without a restart and switchable by the operator.

## Second-pass review (if required)

**Reviewer:** independent subagent (Claude, fresh context), reading the artifact, the spec and the diff.
**Independent read of the artifact: concur**

Notes raised and handled: (1) the credential lookup was unbounded and the app route's evidence call sat outside its try: now bounded at 1.5 s and the ladder never throws; (2) a reserve or report error after a written intent could count as a refusal: moved after the write; (3) the notice wording overstated it: §1 corrected; (4) Telegram join reason labels: `not-found` with no store, `lookup-failed` on a store error; (5) a thread-value edge and the chunked `send()` path: aligned the scope with the adapter and noted in §2.

## Evidence pointers

- Unit: `tests/unit/messageOrigin.test.ts`, `tests/unit/SlackOriginLedger.test.ts`, `tests/unit/replyOrigin.test.ts`, `tests/unit/app-conversation-agent-origin.test.ts`, `tests/unit/telegram-origin/lookup-origin-evidence.test.ts`, `tests/unit/PostUpdateMigrator-messageOriginAllPlatforms.test.ts`.
- Integration (production device authenticator): `tests/integration/message-origin-all-platforms.test.ts`.
- E2E alive: `tests/e2e/message-origin-all-platforms-alive.test.ts`.

## Found in testing

The integration test caught one defect before push: `detectOutboundCredential` returns `{ detected }`, and the footer check treated the object as truthy, so the Slack footer was always dropped. Fixed to read `.detected`; the integration test asserts the footer reaches the adapter.

Live Slack contract tests were not run: Echo's Slack bot token was revoked on 2026-07-01. The changed adapter files carry CONTRACT-EVIDENCE: EXEMPT markers stating that no Slack API method, parameter or response field changed.
