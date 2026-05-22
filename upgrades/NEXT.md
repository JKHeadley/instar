# Upgrade Guide — v1.2.19 (Telegram: privacy off, Forum mode, topics, intros)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: the Codex agentic Telegram path now produces a working
messaging configuration end-to-end.**

v1.2.18 got Codex to walk through setup conversationally but the
resulting bot+group combination didn't actually work for
messaging. Three root causes uncovered on real-user retest:

1. Bot privacy mode left ON by BotFather default →
   `can_read_all_group_messages: false` → bot can't see user
   messages in the group.
2. Group created as "basic group", not "supergroup" → Forum mode
   impossible → server-side `ensureLifelineTopic` etc. fail
   silently.
3. No system topics created → no Lifeline → no agent presence
   in the group.

Three new steps in the Codex prompt:

1. **Disable privacy** via /setprivacy in BotFather. Verifies via
   `bot<TOKEN>/getMe` (confirms
   `can_read_all_group_messages === true`).
2. **Enable Forum/Topics** on the group via Telegram Web UI
   (group title → edit → Topics toggle). Auto-converts to
   supergroup and changes chatId to -100-prefixed. Verifies via
   `getUpdates` (confirms `chat.is_forum === true`).
3. **Create 4 system topics + seed intros** via Bot API:
   - 🛡️ Lifeline (color 9367192) — main channel.
   - 📢 Updates (color 7322096) — automated status.
   - 📊 Dashboard (color 7322096) — web dashboard link.
   - 🔔 Attention (color 16766590) — urgent things.
   Each topic gets a 1-2 sentence first-person intro via
   `sendMessage` with `message_thread_id`.

Config write now persists `lifelineTopicId` alongside
`token`/`chatId`. Server's `ensureLifelineTopic` reuses the
existing topic instead of creating a duplicate.

Each new step has an explicit failure sentinel
(`privacy-not-disabled`, `forum-mode-not-enabled`,
`topics-create-failed`) for fast-fail to the readline backstop.

Spec: `specs/dev-infrastructure/telegram-privacy-topics-intros.md`.
ELI16: `specs/dev-infrastructure/telegram-privacy-topics-intros.eli16.md`.
Side-effects: `upgrades/side-effects/fix-telegram-privacy-topics-intros.md`.

## What to Tell Your User

After setup, your bot can read messages in the group (privacy is
disabled), the group has organized topic threads, and each
system topic starts with a friendly intro from your agent
explaining what it's for. The first message you send in Lifeline
will reach the agent and get a real response.

## Summary of New Capabilities

Same agentic flow; now produces a fully-working result instead
of a half-configured one.

## Evidence

Reproduction prior: v1.2.18 install left the bot with
`can_read_all_group_messages: false`. User messaged the group;
`getUpdates` returned empty results array. No server-side
delivery confirmation.

After fix: 5 new unit canary tests cover the privacy-off
+ Forum + topics + intros + lifelineTopicId additions. All 25
codex-playwright-telegram tests pass; existing 37 wizard tests
also pass.
