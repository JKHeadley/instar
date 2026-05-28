# Instar Upgrade Guide — NEXT

<!-- bump: minor -->

## What Changed

**Same-machine a2a transport via `/a2a/inbox`.** PR #462 + #464 shipped the
receiver wiring + lifeline-forward dispatch path. Dogfood then surfaced the
root cause they couldn't reach: **Telegram structurally blocks bot-to-bot
delivery**. From the Bot API FAQ: "bots will not be able to see messages from
other bots regardless of mode." Echo's mentor bot can SEND to a chat, but no
other bot's `getUpdates` ever receives those messages — privacy mode,
`can_read_all_group_messages`, admin status, none of it overrides the rule.

This PR adds the canonical same-machine transport: a new `/a2a/inbox` HTTP
endpoint. The mentor side, on `deliverToMentee`, looks up the mentee in the
local `AgentRegistry`; if it finds a registered local peer, it POSTs the
a2a-marker text directly to peer:port/a2a/inbox. The inbox handler invokes
the same `dispatchAgentMessageHook` that polling + telegram-forward use, so
the receiver wiring is the same code path. The Telegram bot path is preserved
as a fallback (currently unreachable for cross-machine peers due to the same
block — a separate architectural problem tracked as future work).

The flow end-to-end (same-machine):

1. Echo's mentor runner calls `deliverToMentee('codex-cli', body)`.
2. Echo finds `instar-codex-cli` in AgentRegistry → POSTs to
   `http://localhost:PORT/a2a/inbox` with the marker + body.
3. Inbox auth-checks via `verifyAgentToken` (same trust model as
   `/messages/relay-agent`).
4. Inbox invokes `ctx.telegram.dispatchAgentMessageHook(...)` with
   `senderIsBot: true` (peers holding our token are bots by construction).
5. The mentee receiver hook (installed via `config.mentee.enabled`) routes to
   the `mentor` role-handler → spawn session → reply path via
   `sendAgentMessage(role='mentor-reply', corr=<id>)`.

**Migration parity** is automatic: no new config keys, the `mentee` block from
PR #462 is unchanged, and the inbox route is additive.

## What to Tell Your User

For agents on the same machine, mentor cycles now actually deliver. The
earlier release set up the receiver hook correctly but couldn't reach it in
production — Telegram itself blocks bots from seeing each other's messages.
This update routes mentor deliveries directly between local instar servers
when possible, so the round-trip works end-to-end. No config changes needed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `POST /a2a/inbox` | Same-machine a2a transport. Bearer must match the target agent's per-agent token (from AgentRegistry). Payload: `{ text, topicId, senderAgent, senderIsBot?, senderBotId? }`. Returns `{ ok, agentMessage: true/false, reason? }`. |
| Automatic same-machine routing in `deliverToMentee` | When the mentee is registered as a local peer, the mentor delivers via HTTP `/a2a/inbox` instead of the Telegram bot path. Telegram bot fallback preserved for cross-machine (currently doesn't deliver due to the bot-to-bot block; tracked). |

## Evidence

12 new tests, all green: 8 integration on the `/a2a/inbox` route (auth
shape, 401 cases, 503 no-adapter, 400 bad input, 200 routed, 200 not-routed,
senderIsBot default), 4 E2E lifecycle (hook installed at boot, route alive,
auth-gated, full claim path with the recording adapter). `tsc --noEmit`
clean. Side-effects review:
`upgrades/side-effects/a2a-inbox-http-transport.md`.
