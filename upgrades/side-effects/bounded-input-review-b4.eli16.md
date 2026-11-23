# Checks that act on what they can see, batch 4 (ELI16)

## The problem

Some decisions inside the agent are made by a model reading a piece of text that was cut short without any sign. The model then answers as if it had the whole thing. Our standards ask that every such cut be justified, announce itself, or, when the decision really depends on the missing part, not be made at all. There were 43 places to check before a lint starts failing builds on 23 November. This is the fourth and last batch. With it, the list is empty.

## What we found and changed

The important one: when another agent sends a message, a small check decides whether it needs an answer. That check can only ever say "don't reply". It was judging long messages from their first 2,000 characters, so if the other agent asked its question near the end, the check could decide no answer was needed and the question would go unanswered. Now a message that long is not judged at all. It gets a reply, which is the safe choice the check already makes whenever it cannot run.

Four other places now say clearly when they shortened a message:
- the check that sorts Slack requests by how sensitive they are;
- the check that decides whether to join a conversation the agent overheard;
- the check that spots a request to open a new shared space;
- the step that writes a short summary of an agent-to-agent conversation for the operator.

The Slack check can only make a request look more sensitive, never less, and the warning helps the model lean that way when it is unsure.

The remaining places were checked and do not feed a decision. They are titles, display text, a list of agents to process, the model's own output, or a cut that already said so and pointed to the full file. Each now carries a one-line reason.

## Safeguards

Nothing gained new power. The reply check can now only reply more, never less. Reverting the change undoes it completely.
