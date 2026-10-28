# Scheduled job model-call audit, in plain language

The job system already saves a record before asking Jev or its backup model
to judge a script result. This change makes those records easy to review in
bulk. For each call, the view says which model actually answered, what it
cost, what it decided, and whether independent later evidence showed that
decision was right. It also counts script runs that are missing an audit
record, so missing data cannot silently improve the score.

This is an audit view. It does not let Jev make live decisions yet. That still
needs an independent grader, larger benchmarks, and a guarded rollout.
