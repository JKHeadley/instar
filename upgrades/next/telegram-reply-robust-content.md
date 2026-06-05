<!-- bump: patch -->

## What Changed

`telegram-reply.sh` now supports `--stdin-base64`, an additive mode for sending replies whose text may contain shell metacharacters or a literal heredoc delimiter line. The script decodes the base64 payload before using the existing JSON request path, so ordinary replies and server behavior are unchanged.

Existing unmodified relay scripts are upgraded through the SHA-based migrator. Customized relay scripts are preserved and receive a `.new` candidate as before.

## What to Tell Your User

Telegram replies are more robust when an agent needs to send text that looks like shell syntax or contains a heredoc-closing line. Normal replies work the same way; the safer mode is only used when needed.

## Summary of New Capabilities

- `telegram-reply.sh --stdin-base64 TOPIC_ID` decodes base64 input and sends the original text.
- Generated agent instructions mention the safer fallback for delimiter-sensitive content.
- Post-update migration upgrades the v1.3.266 shipped relay script to the new version without overwriting local customizations.

## Evidence

- Focused unit run passed: `telegram-reply-port-resolution`, `PostUpdateMigrator-telegramReply`, `migration-relay-script-hash`, `IdentityRenderer`, and `telegramRelayPrompt`.
- The new relay test sends shell-looking content plus a literal `EOF` line through `--stdin-base64` and asserts the server receives the exact original text.
