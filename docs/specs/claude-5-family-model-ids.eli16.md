# Teaching instar the Claude 5 model names — Plain-English Overview

> The one-line version: instar refused to pin a conversation to Fable 5.1 because its list
> of known Claude models had aged out a generation — and the same staleness was quietly
> discarding the default model this install had already been configured to use.

## The problem in one breath

An operator asked for the observer conversation to run on Fable 5.1. instar answered
`'claude-fable-5-1' is not a known claude-code model id` — while the very same machine could
run that model from the command line on demand. Worse, this install's configured default
Claude model was already `claude-opus-5`, which was off the same list, so it was being
silently thrown away at the point where instar decides which model a conversation gets. In
both cases the capability was present and the list standing in front of it was old. From
outside, a stale list and a deliberate refusal look identical.

## What already exists

- **A closed list of model names per tool.** instar keeps an explicit list of which model
  names each CLI will accept, and refuses anything else. That is deliberate, not
  bureaucracy: a mistyped model name would otherwise start a session that dies at launch,
  and nobody would know why.
- **Two things that consult it.** The part that validates "pin this conversation to model
  X", and the part that validates "start a session on model X". Both read the one list, so
  they cannot disagree.
- **A fallback for stale pins.** If a pinned model stops being recognized, the conversation
  quietly runs on the default and says so once, rather than breaking.
- **A separate registry of which models are *best*.** That is a different list, reviewed on
  a schedule, that decides which model routing should reach for. It is not the same question
  as "is this a real model name", and this change keeps them separate.

## What this adds

Four names join the Claude list: `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`, and
the short alias `fable`. Each was run against the installed CLI and observed answering
before it was added — none was added because it looked plausible.

The `fable` alias is worth calling out because its absence was pure asymmetry: `opus`,
`sonnet` and `haiku` were all accepted as shorthand, and `fable` was not, for no reason
anyone chose.

## The new pieces

There are none, and that is the point. No new check was written, no new component gained a
say in anything, and the logic that decides whether to accept a model name was not touched.
Four entries were added to a list of names, one note in the model registry was updated to
record what happened, and six tests were added to hold it all in place.

## The safeguards

**Unknown names still fail closed, exactly as before.** The change only ever *grows* the
accepted set. A made-up sibling like `claude-fable-6` is still refused, and there is now a
test asserting that refusal — so the list cannot quietly slide from "verified" to "seemed
likely."

**Recognized is not the same as preferred.** Adding a name means a conversation *may* be
pinned to it. It does not change which model anything picks on its own. The escalation
policy still reaches for `claude-fable-5`; promoting Fable 5.1 above it would be a
fleet-wide routing decision and deliberately is not bundled in here.

**The billing assumption was re-checked rather than inherited.** The code carries a written
premise that every name on this list bills through the subscription, not per token. Adding
names obligated re-verifying that premise instead of assuming it, and there is now a test
that will have to be changed deliberately if one of these models ever moves to per-token
billing.

**The known substring trap was checked.** `claude-fable-5-1` contains `claude-fable-5`
inside it. Three existing tests assert that certain internal routing tables do *not* contain
`claude-fable-5`, and a careless edit would have tripped them. They were checked and pass —
the new name does not reach those tables.

## What ships when

One PR, one change, no rollout ladder and no dark flag — adding known-good values to a
validation list has nothing to gate. During the window where one machine has updated and
another has not, a conversation pinned to a Claude 5 model and moved to the older machine
falls back to the default and says so once, then heals when that machine updates. That is
the pre-existing degrade path, not a new failure.

## The honest limit

This list is maintained by hand and mirrors something Anthropic changes on its own schedule.
It is correct today and will age again, and nothing in this change detects that. That is
recorded as a tracked action (ACT-514) rather than left as an intention, because the failure
mode is not loud: a stale list refuses a real model with a message that reads exactly like a
policy decision. The scheduled registry review had in fact already noticed the Claude 5
family back in August and recorded it in the *preferred-models* registry — but nothing
carried that over to the *accepted-names* list, which is precisely the gap that produced
this bug.

## What you actually need to decide

Are you satisfied that these four names were verified against the real CLI before being
added — and that leaving the escalation policy pointed at Fable 5 (rather than promoting
Fable 5.1 in the same change) is the right call?
