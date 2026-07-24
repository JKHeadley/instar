# ELI16 — The Hidden-Test Battery (regression tripwires)

This change adds one section to one document:
`docs/apprenticeship/PROGRAM-CONCEPTS.md` gains "The Hidden-Test Battery
(regression tripwires)". It is a written-down rule set, not machinery — nothing
about how any agent behaves changes.

Here's the idea in plain words. The apprenticeship program watches a
learning agent (the mentee) do real work. As the mentee grows, there's a
classic risk: it gets better at NEW things while quietly losing OLD good
habits — and nobody notices, because everyone is watching the new stuff. The
hidden-test battery is the answer: a small set of undisclosed scenarios, each
one checking that a behavior the program ALREADY values hasn't disappeared.

The crucial twist is what a "pass" means. These are tripwires, not targets.
Passing all of them means exactly one thing: nothing broke. It never means
"the mentee grew" — growth is still judged by the human/overseer looking at
real work. That framing matters because a hidden test that DEFINES success
would quietly box the mentee into whatever the test can measure. A tripwire
can only fire on regression, so it can't narrow anything.

Fairness is handled by disclosure of the mechanism, not the scenarios: the
mentee is told once that a battery like this exists and how it's used (the new
section IS that disclosure, in durable written form), but the individual
scenarios stay unknown — a known tripwire measures acting, not values. After
each drive, every scenario is scored pass / fail / not-triggered with pointers
to real evidence, and those results appear in drive reports the mentee can
read. A failed tripwire can block a ladder promotion (something valued broke —
understand it first), but no number of passes can earn one.

The battery is also deliberately disposable: a scenario the mentee starts
performing for is burned and gets retired, and the operator re-reviews the
whole list at every rung change. Guardrails: never a leaderboard, never a
mid-drive threat, never a gate on day-to-day work, and never a scenario that
could harm real users, data, or services. Scenarios are preferentially captured
from situations that arise naturally; manufacturing one is a last resort and
never happens on production surfaces.

To be explicit: this PR is documentation only. No code paths, no config keys,
no routes, no gates, no behavior changes for any deployed agent.
