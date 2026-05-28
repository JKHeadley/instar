# The dead-jobs fix, part 2 — in plain terms

## What's broken

Every agent has a set of background chores it runs on a schedule — health checks,
reflection, the "overseer" watchers, and so on. Right now **none of them run**. The
schedule is empty.

Think of each chore as a recipe card. The top of the card has a little label section:
the recipe's name, and also some scheduling notes like "make this every 5 minutes" and
"this one's high priority."

The part of the system that reads those cards has a list of label words it's allowed to
recognize. By an oversight, that list only included the *name-ish* words — it never
included the *scheduling* words like "schedule" or "priority." So when the reader hit the
word "schedule" on a card, it didn't recognize it, got spooked, and threw the **whole**
recipe in the trash. Every single chore card got tossed for the same reason.

## Why this is "part 2"

The first fix (already shipped) cleared a *different*, bigger jam — the recipes were
missing some required info entirely. Clearing that jam was necessary, but it just let the
cards reach the *next* checkpoint, which is where this label-reading problem was waiting.
One clog hid behind another.

## The fix

Add the scheduling words to the reader's "allowed words" list. That's it — once the reader
recognizes them, it stops trashing the cards and the chores run again.

I proved this works before writing any of this up: I made the change on a scratch copy and
ran my real chore cards through it. The count went from **0 to all 18**.

## Is this safe? (the part I had to double-check)

The worried question: if we let cards say things like "give this chore unrestricted tools,"
could someone sneak extra power in through a label? I had three reviewers attack this, and
one caught that my first explanation was actually *wrong* — so this is worth stating
carefully:

- The card's labels are just the *source* the system copies from. The real decision about
  what a chore is allowed to do is made from a separate, locked-down sheet (the "manifest"),
  not the card's labels.
- The one label that does get read directly — the tool list — still can't grant real power
  on its own. Unlocking the powerful "everything" setting needs a *second* switch that only
  lives on the locked sheet, which is itself behind a confirm-over-Telegram gate.
- So a label alone can never hand a chore extra power. There's a specific test that pins
  this down so it can't quietly regress later.

## How I'm making sure it doesn't happen again

The real failure wasn't the missing words — it was that my earlier test checked only *half*
of each recipe card and never ran a whole card through the *actual* reader. That blind spot
is exactly why my tests were green while the real server ran zero chores. So the new test
installs the *real* chore cards and runs them through the *real* reader end-to-end, and it
checks the scheduling info actually came out valid — not just that nothing crashed.

## One leftover

There's a single junk card on my own machine with no recipe attached and a bad label. The
reader is right to reject that one — it's just stray clutter, not part of this fix. I'll
sweep it up separately.
