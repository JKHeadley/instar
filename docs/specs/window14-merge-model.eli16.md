# Merging standards instead of retiring them — plain-English overview

## What happened

A plan to **retire** 25 constitutional rules was applied and merged. The operator then rejected the
model itself. His objection, in his words:

> "if the lower level standards are retired, the higher level standards may not have the level of
> specificity needed for the development process to avoid the pitfalls that the retired standards
> represent"

That is the whole problem in one sentence. A high-level rule like "review side effects" does not tell
a developer the specific thing a low-level rule told them. Retire the specific one and you keep the
principle while losing the tripwire — and the tripwire is what actually catches the mistake.

## What replaces it

**Nothing is retired. Everything stays live.** The 25 rules keep their full text and remain binding.
What changes is that each one now says which rule it sits under, and each parent now lists its
children **by name, with the specific tripwire each one carries.**

So a developer reading the parent no longer sees a pointer — they see the specific conditions, and
can read the child in full. The specificity survives at both altitudes.

The retirement records and the citation-forwarding markers from the previous model are removed. They
were solving a problem that no longer exists: if a rule is live, a citation to it resolves to live
text.

## Why the rules were not physically moved

The obvious reading of "subsection" is to nest each rule physically inside its parent. That was
measured before it was rejected: **13 of the 25 have a parent in a different family**, so moving them
would shift articles across family boundaries and change every family's enforcement score and
committed floor. The ruling says the coverage check stays and nothing leaves the live surface — a
wholesale renumbering serves neither. So the merge uses the tree convention the registry already had,
which is the mechanism the operator himself pointed at.

## Two new rules he ordered

**Every new standard must say where it goes in the tree** — updating an existing one, becoming a
child of one, or becoming a new root. His diagnosis: the 25 duplicates existed *because* this was
never enforced. A new lint now refuses a standard that declares no placement.

**References must run from both ends.** The registry already names the code that enforces each rule;
now the code must name the rules that govern it. A one-way link decays silently — someone deletes a
guard with no way to know a standard depended on it.

## What is honestly incomplete

Both new lints ship with baselines that may only shrink: 57 of 88 articles have no declared placement
yet, and 27 of 50 enforcement files carry no back-reference. That prevents things getting worse; it
does not finish the job. An independent reviewer called the second one the biggest remaining risk,
and it now carries a dated deadline and an owner rather than an open-ended ratchet.

The alternative was writing 27 back-references and 57 placements in one pass — by resemblance rather
than knowledge, which is precisely the unconsidered placement these rules exist to prevent.

## What a reviewer should look at

Not the field additions. Look at whether the **parent lines** actually carry the specificity: pick a
parent, read what it says its children contribute, then read a child and ask whether a developer
following the process would still hit that tripwire. That is the operator's test, and it is the one
thing here that no lint can check.

---

## Follow-up: the checks were checking the wrong thing

An independent review found that all three checks I had written were verifying that a **declaration
had been typed**, not that the **relation was real**. A parent could stop naming its child, or a
child could lose the tripwire it contributes, and every check would stay green.

That is worth sitting with, because it is precisely the failure the ruling those checks serve was
written about: a gate on the paperwork rather than the behaviour. I built three of them inside the
enforcement for it.

**What the checks do now.** For every merged relation: the parent must be a real live standard, the
child must state the specific tripwire it contributes, and the parent must name that child back
*with that same tripwire*. Both directions, both halves. The count of relations the tree checker can
actually see went from 13 to 39 — the 25 merged ones had simply been invisible to it.

The back-reference check no longer accepts a bare `Governed by:` marker with nothing resolvable after
it. Measured first: no file was actually passing that way, so closing it cost nothing and removed the
shortcut before anyone reached for it.

## What fixing them turned up

Two bugs inside the fixes, both found by breaking them on purpose rather than by reading them. One
matcher broke on the single article whose title contains italics. The other looked 400 characters
past a child's name for its tripwire — so on a line listing several children it found the *next*
child's tripwire and passed. That one was a guard that could not fail.

And one real structural problem in the constitution itself, which only became visible once the
relations were: one standard ended up with **two parents** — the one it already declared, and one my
merge had added. An article with two parents has no place in a tree, and the hierarchy renderer
refused to draw it.

The fix is a distinction worth keeping: **what supersedes an incident is provenance; where a standard
sits is parentage.** The merge had quietly conflated them and re-parented a standard that already had
a settled place. It now respects the existing parent. Exactly one of the 25 was affected — counted,
not assumed.

## What a reviewer should take from this

The registry got safer in a way that has nothing to do with the text: three checks that would have
reported success while the structure rotted underneath them now fail when it does. The evidence for
that claim is not that they pass — it is that each one was broken on purpose and each one failed.
