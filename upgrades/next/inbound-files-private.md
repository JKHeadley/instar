# Long WhatsApp, iMessage and Slack message files are saved in the agent's own private folder

<!-- bump: patch -->

## What Changed

SEC-138. A WhatsApp or iMessage message over the inline limit, and a large iMessage session bootstrap, were saved in fixed shared folders under `/tmp` (`instar-whatsapp` with default permissions, `instar-imessage` with a mode that a pre-created folder ignores). Another local account could read them, or pre-create the folder and swap a file before the session read it. They are now saved with `writePrivateInboundFile` (`src/messaging/shared/telegramInboundFiles.ts`) in the project's `.instar/telegram-inbound` folder, the same folder long Telegram messages use: folder 0700, file 0600, created exclusively, with a random part in the name. Slack's thread-context, long-message and recovery files, which were in `/tmp/instar-slack` with default modes, move the same way, and `/tmp/instar-slack` is no longer a trusted inbound root for memory-scoped sessions. An existing inbound folder of the agent's with a loose mode is tightened to 0700, including by the Telegram writers. The 7-day sweep of that folder now also runs daily, not only at startup.

## What to Tell Your User

- **Private long messages**: "Long WhatsApp, iMessage and Slack messages are now saved only in my own private folder, so other accounts on this computer cannot read or swap them."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Long WhatsApp, iMessage and Slack message files saved owner-only in the agent's own folder | Automatic |

## Evidence

- `tests/unit/headless-spawn-reroute.test.ts`, "SEC-138 repro" (from the security-review job; fails on main because the reference names `/tmp/instar-whatsapp/` and `/tmp/instar-imessage/`): both references now point to owner-only files whose content is the tagged message.
- `tests/unit/private-inbound-file.test.ts` (new): folder and file modes, unique names, prefix cannot leave the folder, a loose existing folder is tightened.
