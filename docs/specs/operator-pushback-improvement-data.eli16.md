# ELI16 — Operator pushback as honest improvement data

When you tell an agent “that’s wrong,” “stop asking me that,” or “do the work
yourself,” the correction should not disappear when the conversation ends. It
should help the system notice recurring problems, check whether it is improving,
and eventually create better tests.

The difficult part is honesty. Your objection proves that you objected. It does
not automatically prove that the agent was wrong. Maybe you stated a new style
preference. Maybe the agent misunderstood the task. Maybe a factual claim was
wrong. Maybe you simply chose a different tradeoff. If the system turns every
objection into a failing grade, it fabricates data and trains the agent to avoid
disagreement instead of becoming more correct.

This design keeps those facts separate.

First, it extends the correction system that already exists. It does not create
a second pushback database. Authenticated operator messages are classified into
a small fixed set such as preference, wrong scope, factual challenge, missing
evidence, unsafe authority, premature deferral, process problem, disagreement,
or unknown. Ambiguous messages stay unknown. Raw conversation is never copied
into measurement data.

Second, the correction becomes a durable observation: what kind of pushback
occurred, which agent decision it referred to when that link is known, how it
was recognized, and whether independent evidence ever appeared. Repetition can
make an issue more important, but repetition still does not make it true.

Third, a real right-or-wrong grade is allowed only when a different source
settles the question: a test result, a machine readback, an artifact, a policy
rule, a later real-world outcome, or an independent authorized review. The same
sentence or model that detected the pushback cannot also grade it. Without that
separate evidence, the grade remains unknown.

Finally, a benchmark case needs more than a hash or correction label. Someone
must create a privacy-safe, reproducible scenario with an independently checked
expected result and explicitly admit it to the benchmark battery. If that
cannot be done safely, the correction remains useful improvement evidence but
never pretends to be a runnable test.

This pull request changes documentation only. A later build would move in
separate stages: dark contracts, dry-run detection, opt-in local observations,
independent evidence joins, carefully gated quality grades, and only then
human-reviewed benchmark candidates. No stage automatically enables the next.
