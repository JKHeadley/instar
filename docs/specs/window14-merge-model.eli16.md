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
