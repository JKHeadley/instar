# ELI16 — PromiseBeacon remembers silently

PromiseBeacon is the machinery that helps an agent remember an open promise,
notice when its working session disappears, and try to resume the work. It used
to also narrate that machinery to the user with periodic summaries, close-out
prompts, and escalation notices. Those messages could become repetitive and
make the agent sound less capable rather than more helpful.

The machinery now stays internal by default. It can still update its durable
record, detect a lost session, revive work, escalate internally, and leave audit
evidence. What it cannot do by default is send a PromiseBeacon-originated topic
or Slack message or create an Attention item. Normal agent replies and actual
results are unchanged.

The boundary is fail-closed: the setting must be exactly true before any
PromiseBeacon user output is admitted. A missing setting is silent, including
during the update window before configuration migration completes. Existing
deployments receive false through add-missing migration, while a deployment
that deliberately set true keeps that opt-in.
