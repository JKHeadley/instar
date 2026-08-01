# Audit convergence must leave two kinds of proof

## What is wrong today

Instar already has a strong rule for audits: do not look once and call it done.
An audit must record what it found, fix or deliberately classify each finding,
look again, and finish only when a fresh pass finds nothing new. A validator
enforces that shape before it lets an audit report say “converged.”

That validator currently checks only the first half of what Justin asked audits
to produce. It proves there is a path for every finding—fixed, accepted for a
written reason, or durably tracked—and that the audit re-ran to zero. It does not
require the second, more valuable artifact: what kind of blind spot allowed the
problem to exist, why the earlier controls missed it, and what standing standard
should change because of that lesson. An audit can therefore close every row and
still throw away the knowledge that would help the next audit start smarter.

## What this changes

Every audit report that wants the machine-earned “converged” stamp will also name
three things in its frontmatter:

- a reusable blind-spot class—not just the individual bug;
- a short causal meta-insight explaining how the class arose and escaped the old
  controls; and
- the constitution’s response: a standard was created, a standard was amended,
  or the existing standard was already correct and needs no change.

All three standard-response choices must point to an exact real article in the
Standards Registry and explain why that choice is honest. The article gets a
stable ID, so later title cleanup cannot rewrite history. The report freezes the
path, title, and ID that existed when it converged, and CI reconstructs that
historical commit. The blind-spot class uses a short reusable slug so later
reports can reuse and count the same class. The validator does not pretend it can
judge whether prose is insightful or an article is philosophically perfect; that
remains a PR review decision.

The stamp tool writes one digest for the frozen standards response and another
for the whole meta-artifact. If the response identity changes, it must earn new
standards evidence. If only the rationale or causal explanation changes, it must
be re-stamped without forcing a fake constitutional edit. These digests are
staleness alarms, not proof that the prose is true or approved.

## Why “no change” is allowed

Sometimes an audit discovers that the constitution already says the right thing
and the failure was missing enforcement. Forcing a brand-new rule in that case
would make the registry noisier and reward invented lessons. So “no change” is a
first-class answer, not a loophole: it still has to cite the existing standard
and explain why it already covers the blind-spot class. There is no escape from
naming the class or explaining how it escaped.

When a report says it created or amended an article, the validator compares the
stable-ID article block before and after the change. A filename appearing in the
same commit is not enough; the article's content must have the claimed change.
When a new or changed report says no change was needed, the exact article must
resolve in that candidate change and the choice is counted loudly for reviewers.

## Compatibility and safety

Only one committed audit currently carries a convergence stamp. It will be
backfilled honestly: its blind spot was that accountability mechanisms existed
in isolated places while coverage checks never required provenance, outcome
grading, and real-prompt parity at every LLM decision point. The existing
“Decision Provenance & Outcome Review” standard already names that class, so the
report will use the honest no-change response.

Old validators ignore the extra fields, and the new validator leaves the
existing convergence timestamp untouched while adding a separate timestamp for
the new artifact. A malformed meta-artifact blocks only the claim that an audit
is converged; the report can always be committed without that stamp as honestly
incomplete. The structural stamp can be created before a PR; it does not claim
that review happened or stayed fresh. Nothing changes in runtime messaging,
databases, sessions, or user data.

## The decision

Approve a sixth convergence condition: every completed audit must preserve both
what it did about the findings and what the system learned about the blind spot,
including the historically pinned standard response that carried that lesson.
