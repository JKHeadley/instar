# Move the primary session before its account runs out

Instar can use several subscription accounts. It already watches account usage
and can restart a running conversation on another account before the current
one reaches its limit. The restart preserves the conversation, and the
anti-thrash brakes avoid bouncing sessions back and forth or interrupting work
that is still in progress.

The live safety path has one important blind spot: it only considers sessions
that were explicitly tagged with a pool account when they started. The normal
interactive session often has no tag because it uses the machine's default
login. The older path knows how to resolve that default login, but the live
anti-thrash path deliberately skips it. That means the conversation a person
is actively using can sit on an account at 88% while another account is almost
empty, then hit the wall that proactive swapping was supposed to prevent.

There is a second source of noise. The monitor currently sees background and
headless sessions that cannot be restarted through a Telegram or Slack
conversation. It tries anyway, the refresh layer correctly refuses, and the
monitor records a generic execution failure. Those impossible attempts repeat
and hide the failures that would actually matter.

This change extends the existing proactive-swap pipeline. A default-account
session becomes eligible when it has a real Telegram or Slack binding, so the
same proven refresh path can safely resume it. Sessions without such a binding
are filtered out before an execution is attempted. Nothing creates a second
credential store or a special one-off swap mechanism.

Moving that conversation does not change the machine's default login. The
respawned conversation is pinned to the chosen account, while other untagged
sessions and future default starts remain where they were. The ledger records
that the moved session originally came from the default slot without falsely
claiming that the default itself changed. The source is checked again right
before restart, so an operator changing the default at the same moment makes
the planned move safely go stale instead of acting on yesterday's truth.

All current safeguards stay in place. The destination must be local, use the
same framework, have a recent real usage reading, be comfortably below the
source, and pass the existing ceiling and material-improvement checks. A busy
conversation still waits for its turn and helper work to finish. Cooldowns,
per-tick limits, failure backoff, and the anti-thrash breaker still apply.

Among the accounts that survive those safeguards, the destination is now the
freshest one: the account with the lowest current binding-window utilization.
The older “use it before it resets” score is used only to break an exact tie.
This directly matches the practical goal: if one eligible account is at 7% and
another is at 40%, move the near-limit session to the 7% account.

The proof covers both sides of the boundary. One test shows a bound untagged
session near its limit moving to the freshest eligible same-framework account,
including a setup where the previous scoring would have selected a different
account. Another shows that it stays put when no meaningfully fresher eligible
account exists. A production-wiring test also proves that an unbound background
session is excluded instead of generating recurring execution failures. The
production tests cover Telegram and Slack bindings, including their disk
fallbacks and a Slack-only server, so the proof matches the incident path rather
than succeeding only through a generic mock.

Rollback is simple: revert the code and publish the next patch. There is no
data migration, no new configuration, and no new persistent state.
