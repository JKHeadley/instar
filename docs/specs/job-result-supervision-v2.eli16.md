# Job result supervision — plain-English overview

Scheduled jobs run small scripts to check health, process feedback, and perform
other routine work. Those scripts save a great deal of AI time, but their
results still need supervision. Justin wants Jev to be the first AI checker
when a result might need a real agent to investigate.

The earlier design sent results from only five jobs to Jev. That could miss a
new or unusual result from another job. A later draft sent every result to
Jev, including thousands of identical “OK” lines. Reading the same bare OK
line cannot show Jev whether the script is secretly broken; a separate test
that makes the script face a simulated failure is more useful for that.

This design makes **every result count**. Each completed script run gets a
record saying how it was supervised. An exact, well-tested result whose
meaning is fully known can be handled by fixed rules. Anything new, changed,
failed, unclear, or outside that proven shape goes to Jev. There is no fixed
five-job list. Jev can ask for a full investigation session when it sees a
problem. A serious alert still goes out immediately, even if Jev is slow or
offline; Jev cannot cancel a session required by a serious problem or repeat
failure.

When Jev is unavailable, Haiku or Luna checks the results Jev would have
checked. Non-urgent results may be grouped briefly to save calls, but each
result still receives its own answer. If no model can check a result, the
record says “unchecked” and shows why. It is never quietly counted as safe.
An agent with only one AI provider continues to work.

If the AI check slows down or costs too much, the system can temporarily use
the old full-session route within a daily budget. When that budget runs out,
an already approved script may keep doing routine work while its results are
clearly marked unchecked. A script whose health test fails is paused and
reported instead. Agents outside the trial keep their existing job behavior.

Before this runs live, every new AI call needs a benchmark case and a reviewable
record: which question it answered, which provider and model actually ran,
its prompt version, time and cost, its decision, and what later evidence showed.
Unknown outcomes stay marked unknown. Job output sent to a model is limited
and scrubbed; sensitive user or mentor text stays inside the server. The
supervised test agent runs first. Then the development agent starts in a shadow
trial, followed by a guarded active trial. A full investigation session opens
only where its actual tool and file restrictions have been verified; otherwise
the result stays unresolved and the operator sees that clearly.
That session can diagnose from a restricted snapshot. Any live fix needs a
separate authorized step, and the incident stays open until a fresh health
check shows the fix worked.
We measure missed problems, unnecessary sessions, cost, and the number of
unchecked results over a week before considering a wider rollout. The current
gate keeps the new Jev path off until this proof is complete.

The decision to review is the middle path: every result is accounted for,
Jev reads the results where judgment can help, and a fixed rule may close only
an exact result shape that tests and real outcomes show to be safe. The old
five-job limit and six-hour outage sample do not carry forward.
