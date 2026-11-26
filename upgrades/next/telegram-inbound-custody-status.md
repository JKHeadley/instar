<!-- bump: patch -->

## What Changed

A Telegram acknowledgement now distinguishes receipt by Instar from delivery to the session. Messages held by the inbound queue can show when they are waiting or have expired. When Instar can match transcript evidence to the exact incoming message, it can confirm delivery to the session. Older paths without that evidence use the receipt or queue status.

## What to Tell Your User

“Received by Instar” means the service got your message. “Delivered to the session” means Instar confirmed that the session received that specific message. If a message is waiting or expires without delivery confirmation, you can see that separately.

## Summary of New Capabilities

Telegram messages have clearer receipt, waiting, delivery, and expiry notices.
