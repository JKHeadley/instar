# Same-machine agent trust: a bar it can actually earn — Plain-English Overview

> The one-line version: before the same-machine trust check is allowed to start refusing messages, it now has to show it has seen several different senders, has actually decided "I would refuse this" at least once, and that nobody who checked those decisions found one wrong.

## The problem in one breath

When two agents run on the same computer, one can hand a message straight to the other. Since October the receiving agent looks up how much it trusts the sender, but only in "dry run": it notes what it *would* do and still delivers everything. The plan is to switch it to really refusing. On Nov 9 both outside reviewers said "not yet": every decision so far was "allowed", all from one sender, so the check had never been tested on the case it exists for. The ladder's bar only asked "did it run at least 3 times", which it passed without proving anything.

## What already exists

- **The trust check on the same-machine route** — looks up the sender in the same trust list the internet relay uses and decides allowed or not. In dry run it only counts and logs.
- **The evidence log** — every feature on the maturation ladder writes rows saying what it did; the ladder reads them to decide whether a feature is ready for its next step. Anyone can grade a past row as right or wrong through the evidence endpoint.
- **The ladder bar for this feature** — "ran at least 3 times" and "error rate at most 5%".

## What this adds

The bar for the next step (turning refusals on, on development agents) now also needs three things:

- **At least 3 different senders.** One busy sender a hundred times counts once.
- **At least 1 real "would refuse" decision.** The check has to have met the case it is for.
- **No "would refuse" graded wrong.** Someone (a person or an agent reviewing the log) grades those decisions; one wrong grade holds the feature back, and with no grades at all the bar reads "not enough evidence", never a pass.

To make this measurable, each decision row now names its sender at the top of the row, and each "would refuse" row also says why (for example "untrusted may not send a message"). "Would refuse" rows are no longer folded into one row per hour: they are kept at most one per sender and operation per minute, and each row says how many it stood for.

## The new pieces

- **A scripted drill** (`scripts/drills/local-route-trust-drill.mjs`) — makes two throwaway agents in a temp folder with their own home folder: no Telegram, no Slack, no tunnel, no feedback reports sent anywhere, and the receiver's relay is pointed at a dead address so it never touches the real network. The sender has no trust profile and its relay is off. The drill proves the message goes over the same-machine route, the receiver writes a "would refuse" row naming the sender and the reason, the row can be graded, the message really is in the receiver's inbox (nothing silently lost), and the ladder page shows the new bars.
- **A "subject" field on evidence rows** — a small general addition so any feature can count distinct things (senders, topics) on its bar.

## The safeguards

- Nothing about delivery changes. Dry run still delivers every message; enforcing behaves exactly as before.
- The sender name in a row is cleaned (printable characters only, length-limited) and is used to count senders for evidence only, never to grant trust.
- Refusing a sender the receiver already knows stays the "harm" signal it was before.
- The new bars can only make the feature wait longer; they cannot move it forward on their own.

## What the reader needs to decide

Nothing. This is a measurement change on a feature that is still in dry run, and it is undone by a revert.
