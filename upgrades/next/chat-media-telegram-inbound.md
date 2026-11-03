## What Changed

- Telegram files in the Instar iPhone app (docs/specs/mobile-native-chat-media.md §4.9, Telegram half). When files in app conversations are on, every photo, document and voice note that arrives in a Telegram topic is also copied into the app's file store and recorded as a durable event that is copied to the agent's other machines.
- The app's view of a Telegram conversation now shows those files: a phone reading a topic's history gets each recorded file as an `attachments` entry, and can download it with `GET /mobile/media/<hash>?ref=telegram:<topicId>`. Only a file recorded in that topic can be downloaded through that topic.
- A phone never sees a server file path any more: history rows (and the conversation list's preview line) show `[photo]`, `[file: <name>]` or `[voice note]` instead of the path, whether or not the file was recorded.
- The copy uses the same checks as the agent's reply files: the store's size limit, the disk-space floor, the 50 MiB file limit, a hash, and the file type read from its bytes. A voice note is copied before the Telegram handler deletes its download. If the copy fails (store full, disk low), the session still gets the Telegram message exactly as before and the failure is reported.
- The session's Telegram messages, the agent's Bearer reads of topic history, and the app conversation routes are unchanged.

## What to Tell Your User

Photos, documents and voice notes you send in a Telegram topic now show up in that conversation in the Instar app, and you can open them there, on any of my machines. This only works while files in app conversations are switched on. The app needs its next update to display them.

## Evidence

- Unit tests: the new event kind's validator (refuses an app conversation key, a mismatched id, a bad platform id, an empty file list), the replicated wire round trip, the index (a reference for downloads and the store size, never a chat message, appended once, rebuilt from the files), the copy (blob then event, type from the bytes, a duplicate, store full and disk floor refusals that hold nothing), the path replacement, and the Telegram adapter hook (a voice note is handed over while its download still exists; a throwing hook never stops delivery; no hook means no copy).
- Integration tests through the real device authenticator: a recorded photo and document appear as attachments with no path in the text; a row from before the feature also has no path; the Bearer read is unchanged; a download with `ref=telegram:42` serves the bytes; a hash recorded in another topic, an unknown hash and a bad ref answer 404; a Bearer token cannot download; the same message twice keeps one event; media off answers 503.
- End-to-end test: an AgentServer on a development agent with a real TelegramAdapter wires the hook; a Telegram photo is recorded on the production path, a phone paired through the production path sees it in the topic's history and downloads it. A fleet agent sets no hook.

## Summary of New Capabilities

- Telegram photos, documents and voice notes are kept for the app and shown in its view of the Telegram conversation (`platform-media` events, download with `ref=telegram:<topicId>`). Behind `mobilePairing.native.media.enabled` (development-agent gated).
