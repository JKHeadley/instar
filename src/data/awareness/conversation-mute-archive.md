---
title: Chat mute and archive
---
Chat preferences belong to the person reading the chat. Muting suppresses eligible reply notifications; archiving hides a chat from the ordinary list without stopping its session or deleting history. New replies do not undo archive. Account and document notices keep their separate delivery rules.

Use the signed-device `POST /mobile/conversations/preferences` route with a fresh `requestId`, a verified conversation `ref`, and `muted` or `archived` booleans. Use `GET /mobile/conversations?archive=only` to find archived chats, or `archive=all` for both. Bearer callers must identify the reader explicitly; never choose a person from a device's previous ownership. A retry reuses the original request identifier and payload.

A save receipt proves the local action. Report pending replication and partial or unknown delivery support honestly; it does not prove every machine is quiet. Unknown legacy notification summaries are held rather than attributed to a new device owner. Before rolling back to an older sender, persist `mobilePairing.push.enabled: false`; keep push unavailable until the guarded sender is restored. Never delete chats to reconcile archive state.
