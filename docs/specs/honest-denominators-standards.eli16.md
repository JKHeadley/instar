# Honest denominators, part two: the tool that grades our own rules was grading a quarter of them

## What this actually is

We keep a constitution — a document of standards the agent must hold to. We also have a tool that
reads it and answers one question: *for each standard, does a real guard exist that enforces it?*
It reports a single headline number.

On 2026-07-25 that number read **4.55% enforced**, sitting next to the word **"converged: true"**.
Both were misleading, in three separate ways, and the agent reading them quoted the alarming
figure onward as fact.

## Defect one: the ratio was computed over a quarter of the constitution

The constitution has **81 articles**. The tool was reading a copy with **22**.

Read in full, the real figure is **53.75% enforced** — 43 of 80 standards held by a test, a gate,
or a linter. Not four percent. The arithmetic was never wrong; it was arithmetic over a
denominator nobody could see, and the visible result was **twelve times more alarming than
reality**.

This change does not fix which copy gets read (that is a separate, tracked piece of work — see
"What this does NOT fix" below). It fixes something more important: **the number can no longer
appear without the denominator it was computed over.** Every response now carries how many
article headings were found, how many parsed, which families were seen, how many bytes were read,
and whether the audit's own canary vouches for any of it — plus an explicit
`assessmentTrustworthy` flag. A fragment can still be measured. It can no longer pose as the
whole.

## Defect two: a whole family of standards was invisible by construction

To find the articles, the parser held a list of five section names. The constitution has **six**
sections of standards. Everything under the sixth — currently our self-hosting standard — was
silently discarded. No warning, no count, nothing.

A name list can only ever be as current as the last person who remembered to edit it. So the list
is gone. A section now counts as a family of standards **because of its shape**: it is a family if
at least one heading under it carries a rule. The prose sections (Genesis, Why this exists, The
Stakes) carry no rules, so they are excluded automatically, and the next family someone adds is
picked up with no code change at all.

## Defect three: the guard against silent dropping could not detect a fourfold collapse

There is a safety check meant to catch exactly the failure above — the parser quietly losing
articles. It worked by comparing the parsed count against a floor of **15**, written when the real
count was about 21.

The constitution grew to 81. The floor never moved. So by now that check would have passed
cheerfully while **65 of 81 articles vanished**. A guard whose threshold never grew with the thing
it guards is not a guard.

The floor stays as a coarse backstop for a total collapse, but the real check is now a
**completeness comparison**: count the article headings actually present in the document, count
how many parsed, and fail — naming each lost heading — if those two numbers disagree. That needs
no maintenance as the document grows, because the document supplies its own denominator.

## Defect four: a word that meant one thing and read as another

`converged: true` has only ever meant "this deterministic pass is stable — re-running it on
unchanged inputs gives the identical answer". It has never meant "the standards are healthy".

Sitting bare next to a percentage, it read as the second thing. The meaning now travels with the
field, so nobody has to know the history to read the response correctly.

## And a fifth, smaller one

A **missing** constitution used to hash identically to a **present but empty** one, so the two
states shared a cache slot. Same shape as everything else here: absence and emptiness rendering
as the same thing. They are now distinguishable.

## What "nothing measured" now returns

The rule from part one, applied here: **when there is nothing to divide by, there is no ratio.**

The old code returned `0` in that case. That is not the flattering answer — it is the *alarming*
one, which is arguably worse, because a frightening number is the one a reader is least likely to
question. Either way it states a measurement that was never taken. The field is now `null`, and
callers are told in the type not to coerce it back to a number.

## What this does NOT fix

The **stale copy** itself. The tool still reads the copy in the agent's own directory, and the
updater that should keep that copy current classifies our drifted version as "customised — leave
it alone", so it stays frozen. Fixing that is migration work with install-base reach, and it is
tracked separately rather than bundled here.

What changes today is that the stale copy can no longer be *silent*: the audit now reports a
22-of-81 read as untrustworthy, with the counts visible, instead of as a confident 4.55%.

## How you know it works rather than merely exists

Three things were made to refuse something they previously waved through:

1. Point the audit at a registry contributing no standards → it returns `null` and
   `assessmentTrustworthy: false`, where it used to return `0`.
2. Give the parser a family with one heading missing its rule → the canary **fails and names that
   heading**, where the old floor passed it silently.
3. Point the live endpoint at a truncated constitution → it comes back flagged untrustworthy with
   the fragment's real denominator, where it used to answer with a bare, confident ratio.

All three are covered at unit, integration, and end-to-end level.

## The pattern this belongs to

Sixth instance of one shape found on 2026-07-25: **the absence of information rendering
identically to the presence of good information.** An empty map scoring 100% fresh. A commit
banner that blocked nothing. A parse that dropped a family with no signal. A floor that could not
detect a collapse. A ratio over a quarter of its subject.

In every case the guard was present, wired, and mathematically incapable of reporting the failure
it was written for. The fix is never "be more careful" — it is that a figure must carry what it
was computed over, and must refuse to answer when it has nothing to answer with.
