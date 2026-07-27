# A section number could hide an unanswered question

## The short version

Before a design document is allowed to be marked "finished", an automatic check
looks for any question still parked on a human — something the author flagged as
needing a person's decision. If one is still sitting there, the document cannot be
stamped as done. That check is supposed to be impossible to talk your way around;
the process notes describe it as structural, meaning it is enforced by code rather
than by anyone remembering to look.

It had a blind spot, and the blind spot was punctuation.

The check searched for a section headed exactly `Open questions`. Plenty of
documents number their sections, so the heading reads `9. Open questions` instead.
For those, the search found nothing — and the code then treated "I found no
section" as "there is nothing outstanding". Those are two completely different
statements, and collapsing them meant a real, unanswered question could sit in
plain sight in the document and be entirely invisible to the thing whose one job
was to notice it.

## How it was found

Not by reading the code and reasoning about it, which is how you talk yourself
into believing a regular expression works. It was run, on a document that uses
numbered sections, with a deliberate control: the same live question was placed
under a numbered heading and under a plain one. The plain heading caught it. The
numbered heading reported nothing outstanding. That is the whole proof, and it
took under a minute.

## The part that made it obvious rather than debatable

Eight lines further down the same file, a sibling check does the same kind of
lookup for a different section — and on exactly the same numbered heading it
does the opposite thing: it refuses, loudly. So one file contained two checks,
written separately, that disagreed about what to do when a heading did not match.
When two things measuring the same quantity have opposite defaults, one of them is
wrong without anyone needing to make a judgement call about which behaviour is
nicer.

## What changed

Both checks now recognise the same set of heading shapes — plain, numbered,
lettered, dotted, with brackets, and with a trailing note like `(round 2)` — and
they share a single piece of matching logic rather than each having their own.
That sharing is the real repair: the blind spot existed because someone had
already improved heading handling once, and the improvement landed on only one of
the two checks. Now it cannot.

One thing was deliberately left alone. If a document has no such section at all,
it is still treated as having nothing outstanding. Whether that should instead be
a refusal is a genuine question worth deciding on its own merits, and quietly
changing it inside a fix about punctuation would be the same kind of shortcut this
change exists to close.

## Why you would care

If you are ever handed a design document to approve, the promise is that no
question needing your decision was left buried in it. That promise was slightly
weaker than advertised for any document that numbered its sections. It is now as
strong as it was described.
