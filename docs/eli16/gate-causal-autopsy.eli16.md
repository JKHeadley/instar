# Causal autopsy in the dev gate — ELI16

We recently allowed small, low-risk fixes to ship through a fast lane: no
design document, no second reviewer, just the author, some required artifacts,
and green tests. That trade is fine — IF we compensate for the missing
reviewer somewhere else. Justin named the compensation precisely: every time
something breaks, we should write down what actually caused it. Was it a
previous change? A shift in the environment that quietly invalidated an old
assumption? Brand-new code? A bug that was always there? Or do we honestly not
know? Without that record, we can't tell whether our fixes are making the
system converge toward stability or whether we're playing whack-a-mole —
or worse, each "fix" is quietly adding new chaos.

Today that analysis is possible only by archaeology: digging through PR
descriptions, chat logs, and one agent's session memory. The single day we
tried it by hand produced a real insight — five of six bugs fixed that day
were NOT new mistakes; they were old assumptions (retry budgets, cleanup
timers) invalidated by one systemic shift, our release pace jumping to a
restart every fifteen minutes. That's exactly the kind of pattern worth
knowing, and exactly the kind that evaporates if nobody records causes.

So the record now has a structural home. The dev gate already writes one
small audit file per commit attempt (what tier was declared, what the risk
classifier suggested, whether the gate passed or blocked). The fix-author can
now add one field to their trace: the cause of the issue they're fixing — one
of five honest categories, plus the linked PR numbers when the cause was a
prior change. The gate validates it (a garbage cause is rejected loudly,
because a corrupt record is worse than none) and copies it into the audit
file. Meta-analysis stops being archaeology and becomes a one-line query over
those files.

Two deliberate softnesses in this first slice. Declaring a cause is optional:
if a commit looks like a fix (the branch name or release note says so) and
has no cause declared, the gate prints a loud nudge but never blocks — we
want the field to earn trust before it gains teeth. And "unknown" is a fully
legitimate answer: an honest "we don't know yet" is better data than a
guessed cause, and far better than silence.
