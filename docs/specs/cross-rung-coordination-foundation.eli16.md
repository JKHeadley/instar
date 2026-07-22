# Cross-rung coordination foundation — ELI16

PR #1532 supplied shared words and rules, not a switchable feature. The rollout
registry still names it so none of the nine PRs disappears, but marks it excluded.
That means it has no rung, metric, flag, or separate graduation decision.

This distinction matters because rollout bookkeeping can accidentally turn every
pull request into something that looks operational. A document cannot run, fail,
produce live evidence, or move from a test agent to the fleet. Giving it a pretend
switch or a permanently green metric would make the dashboard look complete while
weakening trust in every real feature shown beside it.

The excluded row is therefore positive accounting, not omission. It records source
PR #1532, points to the documentation foundation, and explains why its rung is empty
and its metric count is zero. The row stays visible alongside the five active features
and three composed components, so an audit can prove that all nine source pull
requests were considered exactly once.

Nothing about exclusion means the documentation is unimportant. Its vocabulary is
used by the runtime entries, and those entries carry their own real owners, evidence,
and criteria. It simply means the document is provenance rather than a runtime
control. If later work ships executable behavior based on it, that behavior must get
its own source specification and honest rollout classification; this row must never
be silently upgraded into a feature after the fact.
