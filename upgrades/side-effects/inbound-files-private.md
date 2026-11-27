# Side effects: long WhatsApp, iMessage and Slack message files saved in the agent's own folder (SEC-138)

In plain words: the files that hold long WhatsApp and iMessage messages, and Slack's thread-context, long-message and recovery files, move from a shared temp folder to the agent's own owner-only folder, where long Telegram messages already go.

Tier 1. Size: 3 source files edited (`SessionManager.ts`, `server.ts`, `memorySessionPolicy.ts`), 1 helper file extended, 1 doc table updated, 1 new and 8 edited test files (three module mocks now keep the real module's other exports).

## What changes for running agents
- `SessionManager.injectWhatsAppMessage` and `injectIMessageMessage` save bodies over 500 characters with `writePrivateInboundFile` into `<project>/.instar/telegram-inbound/` (`wa-<number>-...` / `im-<slug>-...`). The line typed into the session names that path instead of `/tmp/instar-whatsapp/...` or `/tmp/instar-imessage/...`.
- The iMessage session bootstrap in `src/commands/server.ts`, when it is over 500 characters, is saved the same way (`im-bootstrap-<slug>-...`). Its old 1-hour cleanup loop over `/tmp/instar-imessage` is removed; the 7-day `cleanupTelegramTempFiles` sweep of the inbound folder covers these files (retention goes from 1 hour to up to 8 days for this one file kind, owner-only).
- Slack (`src/commands/server.ts`): the thread-context file (`slack-ctx-<channel>-...`), the long-message file (`slack-msg-<channel>-...`) and the context-exhaustion recovery file (`slack-recovery-<channel>-...`) are saved the same way instead of in `/tmp/instar-slack` (default modes, plain overwrite).
- `memorySessionInboundRoots` no longer lists `/tmp/instar-slack` and `/private/tmp/instar-slack`: a shared /tmp folder is no longer a trusted source when staging files into a memory-scoped session. Slack files are found under `telegram-inbound`, which the list already has.
- Folder created 0700 when missing; an existing folder owned by the agent's account with group or other bits is tightened to 0700 by `ensurePrivateDir`. Telegram's two writers (the session bootstrap in `server.ts` and long messages in `injectTelegramMessage`) now call it too, so a Telegram-only agent's folder is also owner-only; their files keep their existing names and modes, protected by the folder. Files 0600, created with `wx`, name with 8 random hex characters.
- `cleanupTelegramTempFiles` (7-day limit) now also runs once a day on a timer (`unref`), not only at startup, so a long-running server does not keep these files past the limit.
- Sessions already read this folder for Telegram, sandboxed sessions are allowed to read it, and git sync skips it (`FileClassifier`), so no new access is needed. Old files left in `/tmp/instar-*` are not touched; `slack-reply.sh`'s own diagnostics folder is separate and unchanged.
- Memory-privacy staging is unchanged: it only scopes Telegram and Slack places, and WhatsApp/iMessage sessions do not take that path today, as before.

## Signal vs authority
Storage location and permissions only. It refuses nothing and grants nothing.

## Rollback
Revert the commit. No state migration.

## Tests
- `headless-spawn-reroute` "SEC-138 repro": 56 pass.
- `private-inbound-file` (new): 4 pass (location and modes, unique names, prefix stays in the folder, a loose existing folder is tightened).
- `memory-session-policy` and `slack-context-exhaustion-recovery` updated for the Slack move.
- `imessage-session-injection` updated to the helper; `whatsapp-message-routing-e2e` source assertion updated to the helper.
- Also pass: `bootstrap-file-threshold`, `session-telegram-inject`, `memory-session-inbound-claims`, `user-channel-wa-imessage`, `file-classifier`, `respawn-collision-notice`, `spawn-session-silent-start`, `cold-start-fallback-wiring`, `telegram-message-injection`, `server-temp-cleanup`.

## Second-pass review

**Reviewer:** independent Claude reviewer subagent, two rounds. Round 1 was blocking: Slack still wrote thread context, long messages and recovery context to a shared /tmp folder with default modes. Fixed here together with three round-1 notes (an existing loose folder is now tightened, the tidy-up also runs daily, a weak test was replaced). Round 2 verdict: concur, no blocking items. Its main note, that a Telegram-only agent kept a loose folder, is also applied (`ensurePrivateDir` on both Telegram writers).

Left as is: files written to /tmp before the upgrade are not moved or deleted.

