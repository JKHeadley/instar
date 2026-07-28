# ELI16 — The honesty check had a blind spot shaped like a bracket

## What this check is for

When the agent is running a long timed job, it sends progress notes. Those notes
often say how long it's been going. There's a guard that reads each note before it
goes out, compares any elapsed-time claim against the real clock, and hands the note
back with a complaint if the numbers disagree.

It exists because an agent stating a confident, wrong number about itself is a
particularly corrosive kind of error: it's unverifiable to the reader, and it makes
every other number in the message worth less.

## What went wrong

During a long session I twice stated elapsed times I hadn't checked. Once I said
forty minutes when fourteen had passed. Once I said an hour and ten minutes. Both
went out without a murmur from the guard.

The obvious conclusion was that the guard was switched off or broken. It wasn't. I
tested it against my own bad messages on the live system and it worked correctly —
fed one of them, it caught the contradiction and quoted the real clock back.

The actual cause is narrower and stranger. The guard recognises phrases like:

- `40 min in.`
- `2h in)`
- `7.5 hours in:`

It has to be picky, because "in" is a slippery word. `3h in CI` means three hours
spent *in* a place, not three hours elapsed — so the guard only treats "in" as a
time marker when what follows it is punctuation rather than another word.

The punctuation list included a **closing** bracket and not an **opening** one. So
`40 min in.` was checked and `40 min in (iteration 1)` was invisible — not
"checked and passed", but never recognised as a time claim in the first place.

Both my bad messages used the bracket form, because writing `(iteration 1)` after a
progress figure is the natural thing to do.

## The fix

Add the opening bracket to the list. One character class.

There's a trade, and it's worth being explicit rather than pretending it's free.
`2h in (CI queue)` will now be read as an elapsed claim when it probably means a
place. That's a false alarm.

I accepted it deliberately, because the two errors aren't equal. This guard doesn't
block anything — it hands the message back with a note. A false alarm costs me one
re-read. A miss costs the operator a confidently stated wrong number about how long
something has been running. This session provided direct evidence for which of those
actually happens.

The picky rule itself is intact: "in" followed by an actual word is still not a time
marker, and there are tests pinning that so the widening can't quietly erode it.

## One thing left alone on purpose

My other bad claim — fifty-seven minutes when the truth was forty-five — got through
for a completely different reason. The guard tolerates a fifteen-minute margin so it
doesn't nag about rounding, and twelve minutes is inside that.

That's working as intended, and tightening it would cause real false alarms, so I
left it and wrote it down instead. It's worth knowing as a property, though: early
in a run that fixed margin covers a proportionally huge range. Fourteen minutes in,
anything up to twenty-nine minutes passes unchallenged.

## The pattern worth remembering

I nearly reported a second, much bigger defect during this investigation — the
detector appearing to extract a claim correctly and then fail to compare it. That
turned out to be my own test passing an argument of the wrong shape. Checking the
function signature before reporting saved a bad bug report.

Which is the same failure as the original one: trusting a result without
interrogating how it was produced.
