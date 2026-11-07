<!-- bump: patch -->

## What Changed

The agent can now answer "who can reach this agent, and what can they see?". `GET /team/people` lists each person, how they reach the agent and what they can see, and `?scope=pool` merges every machine and names any machine that did not answer. The console has a new "Who can reach me" page under People that reads it.

A new tracker records who sends messages whatever the memory privacy setting, because memory privacy's own count does nothing while it is off. When privacy is off and a second person can reach the agent, the owner gets one notice, held until someone new appears. Nothing is restricted and no message depends on this.

## What to Tell Your User

You can now see everyone who can reach your agent and what each person can see. Ask me "who has access?", or open "Who can reach me" under People on your dashboard. If someone else can reach your agent while memory privacy is off, I'll tell you once, because what one person tells me could reach the other. Nothing about how I work has changed, and you decide what to do about it.

## Summary of New Capabilities

`GET /team/people` and the dashboard People tab show who can reach the agent. A single notice warns the owner when a second person can reach an agent with memory privacy off.

## Evidence

The Thursday B2Lead report of 2026-11-05 listed "No warning to the owner when a second person reaches an agent with privacy off" with no owner. Justin asked on 2026-11-06 in topic 136110 for an agent fit for a whole team. This is the first piece of docs/specs/team-roles-and-access.md. Unit, integration and e2e tests cover it, including a sender counted with memory privacy off through the real inbound tracker.
