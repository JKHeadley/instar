# Two thousand problems that are actually eight hundred — Plain-English Overview

> The one-line version: we record the things this system notices in three separate places, and
> nothing has ever looked at all three together. When you do, two thousand unresolved items turn
> out to be about eight hundred actual problems — and sixty-nine of those have been noticed over
> and over without anyone ever picking one up.

## The problem

When something goes wrong or looks off, it gets written down. Sometimes to the attention queue —
things a person should see. Sometimes to the action queue — things we committed to doing. Sometimes
to the watchers' log — things the automatic monitors spotted.

Three lists. Nothing reads across them. So the same underlying problem gets written down again and
again, in different places, and every entry is individually true and individually small. Read one at
a time, it looks like an enormous pile of unrelated work. Nobody can see that it's mostly the same
handful of things repeating.

## What this does

It reads all three, and groups entries that are really the same problem said slightly differently —
"3 topics stranded" and "17 topics stranded" are one problem, not two. Then it reports the shape.

On our actual data, right now:

- **2,068** unresolved things noticed
- **836** distinct problems underneath them
- **69** problems account for **1,242** of those noticings, and **not one** has ever been turned into
  actual work

The three biggest, which nobody has seen grouped before: an idle-timeout check firing 278 times; an
alert being suppressed 238 times because notifications are switched off — a watcher carefully
deciding not to tell anyone, over and over, and logging that decision; and one component's warnings
177 times, which is nearly half the attention queue on its own.

None of these are new. They have been sitting there being noticed. What was missing was anything
looking at them together.

## The part built in deliberately

There's an obvious way this tool could become worse than useless: if it can only read two of the
three lists and still says "nothing recurring found". That would be the original problem wearing a
badge — the same blindness, now with the authority of having looked.

So it doesn't do that. If a list can't be read, it says which one and why, reports what it did see,
and **gives no verdict at all**. Not a hedged verdict — none. "There's nothing there" and "I couldn't
look" come back as visibly different answers, and a caller can't accidentally treat the second as
the first.

That was tested by deliberately breaking one of the lists. It found 59 problems in what remained and
refused to draw a conclusion.

## What it does not do

**It only reports.** It doesn't act, doesn't queue work, doesn't notify anyone. That's on purpose —
the next piece is making it drive real action through the paths that already exist, rather than
becoming a fourth list of things nobody reads. Adding another notification channel would be the
funniest possible way to fail at this, and it's the specific thing to avoid.

**It doesn't judge whether a problem matters.** It reports that something recurred 278 times and
nobody picked it up. Whether that's urgent or fine is a human call, and grouping doesn't make it.
