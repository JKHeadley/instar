# Why my memory keeps believing things that stopped being true — in plain English

## The one-sentence version

When I automatically write something down about a session, I write it down as if it
were permanent — so "the build is red right now" gets stored with the same
forever-ness as "Justin prefers plain writing", and months later I read it back as if
it were still true.

## What's actually happening

I have a memory store. Every time a session produces something worth remembering, a
background watcher extracts the interesting bits and saves them. Each saved item has a
slot for an expiry date — a "forget this after" field.

That field has never once been filled in. Not "rarely" — **never**. I checked the
store on 2026-08-24: 1,731 items saved, and all 1,731 of them have an empty expiry.

So there are two pieces of machinery in my code whose entire job is to drop expired
memories, and neither has ever had anything to act on. They look like they work. They
have simply never been handed a single item to consider.

## Why that's worse than having no memory at all

There are two costs.

**The obvious one:** stale statements come back as facts. A note that a pull request
was on hold, or that something was broken, gets read into my context at the start of
every future session — long after it was fixed. Confidently wrong memory is worse than
missing memory, because I act on it.

**The less obvious one:** space. My memory export has a hard word budget, and it's
already badly oversubscribed — we measured it at about 7,100 words trying to fit into
5,000, with most of history getting cut. Every dead status note that survives into that
window pushes out a real, durable lesson. It isn't just noise; it's noise that evicts
signal.

## The thing this document actually fixes — and the wrong turn it avoids

The original proposal said "this needs no code, just tell the extractor to set an
expiry." That sounded right and was wrong, and finding out why is the useful part.

The "extractor" isn't an assistant reading instructions. It's a piece of code. When I
looked at what actually writes to the store, 99.4% of the items came from that one code
path — and the data shape it uses **has no expiry field in it at all**. So the model
doing the extraction couldn't have said "this is temporary" even if the instructions
begged it to. There was no box to tick.

Changing the instructions would have touched about 0.7% of the writes while looking
exactly like a fix. That's the trap this whole document exists to step around: checking
a plan at the place the work actually happens, before building it.

## How the fix works

Add the missing box. The extraction now gets one optional yes/no field: *is this a
statement about how things are right now, rather than something that stays true?*

Three deliberate choices:

1. **The model says "temporary." The code says "for how long."** The model never picks a
   date. It just labels the kind of statement. Code turns that label into a deadline —
   48 hours by default, and it physically cannot be shorter than 6 hours or longer than
   30 days, no matter what any config file says. A model that could write its own
   deletion dates could write a bad one.

2. **Silence means permanent.** If the field is missing, malformed, or the model just
   doesn't answer, the item is stored exactly the way it is today. So on day one,
   nothing changes for anything that isn't clearly labelled temporary.

3. **Nothing gets deleted yet.** This is the important safety bit. It turns out that
   filling in an expiry date wakes up a piece of code that genuinely *deletes* the item.
   So the first release fills in the dates but keeps the deletion switched off. The
   expired items just stop being included in what I read at startup — which is the whole
   benefit anyway — while staying on disk where they can be inspected. If the labelling
   turns out to be wrong, we find out by looking, not by discovering something valuable
   is gone. Actually deleting anything is a separate decision made later, on evidence.

There's also a fiddly-but-real edge case: when the same thing gets mentioned twice, the
code reuses the existing entry. So the rule is that a permanent memory can **never**
retroactively acquire an expiry just because someone mentioned its name again in a
throwaway way, while a temporary one that gets re-observed has its clock pushed back,
because seeing it again means it's still happening.

## How we'll know it actually worked

Re-run the count. If, after a round of sessions, some items finally have expiry dates on
them and they turn out to be the status-shaped ones, it worked. If it's still 100% empty,
then the change went into the wrong place — the exact mistake that produced this
document in the first place, and the reason the check is written down instead of assumed.
