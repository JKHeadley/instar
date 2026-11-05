## What Changed

Every place the server hands a session or a notice a Telegram topic id now carries the topic's verified name beside it — `topic 11882 "🤝 echo"` — read from the existing topic registry, or says `(name unresolved)` plainly when no trusted name exists. This covers the `[telegram:N …]` message prefix (which now always includes the name or the unresolved marker), the agent-to-agent reply notices and spawn-prompt topic hints, and attention items and notices that mention a topic. One shared formatter renders them, and a ratchet test fails when new code renders a bare topic id.

## What to Tell Your User

When I mention one of your topics, I can now always tell you its name, not just its number — or I'll say the name isn't known yet.

## Summary of New Capabilities

No new capability; topic names now travel with topic ids in everything the server tells a session or a notice.

## Evidence

Live, 2026-11-02: a peer's session was told "the server sent it to topic 11882, the topic for echo" and told its user it could not see the topic name, though the registry held "🤝 echo". Unit tests cover the formatter and the prefix; an integration test drives a real ThreadlineRouter + TopicLinkageHandler with names from a real TelegramAdapter registry; an e2e test checks the boot wiring and the adapter-to-prefix path.
