# ELI16 — Slack spawned-session reply relay

Instar could already receive Slack messages, open the right working session, and send messages through its Slack adapter. The live demo exposed a broken link between those abilities: the new session was instructed to run a reply script under a Claude-only path, and that file was absent. Inbound routing succeeded, but the answer had no installed handset back to Slack.

This change installs one framework-neutral helper for Slack-enabled agents and makes every initial, recovery, compaction, and context prompt use it. The session does not receive a channel or thread argument. Instead it presents the private conversation binding minted when the session started. The server verifies that binding, resolves the local verified Slack conversation, and sends through the same tone review, duplicate-id handling, timeout policy, and adapter that existing Slack replies use. A forged binding, raw destination, replicated-only record, or malformed identifier is refused.

The installer is shared by fresh setup, startup refresh, and post-update migration. It replaces only byte-for-byte-known old shipped helpers. Operator-customized files are preserved and receive a current `.new` candidate. Writes are executable, atomic, and safe under concurrent update attempts. A temporary Claude compatibility copy remains, but the neutral copy is authoritative.

Tests reproduce the live failure and prove the repair at unit and full HTTP-route levels. They also pin the prompt census so a Claude-only path or raw destination cannot silently return. A single helper invocation has one delivery id; an explicit same-id retry is deduplicated, while two independent model invocations are honestly not claimed exactly-once.
