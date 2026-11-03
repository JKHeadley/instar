## What Changed

- A photo sent from the Instar app into a Telegram topic is copied into Telegram as a document when Telegram would refuse it as a photo. `sendPhoto` takes only JPEG, PNG and WebP, so an iPhone HEIC screenshot used to fail with a 400 and no copy appeared. Non-MP4 video goes up as a document for the same reason.
- A device reading a Telegram topic's history now gets `deliveryState` on app-sent messages, so the app's "Delivered" mark shows there as it does in app conversations.
- A failed Telegram copy is now reported with its own wording ("the Telegram topic does not show a message the operator sent from the app"). It used to borrow the phone-pairing text.

## Evidence

Found on Justin's iPhone on 2026-11-03 at 09:54. A pasted HEIC screenshot reached the session, but the Telegram copy failed with `telegram-400`, and the sent row had no Delivered mark.
- Unit: `telegramKindFor` both sides, and a HEIC photo goes up via `sendDocument`.
- Integration: device history carries `deliveryState: 'delivered'`.
