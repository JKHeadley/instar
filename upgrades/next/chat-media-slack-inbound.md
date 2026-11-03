## What Changed

- Slack files in the Instar iPhone app (docs/specs/mobile-native-chat-media.md §4.9, Slack half). When files in app conversations are on, every photo, document and transcribed voice note the Slack adapter downloads for an inbound Slack message (or a standalone shared file) is also copied into the app's file store and recorded as a durable `platform-media` event under the Slack conversation's canonical key — the same key app-sent Slack messages use, taken from the conversation registry's mint for the message's routing key. Each file of a message gets its own record (`<ts>`, `<ts>:1`, …), so a re-delivered message records nothing twice.
- The app's view of a Slack conversation now shows those files: a phone reading `GET /mobile/chat/slack/:id/messages` gets each recorded file as an `attachments` entry, in the message's file order. The read also returns `conversationKey`, which the phone passes as `ref` to `GET /mobile/media/<hash>`. A download is served only when this machine's own registry minted that conversation (its current key) and the file is recorded in it.
- A phone never sees a server file path in a Slack conversation: history rows and the list preview show `[photo]` and `[file: <name>]`, and the notes the adapter writes for a shared text file say "on the agent's machine" instead of the path.
- A shared text file whose content is put straight into the message is not copied (its text is already in the message).
- The copy reuses the Telegram half's checks (store size limit, disk floor, 50 MiB, hash, type from the bytes). It runs beside delivery and is waited on for at most 30 s; a failure is reported as an `AppMedia.slackInbound` degradation and the session still gets the Slack message exactly as before.
- The platform-media key check (and the purge route's) now accepts the registry's `_` unknown-workspace placeholder, which is what a Slack conversation's key carries until its workspace is known. Files recorded under the placeholder key still show after the key gains the workspace id.
- Bearer reads of Slack history, the session's Slack messages, and app conversations are unchanged.

## What to Tell Your User

Photos and documents you send to me in Slack now show up in that Slack conversation in the Instar app, and you can open them there. They download from the machine that lists the conversation. This only works while files in app conversations are switched on, and the app needs its next update to display them.

## Evidence

- Unit tests (`tests/unit/app-platform-media-slack.test.ts`): Slack keys in the event validator (placeholder workspace, concrete workspace, thread; malformed keys refused), per-file ids, the conversation key from a real ConversationRegistry mint matching `resolve(id).key`, "held locally" (unknown, replicated and stale-placeholder keys refused), every file of a message found in order and under the earlier placeholder key, a duplicate, the device text, and the SlackAdapter hook (one call per file under the tag the session got, inlined text files skipped, a throwing or never-settling hook never stops delivery, no hook when off, standalone `file_shared` files handed over).
- Integration tests (`tests/integration/slack-platform-media.test.ts`) through the real device authenticator and a real registry: attachments in file order, no path in the text or the list preview, `conversationKey` returned; Bearer read unchanged; a download with `ref=<conversationKey>` serves the bytes; another conversation's file, a conversation this machine never minted, a wrong-workspace key and a junk ref answer 404; a Bearer token cannot download; media off answers 503.
- End-to-end test (`tests/e2e/mobile-native-media-alive.test.ts`): an AgentServer on a development agent with a real SlackAdapter and ConversationRegistry wires the hook; a Slack photo message is recorded on the production path, and a phone paired through the production path sees it in the conversation's history and downloads it. A fleet agent sets no Slack hook.

## Summary of New Capabilities

- Slack photos, documents and transcribed voice notes are kept for the app and shown in its view of the Slack conversation (`platform-media` events under the Slack canonical key; download with `ref=<conversationKey>` on the machine that lists the conversation). Behind `mobilePairing.native.media.enabled` (development-agent gated).
