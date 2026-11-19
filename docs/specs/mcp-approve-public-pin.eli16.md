# Tool-change approval link: same PIN protections as the other PIN pages — plain-English overview

## What this is

When your agent wants to add or remove a tool, it can send you a link. You open it and type your dashboard PIN to approve. Anyone can open that kind of page, so the PIN check on it has to be as careful as the one on the dashboard's unlock page.

## What changes

The approval page now checks that the request it is approving really exists before it looks at a PIN. Wrong guesses count toward the same overall limit as the unlock page, and PIN entry is refused on an insecure connection, just like the other PIN pages. All of those pages now share one check, so they can't drift apart.

## What you would notice

Nothing when you approve from the link. Too many wrong PINs locks PIN entry for a while, as it already does on the unlock page.

## What you need to decide

Nothing. It is a fix, and a revert fully undoes it.
