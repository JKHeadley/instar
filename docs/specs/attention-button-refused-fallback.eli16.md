# A refused button never costs you the alert (plain-English overview)

## What this is

When I put something in your Attention topic in Telegram, the message now carries a button that opens the exact page where you act. Telegram is strict about buttons: if it dislikes the button's link, it rejects the entire message, not just the button. Before this fix, my backup attempt sent the very same button again, so Telegram rejected the backup too, and the alert you needed never arrived.

## What changes

Now the backup attempts drop the button. First I try the message without its formatting but still with the button (in case the formatting was the problem). If that is rejected too, I send the formatted message without the button, and as a last resort the plain message without it. You always get the words. When the button had to be dropped, I write one line to a log of "posts that reached you with nothing to tap", marked "button-refused", so the broken link gets fixed where it was made.

## Items from my other machines

When the console shows attention items from all my machines, each item from another machine used to keep whatever button target that machine supplied, unchecked. Now every such target is checked with the same rule I use for my own items: it must be a link to a page inside your console. Anything else gets no button, and I log it once as "peer-action-invalid" so it can be investigated. Items from a machine on older software, which supply no target at all, get one worked out by the same rules as local items.

## What you need to decide

Nothing. This is a safety fix inside a change that is already under review, and undoing it is a plain revert.
