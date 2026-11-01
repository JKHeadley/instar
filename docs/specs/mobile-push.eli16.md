# Mobile push — Plain-English Overview

> The one-line version: when something needs you, your iPhone buzzes with the agent's name and what the item is about, even when the Instar app is closed and the phone is locked.

## The problem in one breath

The app only knows something needs you while it is open. Telegram already pings you, but the app plan promised its own notifications, so the app can be the one place you look.

## What already exists

- **The Attention hub filter** — your agent already decides, in one place, which items deserve your attention (decisions, sign-ins, security, things it raised itself). Routine noise is held back and logged instead.
- **Phone keys** — each phone you pair has its own key, confirmed by a private code, so the agent knows which phones are really yours.

## What this adds

- Your phone tells each paired agent where to send notifications (Apple's push address for this phone).
- Whenever the agent posts to your Attention topic, it also sends your phone a notification. What passes through Apple says only the agent's name and "Something needs you". The phone then asks your agent directly for the item's title and shows that instead, using a small read-only key that works even while the phone is locked. So you see what it is about, and Apple never sees the text.
- If you have the app paired with more than one of your machines, any of them can raise the notification, and the same item does not buzz twice.
- The agent talks to Apple directly with your own Apple developer push key. There is no Instar server in the middle.

## The safeguards

- At most one notification every two minutes per phone; anything else in that window is folded into "2 more things need you".
- After 40 in a day, at most one an hour (urgent items can still come through sooner), so a noisy day never floods the phone and nothing is silently dropped.
- If Apple says a phone's address is no longer valid, the agent forgets it; if Apple rejects the key, sending pauses and the agent reports it.
- Revoking a phone also stops its notifications.

## What you need to decide

Nothing new. One setup step remains on my side: creating the push key in your Apple developer account, which needs a normal browser sign-in.
