# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Mentor consumer — sender wiring.** The mentor's `deliverToMentee` is rewired from the
legacy file-outbox onto the new agent-to-agent Telegram comms primitive (shipping in pieces
across previous releases). Lazily constructs a second TelegramAdapter for the mentor bot
(using the multi-instance subDir + suppress-Lifeline support from earlier increments), then
calls `sendAgentMessage` with role `'mentor'`. The runtime anti-loop guard physically
prevents sending any other role; bot-token scrubbing on errors is inherited.

Gated on four new `MentorConfig` fields (`botToken`, `menteeBotId`, `menteeChatId`,
`menteeTopicId`) — all default undefined, so the mentor stays dark until an operator
explicitly configures the bot. The pre-existing `dailySpendCapUsd` is marked
`@deprecated`; a future PR retires it along with the legacy `mentor-outbox/` files.

## What to Tell Your User

- Plumbing for the mentor feature — the delivery path now goes through the new agent-to-agent Telegram channel instead of the old file-based outbox, but stays completely dark until you configure a dedicated mentor bot. A later update adds a one-button setup flow for that.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Mentor sender wiring (dark) | Internal — `MentorConfig` gains `botToken`/`menteeBotId`/`menteeChatId`/`menteeTopicId` (all undefined by default); when all four are set, `deliverToMentee` sends via the mentor bot through `sendAgentMessage` instead of the legacy file-outbox |

## Evidence

**Net-new groundwork, not a bug fix.** Coverage strategy: the `sendAgentMessage` path is
fully covered by previous PRs (5 tests for the send + audit + anti-loop + token-scrub);
the multi-instance TelegramAdapter is covered by previous PRs (3 tests, including the
load-bearing "primary paths byte-for-byte unchanged" assertion); marker / routing /
cycle-detection by the earliest PR (20 tests). The AgentServer-level lazy mentor-bot
construction is dark by default — the bot-setup live flow in the next PR exercises it.
`tsc --noEmit` clean.
