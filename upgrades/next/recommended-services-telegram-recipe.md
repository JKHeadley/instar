# Upgrade Guide — recommended-services-telegram-recipe

## What Changed

The seventh recommended-services setup recipe, `telegram-v1` (service `telegram`), dark until its live proof: only an agent listing it under `recommendedServices.provingRecipes` reaches it. After a yes, the setup session signs in to Telegram Web as the person (phone number and login code through Secret Drop), creates the bot with BotFather and a group with topics, proves both with the Bot API, and stores the channel through the key route (`POST /recommended-services/telegram/key`, token as the plain-text body, chat id in `X-Telegram-Chat-Id`). The server writes this agent's `messaging[]` Telegram entry (`src/recommended/telegramSetup.ts`, wiring in `routes.ts`) and asks for a planned restart (`requestSupervisedRestart`), so the new channel starts polling. The check (`probeTelegram`: `getMe`, then `getChat` is a forum) passes once the bot and group answer. A Telegram the person already had is never replaced. A switch-off disables the entry, keeps it, requests a restart, and, because Telegram is a way in, waits until another route works. An agent with no Telegram can now say yes to Telegram: that setup runs as a session the dashboard lists, since there is no topic yet (every other service still needs a messaging channel). At boot, an agent with Telegram configured but no `telegram-reply.sh` (Telegram added after install) gets the reply script written, so its sessions can answer there; an existing script is never replaced.

## What to Tell Your User

Nothing changes for you yet. If an agent is set up without Telegram, it will soon be able to add it after your yes: you give it your phone number and the login code Telegram sends you, through one private link, and it does the rest.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Telegram recipe (proving agents only) | `recommendedServices.provingRecipes: ["telegram-v1"]` on a throwaway or development agent |
| Channel write | `POST /recommended-services/telegram/key` from the setup session, after a yes |

## Evidence

`tests/unit/recommended-services-telegram-recipe.test.ts` (probe, entry reader, check, switch-off, brief), `tests/integration/recommended-services-telegram.test.ts` (yes → key route → restart → check; a pre-existing Telegram kept; the way-in hold), e2e dark/proving, wiring. Live proof 2026-11-09 on a throwaway with no Telegram: yes through the confirm routes, its own setup session made the bot and forum group in the person's signed-in Telegram Web, the key route accepted, the check passed, planned restart, and two messages in Lifeline were answered. The two defects it found are fixed here.
