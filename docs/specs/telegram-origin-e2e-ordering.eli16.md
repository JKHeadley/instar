# Two tests that failed by luck of timing — Plain-English Overview

> The one-line version: two automated tests checked the right behaviour at the wrong moment, so on a busy machine they failed at random and blocked unrelated changes; they now check what happened, not what the state happens to be at one instant.

## The problem in one breath

Before any change is merged, a long suite of automated tests runs. Two of those tests, both about how the agent records and reports its Telegram messages, failed three different changes in twelve hours and were retried on a fourth; other tests in the same family failed more. None of those changes touched that code. Each failure threw away a 25-minute test run.

Both tests pass when run alone on a quiet machine. They fail when the machine is busy, because each one looks at a value that the product itself changes a moment later.

## What already exists

- **The outage notifier.** If the agent cannot safely record a Telegram message, it can send one fixed warning to the operator. If the operator has opted out, or the agent no longer has the right to post there, the warning is "suppressed": decided, and not sent.
- **A five-second housekeeping pass.** Every five seconds the product checks that recording is healthy and, if so, gets the next warning ready. If the destination is opted out, there is nothing to get ready, and the notifier's state becomes "unavailable".

## What was wrong with the tests

**The first test** asked for a warning in a situation where it must be suppressed, then waited for the notifier's state to read "suppressed". It does read that, for a moment. Then, when the operator has opted out or the agent has lost the right to post there, the housekeeping pass runs and the state becomes "unavailable". Both mean "no warning was sent". On a quiet machine the test looked in time; on a busy one it looked too late and saw "unavailable".

**The second test** set up an outage where one step keeps failing, and checked that exactly one warning went to the operator. In that set-up the product can send a second warning a tenth of a second after the first, because a recovery attempt gets a new warning ready and then fails again. On a quiet machine the test checked before the second one went out; on a busy one, after.

## What this changes

Only the two tests. No product code.

- The first test now reads the list of every state the notifier reported, and checks that "suppressed" was reported and that nothing was attempted. It no longer matters when it looks.
- The second test now counts at the moment the count is fixed: exactly one warning before any recovery attempt. After one recovery attempt it accepts one or two, never more, and checks where every warning went (the operator's hub, never the conversation) and what it said (the fixed outage text).

## What is deliberately not decided here

The second test used to imply "one warning per outage". The product does not do that today in this situation: it can send one per recovery attempt. Whether that is wanted is a product decision, and it has been written up for the owner of this code together with the related question about "suppressed" turning into "unavailable". This change does not hide it: the test says in a comment exactly what it no longer asserts and why, with the reference to that write-up.

## What it does not fix

Other tests in the same family fail for a different reason: the product gives itself a quarter of a second, then half a second, to record a message, and a busy disk can take longer with nothing actually broken. Fixing that needs a small change in the product so tests can allow more time. It is in the same write-up and is the next piece of this work.

## What you need to decide

Nothing for this change. The two product questions above are the owner's to answer.
