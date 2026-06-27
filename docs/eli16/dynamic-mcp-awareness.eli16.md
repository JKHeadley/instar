# Dynamic MCP — agent awareness + migration (ELI16 overview)

## Why this exists

There's a rule in this project: a feature an agent doesn't KNOW about might as well
not exist, because agents act on what's written in their own instruction file
(CLAUDE.md), not on what's buried in the code. So whenever we add a capability, we
must also teach the agent it exists — in two places: the template that NEW agents
are born with, and a one-time patch that adds the same note to agents that ALREADY
exist (they only get changes through updates).

## What this adds

A short, honest "Dynamic MCP Lifecycle" section describing the load-heavy-tools-on-
demand capability: how to read what tools a session has, how to request a load or a
drop, and — importantly — the rule that the agent can't approve its own change; it
needs a real preapproval (an autonomous run) or the operator's genuine yes.

It is tagged clearly as experimental and OFF by default, because that's the truth:
the feature ships dark, and pretending a dark feature is finished would be
dishonest. The section names the two pieces still to come (the idle-offload
background sweep and the approve-from-a-normal-chat route) rather than implying
they're done.

## Two delivery paths, kept in sync

The exact same text is produced by one shared function, used by both the new-agent
template and the existing-agent migration — so the two can't drift apart. The
migration only ADDS the section if it isn't already there, so running an update
twice does nothing the second time (idempotent).

## Why it's safe

It's documentation: prose in an instruction file. It changes no behavior, gates
nothing, and the migration is a careful add-if-missing. Three tests confirm: the
section lands on an existing agent with the honest dark tag + the key surface + the
authorization rule, a second run leaves the file byte-identical, and the new-agent
template carries the same section (so new and existing agents stay in parity).
