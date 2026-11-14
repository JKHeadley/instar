# A machine that takes over keeps what it took

> The one-line version: the spare machine now keeps renewing the lease after taking over, instead of letting it lapse every other minute.

## The problem in one breath

When one machine dies, its spare takes the "lease", the token that says who is in charge. We tested this on two rented servers by killing the main one. The spare took over in 48 seconds, which is good. Then it let the lease run out: the lease lasts 60 seconds and the spare only looked at it every 2 minutes. So it was in charge for half of every two minutes, and it had to take a brand new lease each time.

## What already exists

- **A fast renewal timer** renews the lease every 30 seconds. It already runs on any machine with Telegram or the phone app, because those stop working without a current lease.
- **The takeover switch** lets a machine with no one to confirm with keep its lease rather than step down. It is off by default.

## What this adds

Turning on the takeover switch now also starts the fast renewal timer. A spare machine has no Telegram of its own, so nothing was starting the timer for it.

The log also stops repeating one line every 30 seconds while a machine holds alone. It says so once, when the hold starts.

## The safeguards

The timer can only renew a lease this machine already holds. It can never take one. It stops as soon as another machine shows a newer lease, an explicit setting can turn it off, and a machine set to observe only never renews. None of this changes what happens for agents that have not turned on the takeover switch.
