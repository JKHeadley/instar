## What Changed
Conversations now have pinned messages, any number, like Telegram (docs/specs/conversation-pinned-messages.md).
- **A new `pin` event in the conversation store.** A pin or unpin is kept with the conversation (app conversations, Telegram topics and Slack conversations), so every machine shows the same pins, newest first. Up to 100 per conversation.
- **Routes for the app and the dashboard.** `GET /mobile/chat/app/:key/pins`, `GET /mobile/chat/:topicId/pins`, `GET /mobile/chat/slack/:conversationId/pins?machine=` list them (`{conversationKey, pins:[{messageId, pinnedAt, pinnedBy:{name, role}, preview, source}]}`); a device-signed `POST` to the same paths with `{messageId, pinned, requestId}` (plus `machine` for Slack) pins or unpins and answers `{ok, pinned, changed, mirror, mirrorDetail?, pins}`. Every history read also carries `pins`. Pinning follows the same access as sending; seeing pins follows reading. The agent's own token can read pins but never change them.
- **Telegram.** Pinning a Telegram message from the app or dashboard also pins it in the topic, quietly; a pin someone makes inside Telegram shows up in the app (also on agents whose lifeline does the polling). Telegram tells a bot nothing when someone unpins, so an unpin inside Telegram is not seen. A message typed in the app has no Telegram message to pin and is pinned in the app only.
- **Slack.** Pinning a Slack message also pins it in Slack when the Slack app has the pins permission (otherwise the pin is kept in the app and the answer says so). Pins made inside Slack are not read back.
- **Dashboard.** A pinned bar under the conversation title shows the newest pin ("1 of 3" with several); tapping it jumps to that message and steps to the next. "All pins" lists them with Unpin, and each message has a menu with Pin / Unpin.
- **Off switch:** `mobilePairing.native.pins.enabled: false` (on when absent). Needs native conversations on.

## What to Tell Your User
You can now pin messages in any conversation, as many as you like, just like in Telegram. On the dashboard, tap the small menu on a message and choose Pin; the pinned messages show in a bar at the top of the conversation, and tapping the bar takes you to each one. Pins are the same on all your machines. In a Telegram topic the message gets pinned in Telegram too. One limit: if you unpin something inside Telegram itself, I won't see that, so unpin it from the app or dashboard instead.

## Summary of New Capabilities
- Pinned messages in app conversations, Telegram topics and Slack conversations, agent-wide, with list and pin/unpin routes for the app and a pinned bar on the dashboard.
- Telegram pins mirrored both ways (pins only), Slack pins mirrored outward.

## Evidence
- `tests/unit/conversation-pins.test.ts`: the pin event, the reduction in every arrival order, index rebuild, a pin is never a message, the 100 cap, the slow-clock rule, the replicated wire round-trip, the team gate's exact mappings.
- `tests/integration/conversation-pins.test.ts`: app, Telegram and Slack pins over the real device-signed pipeline, retries, refusals, the token read-only rule, the off switch, mirror outcomes, a Telegram pin recorded once.
- `tests/e2e/conversation-pins-alive.test.ts`: on a production AgentServer boot a paired phone pins (200), the pin is listed, rides on history and the token reads it.
- `tests/unit/telegram-pins.test.ts`: the adapter hand-off, strangers ignored quietly, the lifeline forward, the id-only pin calls.
- `tests/unit/console-chats-model.test.ts`, `tests/unit/console-chats-page.test.ts`: the dashboard bar, menu, list and the signed pin call.
