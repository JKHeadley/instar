# The spec-review link rule moves to where messages reach the owner — in plain words

## What is wrong today

When an agent hands its owner a design document (a spec) to review, the owner should get a link they can open on their phone. A check makes sure of that. The trouble is where the check sits. It runs inside the agent's own tools, just before a command runs, and all it can see is the text of the command. It cannot tell whether the message is going to the owner or to another part of the agent.

The agent's sessions pass spec reviews to each other all the time. The check blocks those too, even though no person reads them and no link is needed. To get around it, agents started hiding the message in a file, which means no check sees it at all. That is worse than the problem.

## What changes

The rule moves to the server, to the one place that already checks messages on their way to the owner: Telegram, Slack, the app, WhatsApp, iMessage and attention items all pass through it. Messages between the agent's own sessions never pass through there, so they are simply never checked by this rule. Nothing needs to guess who the reader is any more, because the route the message arrives on already tells you.

At that point the rule also becomes gentler. Instead of a hard block, it is a nudge from the existing message reviewer: "this hands over a spec with no link — add one, or tell me why not." The agent can fix the message, or send it anyway with a written reason, and that choice is recorded so the rule can be tuned.

Email the agent writes to its owner was the one message route that skipped the server's check. It gets the same check now.

All of this starts on the development agents only, behind one switch. Before it reaches every agent, it has to prove itself for at least two weeks: enough of its nudges must turn out right, and a hand-read sample of what it let through must show it isn't missing real handoffs.

The old block in the agent's tools is deleted.

## What is not covered yet

A few ways of sending skip the server entirely, such as calling Telegram directly with the bot's key. Those are being handled in a separate piece of work, due 8 December, for every rule, not just this one.

## How it is proved

Tests on both sides of the rule, a test that owner email is now checked, and a live run on a throwaway agent: a spec handoff with no link gets the nudge, the same message with a link goes through, and the same text sent between sessions goes through untouched. Nothing is sent to the real owner during the test.
