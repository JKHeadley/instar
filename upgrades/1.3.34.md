# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**TelegramAdapter can now run a second bot cleanly (groundwork for agent-to-agent Telegram
comms).** Two internal additions, both shipping dark (nothing uses them yet): (1) a
non-primary Telegram adapter can namespace its own state files under a sub-directory, so two
bots in one process never clobber each other's poll-offset / registry / message-log /
attention files; and (2) inbound Telegram messages now expose whether the sender is a bot
(`is_bot`) and any `sender_chat` — the structural input a later update uses to tell an
agent-sent message from a human typing the same text. The primary bot's behavior and state
paths are byte-for-byte unchanged.

## What to Tell Your User

- Nothing changes in how your agent behaves today — this is plumbing for a later feature
  (agents messaging each other over Telegram). Your agent's own Telegram keeps working
  exactly as before.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Multi-instance `TelegramAdapter` | Internal — `new TelegramAdapter(cfg, stateDir, { subDir, suppressLifelineAutoCreate })`; primary (no opts) unchanged |
| Sender-identity on inbound messages | Internal — `message.from.is_bot` + `message.sender_chat` exposed on the update type |

## Evidence

**Net-new groundwork, not a bug fix.** Proven by a dedicated test asserting the load-bearing
safety property — a PRIMARY adapter's four state-file paths are byte-for-byte the historical
`{stateDir}/...` values (this code runs the agent's own Telegram, so an unchanged primary is
the non-negotiable invariant) — plus that a `subDir` adapter namespaces all four files and
shares no path with the primary. The existing Telegram suites (71 tests across 5 files) pass
unchanged as the regression guard. `tsc --noEmit` clean. The wiring that consumes these
(the agent-message recipient handler + `sendAgentMessage`) lands in the follow-up PR.
