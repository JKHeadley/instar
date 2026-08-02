# Decision Quality Enforcement Teeth — ELI16

Instar already has a list of model-backed decision areas. The live updated runtime
now says 39 are wired, 19 are pending, and 6 are exempt, with the same total of 64
it had before the enrollment. But it is still a list written by people. It does not
prove that every actual place in the program that calls a model is represented
once.

That distinction matters. One list row can hide two different model calls. A stale
row can name a feature that no longer calls a model. A helper can hide a call from a
text search. If the list and the program disagree, a percentage calculated from the
list can look complete while real calls remain invisible.

This spec gives the list enforcement teeth.

First, a TypeScript compiler tool walks the same production program that the build
checks. It follows types, so it finds model calls even when the variable is called
`brain` instead of `provider`. It ignores unrelated methods that merely happen to
be named `evaluate`.

Every model-call expression must then be one of two things:

- a decision origin, where a real semantic judgment begins; or
- an infrastructure forwarder, where the router, queue, breaker, or provider passes
  along a judgment that was already identified.

The second category prevents double-counting. A single decision may travel through
the router and a provider, but it is still one judgment. Forwarders remain visible
and checked; they just do not pretend to be extra decisions.

Each decision origin must use one stable imported decision ID. Two model calls in
one larger workflow get two IDs plus one shared composition ID. A generic helper is
not allowed to hide several different judgments behind one vague identity.

The first implementation does not have to pretend the nine known identity repairs
are already solved. It may mark only those exact current callsites as
`repair-required`. That list can shrink but cannot grow or swap in different sites,
and none of its rows can be called wired. This lets the compiler establish the real
denominator first while leaving the design-heavy identity work honest and visible.

The compiler produces a small generated manifest containing source identities and
shape only. It contains no prompts, messages, responses, screenshots, terminal
output, or secrets. Continuous integration regenerates the manifest and refuses any
difference that was not checked in deliberately.

The executable callsite set and the invocation census must match both ways:

- every real decision-origin callsite must have one census row; and
- every invocation census row must have one real callsite.

This is stronger than checking only that new calls appear in the list. It also
catches stale rows, duplicate identities, hidden multi-call rows, and entries that
claim to be wired without proving they reach the shared router.

Aliases and delegates that do not actually call a model move to a separate human
catalog. They remain documented, but they no longer inflate the denominator or its
coverage percentage. For one release, old readers receive clearly labeled legacy
and new totals side by side.

Runtime records also name the callsite and manifest revision. That lets Instar tell
the difference between “the source says this call exists” and “the running system
actually observed and settled it.” A call with no traffic is not falsely called
working. A failure or timeout still settles against the same identity.

The second half fixes the grading queue.

Today the hourly grader has 200 seats divided equally among five decision points.
If four points have nothing ready, 160 seats go unused while the busy point is still
limited to 40. Worse, if the budget is smaller than the number of points, the
current minimum-one rule can inspect more rows than the supposed global limit.

The new default is 500 inspected rows per pass, with a real global cap. The grader
first gives every point a fair allocation. Empty, waiting, or backed-off points hand
unused seats back. Busy points then reuse those seats in a rotating order. If there
are fewer seats than points, the starting point moves durably between passes so the
same tail cannot starve forever.

The budget counts every row the grader examines, not only rows that receive a new
grade. The read surface shows allocated, inspected, graded, reclaimed, and unused
capacity, plus why each point stopped. That makes “we visited 500 rows” impossible
to present as “we learned 500 correct outcomes.”

Nothing here gives a model new authority, sends data elsewhere, changes prompts, or
manufactures ground truth. It makes the source denominator exact and uses existing
deterministic grading capacity efficiently. The nine identity repairs and ten
blocked or stale rows remain real follow-on work, now against a denominator the
repository can prove.
