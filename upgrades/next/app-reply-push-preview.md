## What Changed

A phone notification for an agent reply in an app conversation said only "New reply". It can now show what the reply says (docs/specs/mobile-native-chat-media.md §4.11, increment 4).

- The push payload for a reply carries the reply's message id and machine (never its text). Apple still only sees "New reply".
- New route `GET /mobile/chat/app/:conversationKey/preview/:messageId` answers `{title, body}`: the reply's first 100 characters, or "sent a photo" / "sent a video" / "sent a voice message" / "sent a file: <name>" / "sent N files", then the caption. Open to the paired device, its notification read token (which until now opened only the attention title), and the agent's own token. A deleted conversation, an operator message or a reply not yet copied to that machine answers 404, and the phone keeps "New reply".
- Peer push triggers carry the message id too.

## What to Tell Your User

Once your iPhone app updates, a notification for my reply shows the start of what I said, or "sent a photo", instead of just "New reply". The text goes from me to your phone directly; Apple never sees it.

## Evidence

Unit tests for the preview phrases and the payload; integration test for the route through the real device authenticator (signed device, read token, wrong token, read token refused on history, agent token, unknown message, bad key). Existing push tests updated for the message id.

## Summary of New Capabilities

`GET /mobile/chat/app/:conversationKey/preview/:messageId`.
