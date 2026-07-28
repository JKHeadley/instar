# ELI16 — the "off" button for the auto-message advisory didn't do anything

## The story

Instar has an "outbound advisory" — when a background job tries to send you a message, it first checks
the text for raw file paths, dev jargon, or localhost links and, if it finds any, holds the message so
the agent can fix it. It's on by default, and the docs told operators they could turn it off by
setting a switch: `messaging.outboundAdvisory.enabled: false`.

The problem: that switch never worked on a real setup. The config's "messaging" section is a **list**
of chat platforms, not a labeled box — so a switch addressed as if it were a box *inside* that list
can't be read. The program looked, found nothing, and used the default ("on"). So an operator who
tried to turn the advisory off would find it stubbornly still on, with no error explaining why.

This is the same shape of bug we fixed earlier for the promise follow-through feature (PR #1379). That
one was worse — a feature you could never turn *on*. This one is milder — a feature you can't turn
*off* — because it defaults to on, so it still works; you just can't disable it.

## What this change does

It moves the switch to a spot the program can actually read: a **top-level `outboundAdvisory`**
setting, right next to the other real settings instead of buried in the platform list. Setting
`outboundAdvisory.enabled: false` there now genuinely turns the advisory off. The old (broken) nested
key is still honored where it *can* be read (for setups that use a box-shaped config), so nothing that
worked before breaks. The docs are corrected to point at the new switch — both for new agents and, via
a small automatic update, for agents that already have the old wording in their notes.

## Why it's safe

- The advisory is inform-only — it never blocks your messages — so there's no risk of it wrongly
  rejecting anything. The only change is that its off-button now works.
- Old configs keep working (the old key is a fallback), so it's backwards compatible.
- It's a plain code + docs change; if it were ever wrong, the fix is a simple revert with no leftover
  data to clean up.

## How we know it works

A new test sets up the config the **real** way — "messaging" as a list — flips the new top-level
off-switch, and confirms the advisory reports itself disabled (which was impossible before the fix). It
also checks the default-on behavior when the switch isn't set, and that the old box-shaped config still
works. The 58 existing advisory tests all still pass.
