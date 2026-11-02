## What Changed

- `GET /mobile/conversations` pages app conversations and Telegram topics on one cursor, so no conversation is cut from the list and left unreachable when there are many Telegram topics.
- `GET /mobile/conversations` and `GET /mobile/chat/app/:key/messages` accept `?scope=pool`: every machine's rows merged, a machine that did not answer listed in `pool.failed`, and a row only another machine holds marked "couldn't check here".
- With native app conversations on, a message sent from the app into a Telegram topic is no longer refused for a pairing invite, a desktop code or password-like text: the invite or code is removed and the rest delivered, password-like text is delivered with a `credentialShaped` signal, and the 📱 copy posted in the topic hides it.
- App history rows say how the signing phone was approved (`originApprovedVia`: `telegram-dm` or `dashboard-pin`), so the app can show "approved on dashboard".

## What to Tell Your User

If you use the Instar iPhone app with native conversations turned on: your conversation list now always shows every conversation, however many Telegram topics you have, and the app can show conversations from all your machines. A message you send from the app into a Telegram topic is no longer turned away because it contains an invite or something that looks like a password; the invite is removed, and the password-like text is sent as you wrote it (the app asks you first) but hidden in the copy posted to the Telegram topic.

## Evidence

- Unit tests cover the list order and cursor, lossless paging across several sources, duplicate collapse, and hiding credentials in the mirror copy.
- Integration tests run the real routes: 250 Telegram topics plus 5 app conversations paged to the end with every row exactly once; pool reads with a live peer and an unreachable one; token removal through the Telegram route (stored as `redacted`, token absent from disk); the native-off refusals unchanged; the approval method for Telegram- and dashboard-approved phones.

## Summary of New Capabilities

- `?scope=pool` on `GET /mobile/conversations` and `GET /mobile/chat/app/:key/messages`.
- `originApprovedVia` on app history, sync and the device's Telegram history read.
