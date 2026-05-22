---
title: "Telegram setup — privacy off, Forum mode, system topics, intros"
slug: "telegram-privacy-topics-intros"
author: "echo"
eli16-overview: "telegram-privacy-topics-intros.eli16.md"
review-convergence: "2026-05-22T03:00:00Z"
review-iterations: 1
review-completed-at: "2026-05-22T03:00:00Z"
review-report: "docs/specs/reports/telegram-privacy-topics-intros-convergence.md"
approved: true
---

# Telegram setup — privacy off, Forum mode, system topics, intros

## Problem statement

v1.2.18 made the Codex agentic Telegram path actually work
end-to-end conversationally — Codex walked the user through QR
login, created the bot, created the group, sent "first contact".
But three failures surfaced on real-user retest:

1. **Bot privacy mode left ON.** BotFather creates new bots with
   privacy mode enabled by default. With privacy ON,
   `can_read_all_group_messages` is false — the bot can only see
   direct @mentions and replies to its own messages. Justin
   messaged the group; the bot never saw it; getUpdates queue
   stayed empty; server polling loop saw nothing; no delivery
   confirmation, no agent response. Verified by hitting
   `bot<TOKEN>/getMe` directly — confirmed
   `can_read_all_group_messages: false`.

2. **Group is a basic group, not a supergroup with Forum mode.**
   The chatId Codex wrote was `-5154496235` (no -100 prefix).
   Telegram only supports topic threads on supergroups. instar's
   server-side `ensureLifelineTopic` / `ensureDashboardTopic` /
   `ensureAgentAttentionTopic` / `ensureAgentUpdatesTopic` all
   fail silently on basic groups.

3. **No system topics, no intro messages.** The Claude wizard
   path creates a Lifeline topic + seeds an intro greeting (the
   "agent comes alive" moment). The Codex path didn't. Justin's
   group had only the General topic with "first contact" — no
   organized conversation surface, no agent presence.

## Proposed design

Three additions to `buildTelegramAgenticPrompt` (the Codex
agentic flow's instruction set), each with explicit failure
sentinels for the verifier-based dispatch.

### Fix 1: Disable bot privacy mode via BotFather

New step inserted after token capture/validation:

- Send `/setprivacy` to BotFather.
- Click the bot.
- Click "Disable".
- Verify via Bot API: confirm `result.can_read_all_group_messages
  === true`. If still false after one retry, emit
  `AGENTIC_FAILED: privacy-not-disabled`.

Without this, messaging never works. Hard failure.

### Fix 2: Enable Forum/Topics mode on the group

The Bot API has no endpoint for enabling Forum mode — must be
done via UI. New step:

- Tell user: "Enabling topics so we can organize different
  conversation threads."
- In Telegram Web: open the group, click the title, click the
  edit/pencil, toggle Topics on, save.
- Send a probe message "first contact" in General.
- Verify via Bot API getUpdates: `message.chat.type === 'supergroup'`
  AND `message.chat.is_forum === true`. The chat.id will have
  CHANGED to a -100-prefixed supergroup id — capture this as the
  new FORUM_CHAT_ID for all subsequent steps.
- Retry once if not forum-enabled. Then `AGENTIC_FAILED:
  forum-mode-not-enabled`.

### Fix 3: Create system topics + seed intros

The canonical 4 system topics from `TelegramAdapter.ts`'s
TOPIC_STYLE constants:

- 🛡️ Lifeline — color 9367192 (SYSTEM, green)
- 📢 Updates — color 7322096 (INFO, blue)
- 📢 Dashboard — color 7322096 (INFO, blue)
- 🔔 Attention — color 16766590 (ALERT, yellow)

For each, the prompt drives:

```
curl -s -X POST "https://api.telegram.org/bot<TOKEN>/createForumTopic" \
  -d '{"chat_id": "<FORUM_CHAT_ID>", "name": "<EMOJI> <NAME>",
       "icon_color": <COLOR>}'
```

Captures `result.message_thread_id` for each.

Then sends a 1-2 sentence first-person intro to each topic via
`sendMessage` with `message_thread_id`:

- Lifeline: "Hey 👋 This is the Lifeline — the main channel between
  us. Anything that doesn't fit in another topic, send it here."
- Updates: "Updates is where I'll post automated status — job
  runs, sync notifications, anything informational that doesn't
  need a response."
- Dashboard: "Dashboard is where I'll post the link to my web
  dashboard once a tunnel is up."
- Attention: "Attention is for things you need to look at — failed
  jobs, missing credentials, anything urgent."

### Config write update

The config write step now persists `lifelineTopicId` alongside
token + chatId:

```json
{
  "type": "telegram", "enabled": true,
  "config": {
    "token": "<TOKEN>",
    "chatId": "<FORUM_CHAT_ID>",
    "lifelineTopicId": <LIFELINE_TOPIC_ID>,
    "pollIntervalMs": 2000,
    "stallTimeoutMinutes": 5
  }
}
```

The server's `ensureLifelineTopic` checks `config.lifelineTopicId`
first and reuses the existing topic rather than creating a
duplicate.

### Why each piece is required

Without privacy-off: bot can never see user messages, full stop.

Without Forum mode: topic-based UX impossible. Server's
auto-topic creation silently fails.

Without system topics + intros: user has no entry point to the
agent (no Lifeline), no visible difference vs an empty group.

### Verifier-based dispatch is unchanged

`verifyTelegramConfig` still checks token + chatId populated. The
agentic prompt's own internal verification (Bot API getMe,
getUpdates is_forum, createForumTopic ok, config re-read at end)
fails fast on any error, dropping to the readline backstop.

## Decision points touched

- Adds three behavioral SIGNALS to the Codex prompt (privacy-off,
  Forum-enable, topic create+seed). Each has an explicit
  failure sentinel for fast-fail to the manual backstop.
- AUTHORITY for "did messaging work end-to-end" is the post-fix
  state of the bot + group as seen by the Telegram Bot API
  (`can_read_all_group_messages`, `is_forum`, topic-exists).
- No new abstraction — pure prompt content + curl commands
  Codex already knows how to drive.

## Open questions

None for v1.2.19 scope.

## Out of scope (queued for v1.2.20 audit)

- Bot profile picture + description (Claude SKILL.md sets these
  via /setuserpic + /setdescription in BotFather).
- Lifeline first-greeting from the agent's voice (the "agent
  comes alive" moment after server start, distinct from the
  topic-seed intros).
- GitHub backup setup (Claude SKILL.md drives `gh repo create`
  for instar-<agent-name> private repo + push).
- Cross-platform alerts setup (multi-channel fallback).
- Comprehensive diff of Claude SKILL.md (2132 lines) vs Codex
  prompt — Justin's broader audit ask, scheduled for v1.2.20
  after v1.2.19 ships.
