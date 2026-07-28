# Idle-monitor throttle settle-gate — plain-English overview

## The one-paragraph version

Echo watches its own chat sessions and, when one looks stuck behind an AI-provider "slow down" (throttle) message, hands it to a recovery helper. There are two watchers that do this. One (the "watchdog") is careful: before it acts, it checks whether the screen has actually *stopped changing* — because a working session animates its little spinner every moment, so a frozen screen with a throttle message on it proves the session genuinely stopped on that throttle. The other watcher (the "idle monitor") was naive: it acted the instant it saw a throttle *word* on the screen, even if that word was just old text scrolled up from earlier, or a brief throttle that had already cleared. That naive trigger is what produced unnecessary "back online" pokes. This change teaches the idle monitor the same careful check the watchdog already uses — and ships it behind a dark switch so it only runs on this development machine until it's been soaked.

## Why it's safe

The careful check can only make the idle monitor act *less* often, never more — so it can't cause a recovery that wasn't already happening. A genuinely-stuck session still has a frozen screen, so it still settles and gets recovered (just a few seconds later than the old instant trigger). The only thing it stops is acting on a stale or already-cleared throttle word. With the switch off (everywhere except this dev machine), behavior is exactly as before.

## What the review caught (and why that matters)

The first version of this had a real bug: I put the "has the screen stopped changing?" check in a spot that only ran *once*, the moment a session first went idle. But a "did it stop changing?" check needs to look more than once — you can't tell a screen is frozen from a single glance. So as written, the check could never confirm "settled," and the idle monitor would have quietly handed the whole job to the backup watchdog instead of doing it itself. The adversarial reviewer caught that this broke the "strictly safer" promise in one edge case (if that backup watchdog were ever turned off). I restructured it to run the check every moment the session is idle, re-verified, and confirmed it's correct. This is the second time in this effort that putting a "small, safe" change through real adversarial review caught a flaw introduced *while fixing something* — which is exactly the point of the process.

## What's deliberately left for later

This adds the careful check to the idle monitor *alongside* the watchdog's, rather than merging the two watchers into one. Unifying them (so recovery isn't driven by two separate triggers, and so the screen is only captured once per moment instead of twice) is a bigger redesign tracked as a follow-up. This change is the safe, conservative, reversible first step.

## What changes for you

Nothing visible day-to-day — this is internal session-watching behavior, and it's off everywhere except the development machine until it's proven out. The benefit is fewer unnecessary "back online" pokes from a session that wasn't really stuck, by holding the idle monitor to the same evidence bar the careful watcher already meets.
