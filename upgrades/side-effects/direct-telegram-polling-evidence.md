# Raw Telegram polling evidence

This dormant adapter extracts the literal request from the original Telegram forum message. It accepts only the recognized plain-text shape, an explicit topic, a human sender and a positive numeric bot account ID.

- Authority. An independently authenticated polling caller must establish the bot account and registered owner. This adapter has no production caller and does not send, admit or persist messages.
- Refusal. Unknown message fields, forwarded or quoted material, media, missing topic and nonowner source are rejected. Normal chat has no new restriction.
- Data. The derived reference contains original raw chat and topic identifiers. No new state is written.
- Rollback. Removing the adapter requires no migration or deployed configuration changes.

Independent review concurred for the dormant adapter. Real forum-update shape compatibility must be checked before mounting it.
