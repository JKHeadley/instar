# Retiring constitutional rules without breaking the ones that cite them — plain-English overview

## The situation

An audit found 29 rules in the constitution whose original incident can no longer happen. The
operator ruled: retire them — but with two conditions. Their spirit must live on in a
higher-order rule *where possible*, and retiring a rule must never make it safe to delete the guard
that replaced it.

Applying that literally hit a wall, and the wall was measurable. Four of the 29 have **nothing above
them** to absorb into. One is the constitution's single root principle, whose own text says every
other rule is an instance of it. And if "retire" meant "delete", 27 surviving rules would be left
citing rules that no longer exist, and 5 of the 6 declared parent-child links in the document would
break — a link an existing build check requires to resolve.

That went back to the operator rather than being guessed. The ruling that came back: retire the 25
that are settled, relabel the root principle rather than retire it, and hold the other three live
with a dated owner each.

## What this change does

**25 articles get a retirement record** at the top: retired on this date, this is what superseded the
original failure, this live article now carries its obligations, and the text below is kept as a
record rather than a rule in force.

**The root principle is relabelled, not retired.** Its provenance said it was "earned from" an
incident; its own text already said it is a founding lens rather than a single failure. So the label
becomes "Grounded in" — which is exactly what a separate ruling in the same package said to do with
principles mislabelled as incident-earned.

**Three articles are held live with a dated owner.** Each says why it is held, what would unblock its
retirement, and who owns building that. "Held" without a date becomes permanent by accident, which is
the deferral pattern this constitution has an article about.

## Why "archival" means the text stays

This is the load-bearing decision, and it is the reason the change is safe.

If a retired article's body were stripped, the tool that reads the constitution would stop seeing it
as an article at all. The count would fall from 87, every section's enforcement score would move, and
every rule that cites the retired one would point at nothing. The operator's second condition exists
to prevent precisely that kind of collateral breakage.

So the article keeps its text and gains a record saying it no longer governs. Nothing is destroyed,
the successor is named, and every reference still resolves. Measured after the change: 0 surviving
articles declare a retired parent, and 29 citations into retired articles all still resolve.

## What you actually need to decide

Whether "retired but still readable" is retirement enough for you. The case for it is that it
satisfies the ruling's words — each retired rule keeps a record naming what superseded it — while
costing nothing. The case against is that a reader could mistake preserved text for a live rule; the
mitigation is that the record says, in the first sentence, that it does not govern.

The stronger form (actually removing the text) is available, but on today's measurement it breaks the
parent-relation check and orphans 29 citations. That cost is stated here rather than discovered later.

---

## Follow-up: making sure a retired rule never strands a reader

An independent review of the ruling added five conditions. The one that changed real work: **every
citation pointing at a retired rule must redirect the reader.**

There were two ways to do that, and the obvious one is wrong.

**The tempting version** is to find every mention of a retired rule and replace it with the name of
the rule that replaced it. That breaks meaning. One live rule says *Intelligence Infers, Keywords
Only Guard* "forbids a regex from making it" — that is a claim about what **that** rule says. Swap in
the successor and the sentence now asserts the successor forbids it too, which may simply not be
true. A redirect that quietly rewrites a claim is worse than no redirect.

**The version used** adds rather than replaces. The citation keeps its subject and gains a short
marker: `(retired 2026-08-13 → *Signal vs. Authority*)`. The sentence still says what it always said,
and the reader is forwarded in the same breath, without a second hop.

## The part that will still be true in six months

The 39 markers are the easy half. Keeping them true through every future edit is the half that rots
— someone retires another rule and forgets to forward its citations, or renames a successor and
leaves the markers pointing at the old name.

So there is now a check that runs on every build. It refuses if a retired rule names no live
successor, if it names one that is *itself* retired (a redirect into a dead end), if any citation
site lacks a marker, or if a marker disagrees with the retirement record. This is the constitution's
own root principle applied to itself: if a behaviour matters, enforce it in structure rather than in
remembering.

## Two mistakes worth knowing about, because they were mine

The first redirect pass marked only the **first** mention of each retired rule per article. One line
cites three retired rules and came out with one marker — 29 sites covered instead of 39. The new
check caught it.

Then the check itself produced a **false alarm**: on a line citing several retired rules, it read a
neighbouring citation's marker and reported a mismatch that did not exist. Fixed by anchoring the
check to the citation it is actually inspecting.

Both are recorded rather than tidied away, because a checker that reports problems that are not there
is exactly as dangerous as one that misses real ones — and this project keeps finding that shape.

## What a reviewer should actually look at

Not the 39 markers. Look at whether the **check** is right, because the markers are only as durable
as it is. It was verified the honest way: the defect was put back — one rule's markers stripped — and
the check failed, naming the stranded citation. Then restored, and it passed. A guard that has only
ever been green is being trusted, not checked.
