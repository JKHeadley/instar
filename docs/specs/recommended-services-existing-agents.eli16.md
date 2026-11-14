# Agents that already exist can get the services list too (off by default)

## What this is

Your agent can offer you the outside services it benefits from (a password manager, a private backup, a fixed address and so on) in one message, once, after it has delivered its first result. That offer was built for new agents: an agent created before the offer existed stays out of it, on purpose, so that nobody who has had an agent for months suddenly gets a message out of the blue without a decision behind it. The plan for recommended services calls the step that brings existing agents in "rollout step 5". This change is that step, as a switch.

## What changes

Nothing, until the switch is turned on. The switch is a setting on the agent (`recommendedServices.offers.existingAgents`), off by default. When it is on, the agent marks its owner as admitted at the next check and from then on the owner is treated exactly like a new agent's owner: after the agent has delivered one real result, the list is sent once, with a No button under each row and a Yes button only where a yes is just a sign-in tap. Rows the owner already decided, or services already in use on that machine, are left out as before.

## If the switch is turned off again

The owner stays admitted. The mark says "this person may be offered the list", it is permanent, and the list only ever goes out once anyway, so turning the switch off takes nothing back and asks nothing again.

## Safeguards

- The switch is off by default and read live; nothing is sent while it is off.
- Everything the offer already enforced still holds: one list per owner, only after a delivered result, only from a machine that can reach the person, never a row that is decided or in use, and never a second list.
- The admission is a one-line mark in the agent's own state, not a message: the message still has to pass the offer's own rules.
- Multi-machine agents need their choices to replicate before any list goes out, as before.

## What you need to decide

Nothing for new agents. For an agent you already have, whether you want its list at all: turning the switch on is that decision, and it is made once per agent.
