# WhatsApp messages get the same typed path-tag escaping as the other channels

<!-- bump: patch -->

## What Changed

SEC-149. Telegram, Slack, iMessage and the lifeline pass person-supplied text through `escapeTypedPathTags` (`src/core/inboundMedia.ts`), so a typed `[image:/abs/path]` (or `document`, `video`, `voice`, `file`) reaches a session as inert `[typed image: ...]` instead of a live media tag the session reads as a file to open. WhatsApp did not. `wireWhatsAppRouting` (`src/commands/server.ts`) now escapes the message text where it enters, which covers injection into a live session, the bootstrap of a respawned one and a new spawn. It also removes square brackets from the sender's profile name once at entry (live injection already did), so a name like `[image:/path]` cannot become a live tag in a new session's first prompt. WhatsApp's own placeholders `[Image]`, `[Video]`, `[Sticker]` and `[Location]` are unchanged; `[Document: <name>]`, whose file name the sender chooses, now reads `[typed Document: <name>]`.

## What to Tell Your User

- **Safer WhatsApp messages**: "A WhatsApp message that just types out a file path can no longer make me open that file. Real photos and documents work as before."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Typed path tags in WhatsApp text made inert | Automatic |

## Evidence

- `tests/unit/whatsapp-typed-path-tags.test.ts` (new, 2): the WhatsApp routing escapes the text before any session sees it; a typed tag is made inert; WhatsApp's placeholders stay readable.
