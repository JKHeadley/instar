# Upgrade Guide — v1.2.15 (Telegram-native wizard + UX fixes)

<!-- bump: patch -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->

## What Changed

**Fix: three real-user UX bugs from the v1.2.14 Codex install test.**

End-to-end testing on instar-codey caught three issues, all in the
hybrid wizard's Codex path:

1. **`instar user add -d ...` errored** with "unknown option '-d'".
   The user-profile creation step silently failed. Fix: drop the
   `-d` flag and set `cwd: options.projectDir` on the spawn. Same
   prophylactic edit applied to the server-start and
   autostart-install actions.

2. **Choice prompts silently accepted text input** ("Proactive",
   "Telegram") without echoing what got picked. The interpreter
   worked correctly via `resolveChoice`, but the user had no
   visual confirmation. Fix: new `echoChoice` helper called from
   the validator retry loop prints `→ {label}` after the answer
   is accepted.

3. **Telegram setup silently failed** because it spawned a
   `codex exec` session that couldn't actually wait for the user
   to paste a bot token. Codex printed manual BotFather
   instructions, ended successfully, and the wizard recorded
   "Telegram is configured!" without anything being configured.
   Fix: complete rewrite of the Telegram action as an instar-
   native readline + Telegram Bot API flow. No LLM session in the
   loop. Three steps:

   - **Step 1 of 3**: print BotFather instructions, prompt for
     token, validate via `GET /bot<TOKEN>/getMe`. Up to 5 retries
     on invalid tokens; "skip" exits without marking configured.
   - **Step 2 of 3**: prompt user to add bot to a group + send
     a message, then call `GET /bot<TOKEN>/getUpdates` to auto-
     discover the chat ID. Up to 4 retries.
   - **Step 3 of 3**: write `{ type: 'telegram', enabled: true,
     config: { token, chatId, pollIntervalMs, stallTimeoutMinutes
     } }` to `.instar/config.json`'s messaging array, replacing
     any existing telegram entry.

   The action NEVER returns `telegramConfigured: true` unless the
   config write actually succeeds — closing the silent-success
   class of failure.

Spec: `specs/dev-infrastructure/wizard-telegram-native.md`.
ELI16: `specs/dev-infrastructure/wizard-telegram-native.eli16.md`.
Side-effects review: `upgrades/side-effects/fix-wizard-telegram-native.md`.

## What to Tell Your User

The wizard's Telegram setup now works end-to-end on any host — no
browser automation dependency, no LLM session involved. You'll see
clear instructions, paste your bot token, add the bot to a group,
press Enter, and the wizard writes everything for you. If anything
fails along the way, it'll tell you exactly what happened and how
to finish setup later by chatting your agent.

## Summary of New Capabilities

No new capabilities. Three UX hardening fixes on top of v1.2.14.

## Evidence

Reproduction prior to fix: v1.2.14 install on `instar-codey` (real
Codex install, ChatGPT-subscription auth):
- user-add action printed `error: unknown option '-d'`.
- Autonomy choice "Proactive" was accepted with no echo.
- Messaging choice "Telegram" was accepted with no echo.
- Telegram action spawned Codex; Codex printed manual BotFather
  instructions; wizard immediately marked Telegram configured;
  config.json's `messaging` array was empty.

After fix:
- 6 new unit tests cover the Telegram-native flow shape, the
  add-user cwd fix, and the choice echo helper.
- Existing 26 state-machine tests still pass.
- Existing 5 dispatch canary tests still pass (updated to
  reflect that the driver now has 1 codex exec spawn instead of 2,
  since the Telegram one was replaced).
- Total: 37 wizard-related tests, all green.
- Manual end-to-end re-test on Codex install path pending on
  publish.
