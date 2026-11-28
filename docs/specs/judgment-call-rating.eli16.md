# Judgment-call rating, in plain words

## What this is

Some of our rules cannot be checked by a script, because they depend on judgment: is this change
risky enough to need the careful process, did the reviewer really think about the risks, is this
message something the person needs to see. The standards call these rules "judgment-bound" and
promise two things about them. The judgment is made with enough context, and every such judgment is
written down with its context so it can be graded later. The second promise has a deadline,
21 December, and today nothing grades these calls.

## What already exists

Every time the agent commits a change to Instar, a check runs first and saves a small record of
that commit: how big it is, how risky the check thinks it is, and how risky the agent declared it.
The agent's written risk review is saved in the repository too. Its short reasons for the risk
level are usually saved as well, but only when the agent remembers to add them, often later, and
the file can be rewritten. What is missing is a record that reliably keeps the call's context, and
anyone actually grading the calls.

The CI check that makes sure these records exist works per pull request, and it does not look at
whether the commit passed the check. So "every commit has a record" is not quite true today.

The outgoing message check (the tone gate) already records each of its decisions, and a change now
in review keeps the exact input it saw, so a decision can be replayed and graded by two judges from
different companies.

## What is new

1. Each commit record keeps the agent's short reasons for its risk level (checked for secrets, and
   the agent is told when writing them that they will be public), fingerprints of the review and
   plan it was decided on, and which parts of the written risk review are present. If a passing
   commit's record cannot be saved, the commit is refused instead of going ahead silently.
2. Each merged pull request is graded by its real calls: every passing record in it, except a
   retry of the very same commit, checked against the files that actually merged, and each judged
   only on its own part of the change.
3. The two-judge grader built for the tone gate gets a second mode that grades these calls with six
   questions: one per rule, plus whether the author was missing context the call needed. The judges first decide whether the risk level was right from what the
   change actually touched, before they are shown the agent's reasons, so good writing cannot
   rescue a wrong call. They are never shown what happened to the change later.
4. Afterwards, the grader checks whether the calls the judges doubted were more often the ones that
   later got reverted or blamed for a bug. That is reported as a pattern with its counts, not as a
   score.
5. Every grading run reports how many merged pull requests are missing a usable record, so the gap
   in the existing check is measured instead of assumed.

A finding counts only when both judges agree; if one judge is missing, there is no finding at all.

## What it does not do

It never changes any decision. The only new refusal is a passing commit whose record cannot be saved. It covers six
of the nine judgment-bound rules. The other three (spotting that two features are really one,
deciding an insight is worth keeping, and noticing what one is responsible for) happen inside the
agent's ordinary thinking, and a decision not to do something leaves nothing to record. Those three
are going to the owner as part of a group decision about the deadline, not built here. It also does
not write into the agent's decision journal: that journal drops old lines as it grows, lives on one
machine, and feeds a check that watches the agent's own decisions, which automatic lines would
confuse.

## What you need to decide

Nothing yet. The standard names the decision journal as the lasting place for these records; the
evidence says the commit record in the repository is the lasting place. That wording change will be
proposed with the registry edit that closes the deadline, which needs Justin's approval on GitHub,
and only after the first real grading run.
