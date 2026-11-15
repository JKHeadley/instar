# Decision-quality statistics stop freezing the server — Plain-English Overview

> The one-line version: each time one of the agent's judgment calls was graded, the server redid a sum by reading its whole table of grades; it now reads only the grades that belong to that sum, which gives the same numbers about fifty times faster.

## The problem in one breath

The agent keeps score of its own judgment calls. Each call (for example, "is this message fine to send?") is recorded, and later a grade may be attached: right, wrong or unknown. For each kind of call and each day, the server keeps a small running total of those grades.

Whenever a grade was added, the server recomputed that one day's total. The way it did so first worked out the "winning" grade for every graded call it has ever recorded (about 62,000 on the Studio) and only then picked out the day it wanted. That took about a tenth of a second, and it was done twice per grade. A grading job adds up to 200 grades in one go, with the server able to do nothing else meanwhile. On 2026-11-13 at 5:00 AM that took over a minute, the server stopped answering, and its supervisor killed it together with the test run in progress.

## What already exists

- **The record of calls and the record of grades** — two tables in the agent's metrics database.
- **The winning-grade rule** — when a call has several grades, one wins: the strongest kind of evidence first, then "wrong" before "unknown" before "right", then the newest. This rule is defined once, as a database view, and everything that reads grades uses it.
- **The daily totals** — small tables recomputed from the records whenever a grade lands, so they can never drift from the truth.

## What this adds

The recompute of one day's total now works out winning grades only for that day's calls. The rule is the same; it is simply applied to a few hundred rows where it used to be applied to all of them.

## The new pieces

- **The rule as one shared piece of text.** The ranking that decides the winning grade is now written once and used both by the view and by the faster recompute, so the two cannot come to disagree.
- **A recompute that looks only at its own day.** It first finds the calls of that kind on that day, then ranks only their grades.

## The safeguards

**Same numbers.** Tests build hundreds of random calls and grades (several graders, every kind of evidence, regrades, calls at the first and last millisecond of a day) and require the totals to equal what the view gives, exactly. On the Studio's real database, six real days gave identical totals both ways.

**Proven not to read everything.** A test asks the database how it will run the new query and fails if it would read through the whole grades table. The same check on the old query shows that it did.

**Faults are caught.** Shifting the day's edge by one millisecond, or swapping the order of "right" and "wrong" in the rule, makes tests fail. Both were tried.

**Nothing else reads differently.** The dashboards and reports still use the view. Only the recompute after each grade changed.

## What is not fixed by this

Adding 200 grades still happens in one go on the server's main thread; it now takes about a second or two where it took a minute or more. The other reads that go through the view (reports over many days) are unchanged and run when someone asks for them.

## What you actually need to decide

Nothing. No stored data changes; a revert restores the old query.
