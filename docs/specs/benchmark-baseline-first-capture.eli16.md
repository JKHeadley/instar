# ELI16 — Why the model-quality comparison had never once produced a result

## The setup

There are two ways to ask "is this AI model good at this job?"

One is a **test battery**: a fixed set of tricky cases with known right answers. Run
a model against them, count how many it gets right. That's a *prediction* — "this
model should handle roughly 93% of cases like these."

The other is **watching real life**: track what the model actually decides in
production and how those decisions turn out.

Instar has a piece that compares the two. If the battery says a model should score
93% and reality says 60%, something is wrong — maybe the prompt drifted, maybe the
test cases aren't representative, maybe the model changed under you. That comparison
is the point of the whole exercise.

It had never produced a single result.

## Three reasons, each invisible on its own

**First: there was no battery result on file to compare against.** The design said
"populating this is an operational step" and marked ownership of that step as a
known loose end. Nobody ever did it. The comparison therefore reported "can't check
— no baseline" every time, forever, which from the outside looks a lot like "nothing
to report."

**Second, and worse: the model that actually does the job wasn't in the lookup
table.** Production model names and battery model names have to be matched exactly —
deliberately exactly, because fuzzy matching on model names is how you accidentally
compare against the wrong thing. The message gate runs on a small GPT model. That
name simply wasn't in the table. So even with a baseline, the one scenario with real
traffic would have resolved to "no known match" indefinitely, silently.

The pattern is worth naming: a check that can't run reports the same thing as a check
that ran and found nothing wrong. Both look like quiet.

**Third: the results we did have were measured against different instructions.** A
battery result only means something if it tested the instructions the system actually
runs. The message gate's instructions have grown by about 4,400 characters since the
last battery — new rules that didn't exist when the scoring happened. So capturing a
baseline from those old numbers would have produced something that looks
authoritative and means nothing.

Credit where it's due: the system was built to catch exactly that. It records a
fingerprint of the instructions it tested and refuses to draw conclusions if they've
since changed. That guard working is genuinely reassuring — it would have refused to
grade models against a prompt they never saw.

## What was done

The battery was **re-run against today's actual instructions** rather than
back-filling old numbers. The bench's copy of the instructions was regenerated from
the live source first, so it's testing what's really running.

Then the results were saved as the baseline, and the missing model name was added to
the lookup table.

An unexpected finding fell out of it. Against the *old* instructions, the small GPT
model running your message gate scored 6 out of 14. Against today's, it scores 14 out
of 14. The concern going in was that the benchmark had gone stale and quality had
drifted downward; the actual story is that the instructions got substantially better
and the benchmark simply hadn't noticed.

## What this doesn't fix

The comparison needs both halves: a prediction *and* a real-world result. This
supplies a current prediction. The real-world half doesn't exist yet — every decision
the message gate makes is currently recorded as "outcome unknown," because the piece
that scores outcomes was never built.

So the honest status is: one half of a two-half problem, and the drift check stays
quiet until the other half lands. Saying that plainly matters more than presenting a
captured baseline as a closed loop.

## One thing that cost money

The run was meant to use only models covered by existing subscriptions. The tool
matches model names as fragments rather than exact strings, so one entry also caught
a pay-per-use copy of the same model behind a metered account. It billed 87 cents
against a key with a $25 daily limit. That result was excluded from the baseline,
which contains subscription-door results only — and the mistake is written down here
rather than quietly absorbed.
