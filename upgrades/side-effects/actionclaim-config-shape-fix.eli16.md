# ELI16 — Why the "I'll do that in 5 minutes" tracker couldn't be turned on

## The one-sentence version

There's a safety feature that watches for promises the agent makes ("I'll restart it", "I'll post
that in about 5 minutes") and quietly writes them down so they survive a restart — and it turned out
you literally could not switch it on. This change fixes the switch.

## What was broken

Think of the config file as a form. Most settings live in labeled boxes you can fill in. The switch
for this promise-tracker was written as "fill in the box `messaging → actionClaim → enabled`."

The problem: `messaging` isn't a box that holds other boxes. It's a **list** — one row per chat
platform (Telegram, Slack, WhatsApp). You can't write "actionClaim" *inside a list*; there's nowhere
to put it. So when the program looked for `messaging → actionClaim → enabled`, it always found
nothing, and "nothing" means "off." No matter what you did, the feature stayed off.

Why nobody noticed for so long: every automated test filled the form out the *wrong* way — it made
`messaging` a box instead of a list, so in the tests the switch worked fine. But no real install
looks like that. Real installs always use the list. So the tests were green while the real thing was
un-turn-on-able. Two sibling features have the same quirk, but they default to **on**, so nobody ever
had to find the switch — this promise-tracker is the first one that defaults to **off** and actually
needs its switch to work.

## What this change does

It moves the switch to a box that actually exists: a **top-level `actionClaim`** setting, right
alongside the other real settings — not buried inside the platform list. The old (broken) location
is still honored if anyone used it, so nothing that already worked breaks.

Two places read that switch: the live server route that receives the promise, and a small "when a
turn finishes" hook script. Both now look in the new top-level spot first, and both are careful never
to trip over the list.

## Why it's safe

- The feature is *signal-only*: it just writes a note; it never blocks or changes a message. So there
  is no risk of it wrongly rejecting something.
- It still ships **off by default** — this change only makes the "on" switch reachable, it doesn't
  turn anything on.
- Old configs keep working (the old location is a fallback), so it's backwards compatible.
- If it's ever wrong, the fix is a plain code revert — there's no saved data to clean up.

## How we know it works now

A new test fills the form out the **real** way — `messaging` as a list — and flips the new top-level
switch, then checks that a promise like "I'll restart the server now" actually gets written down. It
fails without the fix and passes with it. Older tests (the ones using the box shape) still pass, so
the backwards-compatibility promise holds.
