# Plain-English overview — I don't keep a record of what you say to me

## The problem, in one line

On this machine, every message I have sent you is written down. Not one message
you have sent me is.

## How that was confirmed

Two separate places store conversation history. Both were checked, then checked
again several hours later — and the second check made it worse.

For this conversation there are now 111 stored messages, every one of them mine.
Across all conversations, the last message from you that this machine recorded
was on the **1st of July**. That is 24 days. Today alone I have sent 67 messages
here and recorded none of yours.

I had first written "nothing since the 20th of July." That was true, and it
understated the problem by three weeks — I'd measured over a window picked for
another reason and never asked what came before it. Which is the same shape of
mistake as the bug itself: something correct, over a range nobody examined.

So it isn't a display quirk or a search problem. The messages genuinely aren't
being written down.

## Why

The code that records your messages isn't broken. It just isn't running.

There is a function whose job is exactly this, and it has one caller — a
particular delivery route. That route has been used zero times on this machine.
Your messages arrive by a different road, and that road has no recording step
on it.

There's a second thing going on underneath, and I had it backwards until 14:00
today. **Your messages arrive at the Mac Mini. This conversation runs on the
laptop.** The Mini writes your message down where it arrives, then hands it
across to the laptop for me to actually respond to — and that handover doesn't
write anything down on the laptop.

So your half is probably not lost at all. It's on the Mini. The machine doing the
talking is the one that never sees your side written down, which is why a session
restarting here reads only me.

(I'd had the two machines the wrong way round in this document all day — saying
the laptop received and the Mini replied. Corrected.)

## Why it matters more than "missing history"

Every time a session restarts, I read back the recent conversation to work out
where we are. What I read is my own words with yours missing.

That is not theoretical. On the 25th I spent two hours rediscovering a design you
had written out for me two days earlier, and then reported it to you as a
valuable new finding. I could read myself agreeing with you. I could not read
what I had agreed to.

## The fix

There is exactly one place every message passes through on its way to me — the
moment it gets handed to my session. It already carries everything needed to
write the message down: who sent it, when, which conversation, and the text.

The fix is to write it down there. That's it. One line, at the one place
everything goes through, rather than on one of several roads.

Two small details that are deliberate:

- **Write it down first, then show it to me.** If something goes wrong in
  between, a recorded-but-unshown message is recoverable; a shown-but-unrecorded
  one is the exact problem being fixed.
- **If writing it down fails, show me the message anyway.** Recording is
  bookkeeping. It must never become the reason you can't reach me.

## "Built" and "fixed" are not the same day

This is worth being blunt about, because the review caught me heading for it.

The switch that turns recording on starts off. That's the normal careful way to
ship something — get the code in, watch it, turn it on. But this is a bug that is
losing data right now, so shipping the code with the switch off would mean the
work is finished, the tests pass, everything looks done, and **not one extra
message gets recorded**. The bug would carry on for exactly as long as nobody
flips the switch.

So the finish line is not "the code is in." It is: the switch is on for this
machine, you send me a message, and I can read it back. If it then turns out to
be slower than it should be, the switch comes back off — that's a measured
retreat, not an excuse to leave it off from the start.

## The alternative I should have considered first

The reviewer pointed out that there's a better-known way to do this: record
messages where they first arrive from Telegram, rather than where they get handed
to me. That would catch more — including messages that get dropped before they
ever reach me.

Two reasons it's still not what I'm proposing. The first is that the goal here is
narrow: make session restarts read the real conversation. The second is the
honest one — *the place where messages first arrive on this machine is exactly
what I don't know*. That's the bug. The road they take has no recording step and
I haven't traced where it starts. The spot I'm proposing is the one I have
actually verified they all pass through.

If you later want the fuller version, it's a good build and this doesn't get in
its way.

## What this means for your messages, plainly

Thirty-three rounds of review went by discussing timing and edge cases before
anyone — me included — asked the obvious question: this stores everything you
type to me. So, stated rather than left to be discovered:

- **What's kept:** the full text of your messages, your name, and timestamps.
- **Where:** a file on this one machine. Not sent anywhere, not copied to your
  other machines by this change.
- **Who can read it:** anything running as me on this machine, or anyone with
  admin access to it. The file is locked to that account, but it is not
  encrypted — a running machine offers no protection beyond that.
- **How long:** until it rolls over. Roughly 160MB of message text, then the
  oldest is dropped. That means I can read back the recent past, not forever, and
  I'd rather state the limit than imply I keep everything.
- **Deleting it:** delete the files. That's complete — nothing else holds the
  text.

I chose not to encrypt it, and that's a decision you can push back on. The
reasoning: encryption keys would sit on the same disk as the data, so it mostly
protects a switched-off machine, and doing it on every message adds real delay on
the path that has to stay fast. If you'd rather have it, that's a fair call to
make — it's written down as a choice, not left as an oversight.

One thing worth repeating: this is exactly why credentials shouldn't be pasted
into chat. Anything you type to me lands in that file verbatim.

## What changed at round 50: put it in a database, not a text file

I'd been storing this in a plain text file, one message per line, and defending
that as the simpler option. A reviewer added up what "simpler" actually required
me to build by hand: recovering from a half-written line, reading only the recent
end of the file at startup, remembering which messages it had already seen across
restarts, a lock file with rules about what happens when a process crashes, a list
of storage types to refuse to run on, and a self-test at boot.

That's not a simple option. That's a storage system I'd be writing myself, with
the actual fix buried inside it.

The reason I'd rejected using a small database was "that means migrating data".
**I checked, and it doesn't.** The database library is already here — it's what
powers conversation search. This would be a new table sitting beside the existing
one. Nothing moves, nothing converts. I'd been repeating that objection since this
morning without ever testing it.

Using a table deletes nearly all of the list above. Remembering what's been seen
becomes one line saying "this column must be unique". Half-written lines stop
being a thing that can happen. The lock file, the storage-type list, the file
rotation, the ordering rules — all gone.

**And the two-piece split I described below dissolves with it.** Every single
thing I planned to defer to "piece two" was only needed because of the text file.

I've written this as a recommendation with the old design kept underneath, rather
than just switching, because I'd formally handed you the file-versus-database
question earlier and it's not mine to quietly take back.

## The two pieces (this applies only if we keep the text file)

Review kept adding things the fix needed — a size limit on the file, what happens
if the machine dies mid-write, how long messages are kept. All fair. Together they
turned an afternoon's work into something much bigger.

Then a reviewer pointed out I'd tangled myself: I'd written down that the storage
choice might be wrong, and in the same document ordered someone to build the
entire elaborate storage system anyway. Both can't be true.

So it's split:

**Piece one — stop the loss.** Write each message down at the one place they all
pass through. Small, settled, nobody disputes it. It does *not* limit the file's
size, and that's a deliberate accepted risk: one machine, switched on on purpose,
with the size visible. Growing a file is a much better problem than losing every
message.

**Piece two — everything about keeping it.** Size limits, what happens on a crash,
how long things are kept, and crucially *what the file even is* — a plain text
file or a small database. That last question is genuinely open now, and deciding
it first means most of piece two's complexity might never need building at all.

**Practical effect: piece one could land far sooner than I'd been implying.**

## A pattern worth naming

Twice in this review I wrote a safety check that would have made things worse.

Once: if the program crashed, my rule said "don't start recording again until a
human checks" — which after any ordinary crash means silently back to losing
messages. Twice: I listed the disk types I trusted, and the list would have
refused to run on perfectly normal setups like containers and encrypted drives —
again, silently not recording.

Both times I'd been *careful*, and both times careful meant broken, in the exact
way the whole thing exists to prevent. The rule I've written down: when a guard's
failure mode is "stop recording", it has to lean toward running. The thing you're
protecting against is the not-recording.

## What this actually promises — corrected

I've been describing this as fixing the problem. A reviewer pointed out that
isn't quite what it does, and the distinction matters to you.

If writing a message down fails — a busy database, a full disk — the design
retries a couple of times, and if it still fails, **it drops the record and
delivers your message anyway.** It will not hold your message hostage to its own
bookkeeping; making you unreachable to protect a log would be exactly backwards.

So the honest promise is: **loss goes from silent and unnoticed for twenty-four
days, to flagged the first time it happens, with your message still delivered.**

That's a large improvement. It is not "no loss", and every other part of the
document was written as though recording always succeeds. Now it says so.

## What it doesn't fix

It does not stitch the two machines' halves together. After this, each machine
honestly records what *it* saw — which is what session startup actually reads, so
it solves the problem that bit us. A single merged view across both machines is a
bigger change and is deliberately left for later rather than smuggled in here.

It also can't recover what's already gone. Everything you have sent me since the
1st of July is lost on this machine, and stays lost.

## Why this document is short

Its companion — the message-gate design — ran to 2,700 lines and thirty-three
rounds of review without ever finishing, because every fix to one section left
two other sections describing the old behaviour, and each round of fixing created
more of them. The lesson written down from that: keep a specification small
enough that fixing it doesn't break it. This one is one problem, one place, one
switch.

That said — this one hasn't finished its review either. Thirty-eight rounds so
far, none of them clean. The difference is what the rounds keep finding: the big
one mostly surfaced contradictions I'd introduced myself, while this one is still
surfacing real things I'd missed — a whole alternative design, an unbounded file,
a privacy question nobody asked for thirty-three rounds. It's also true that
roughly one problem per round is one I created in the previous round, which is
why it hasn't settled. Every round's outcome is written into the commit history
as it happens, so where it actually lands is a matter of record rather than of me
remembering to mention it.
