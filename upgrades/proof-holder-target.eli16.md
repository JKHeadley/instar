# The move check now tells the truth about two kinds of move

> The one-line version: the check that proves a conversation can move between machines was reporting failures for moves that had worked, and now it reads them correctly.

## The problem in one breath

The check moves a test conversation to another machine, sends it a message, and waits for exactly one reply from that machine. On Echo's real machines every move worked, yet the check went red for two reasons that had nothing to do with moving.

## What was wrong

- **The test message got lost.** When the new machine was also the one routing messages, the router said "this one is yours, deliver it here", and nothing did. Real messages have that delivery step; the check's test message did not, so it always read as no reply.
- **The wrong machine got the credit.** A machine that isn't in charge sends its reply through the one that is. The check looked at who logged the reply, not who wrote it, so a correct reply read as coming from the wrong machine.

## What this adds

The check now delivers its own test message on that machine, and reads the signed note saying who wrote each reply.

## The safeguards

If delivery fails, the check goes red and says why. If the note names another machine, it stays red. Real conversations take none of these paths; only listed test topics do.
