# Side effects: a forged mentor message can no longer start a mentee session (SEC-154)

## What changes for running agents

Only agents with `mentee.enabled` (dark by default; on for two agents on the Mac Mini, instar-codey and codey-proof).

- **`decideRoute` (`src/messaging/AgentTelegramComms.ts`).** The known-sender check is now `!known || senderBotId undefined or empty || known.botId !== senderBotId` → drop `agent-marker-unknown`. Before, an undefined bot id skipped the comparison, so any caller that omitted it passed as any known mentor, and the mentor role handler spawned a session with the message body as its prompt.
- **`POST /a2a/inbox` (`src/server/routes.ts`).** After the existing agent-token check, before dispatch, the route now:
  - requires `senderAgent` and `senderBotId` as non-empty strings (400);
  - requires the marker's `from` to equal `senderAgent` and its `to` to equal this agent (403 `marker-principal-mismatch`);
  - requires `senderAgent` to be another agent in the local agent registry (403 `sender-not-a-local-agent`).

  These mirror `handleA2aMeshInbox`, the signed cross-machine route.

## Every legitimate path still works

- Telegram polling and the lifeline forward derive the bot id inside `dispatchAgentMessageHook` from the sender chat or the bot's own id.
- The mesh inbox already required a bot id and matched the principals.
- The only caller of `/a2a/inbox`, `AgentServer`'s same-machine delivery, always sends `senderAgent` and a bot id. That bot id already had to match the mentee's configured one whenever it was compared, so no working setup changes.

## Residual, said plainly

On one machine, every agent runs as the same OS user, and agent tokens are files that user can read. A process run by that user can read the mentee's token and its known mentor's bot id, and could still pose as the mentor through `/a2a/inbox`. That is the same trust boundary as Threadline's same-machine relay route. Closing it needs a per-agent signing key held where other agents cannot read it, which is beyond this fix. Three related points complete the picture:
- **The lifeline secret is readable too.** The lifeline secret file is readable by that same user, so its holder can call `/internal/telegram-forward` claiming `senderIsBot` and the mentor's bot id, and reach the same handler.
- **The registry check is not an authentication boundary.** The "registered local agent" check is a name lookup in a registry file that same-user processes can write. It stops casual or misdirected calls, nothing more.
- **The mentor's bot id is not secret.** It sits in the mentee's config and is visible in Telegram.

What this fix closes is the bypass that needed no credential and no knowledge of the mentor at all: omitting the bot id. It also adds the principal check. Proving which same-machine agent is calling needs per-agent keys that other same-user processes cannot read. That is beyond this fix, and goes to the Chief of Staff as its own item.

## Signal vs authority

This only adds refusals at the accept boundary. Nothing new is sent or started, and a refused message is audited as dropped, as before.

## Rollback

Revert the commit. There is no switch; the old behaviour was the defect.

## Class-Closure Declaration

- **unbounded-self-action: n/a.** No new action: two checks that can only refuse.

## Second-pass review

**Reviewer:** Claude Sonnet (independent subagent), which read the change and every path into the hook.
- **Round one: CONCUR, no blocking defect.** It confirmed the bypass is real, and that the fail-closed check covers polling, the lifeline forward, `/a2a/inbox` and the mesh inbox. It found no other route to the mentor handler, and no legitimate delivery breaks: the same-machine sender and the mentee reply path both send a bot id.
- It asked for a fuller residual. The readable lifeline secret, the writable registry and the public bot id are now listed above.
- Its non-blocking suggestions are left for the follow-up item: reject a sender chat id that is not a bot id, and fail on the sender side instead of sending the `-local` and `-mesh` placeholders.

## Tests

- `tests/unit/sec154-mentor-forgery.test.ts` (new, 8 cases), as listed in the release note.
- Unchanged and passing: `tests/unit/messaging/AgentTelegramComms.test.ts`, `tests/unit/messaging/installAgentMessageHook.test.ts`, `tests/unit/body-budget-before-auth.test.ts`.
