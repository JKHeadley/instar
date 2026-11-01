# User-seat Telegram Web destination — 2026-10-31

Justin directed Echo in topic 102965 on 2026-10-30 at 07:17 PDT to test the live Instar 2.0 agent through his signed-in Telegram Web account, and at 07:19 made that a standing development practice. The local procedure is `.instar/observer-102965/user-seat-testing.md` in Echo's agent workspace.

The managed `justin-telegram` profile is enrolled for account `7812716706`. Its typed browser send to the Instar 2.0 General conversation was held before dispatch because the browser executor authorized only Echo's own Bot API chat and owner DMs. The held operation `6afacf39-d220-4843-abf9-e3fa915b72f0` has destination `channel:4290919884`, `topicId:null`, `messageId:null`, zero send attempts, and no Telegram receipt. The outcome endpoint reported `pending`, `safeToResend:false`.

This change permits one operator-configured browser destination only when the profile ID, enrolled account, transport, chat ID, topic ID, and send-only message fields all match. A malformed grant fails closed. The existing fresh configuration, enabled adapter, serving lease, signed origin record, send policy, exclusive profile enrollment, read-only peer resolution, and durable outbox remain required. The allowance is not a Bot API destination and does not allow raw browser writes.

Echo's local operator configuration records the decision as `telegram:102965:2026-10-30:07:17` and binds `justin-telegram` to `channel:4290919884` with no topic ID. On loading this build, recovery must resolve the original held operation before anyone submits another task. A new POST while that operation is pending could duplicate the task and is forbidden. Verify the origin outcome and the actual Telegram message receipt before calling it delivered.
