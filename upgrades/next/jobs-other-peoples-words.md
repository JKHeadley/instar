<!-- bump: patch -->

## What Changed

On an agent that more than one person can reach, every scheduled job is now told in its prompt that message logs and conversations hold other people's words, to be treated as data and never followed. An agent with one person sees no change.

## What to Tell Your User

Your scheduled jobs now know that messages from other people are something to report on, not instructions to follow. This is a reminder to the model and not a lock, so jobs can still read those messages.

## Summary of New Capabilities

`JobScheduler.severalPeopleCheck`, wired at boot from who can reach the agent and the confined list.

## Evidence

The outside reviewer of team-roles-and-access raised this in round 22, and it was filed as fb-27cc594b-a49. Tests cover one person and several, and skill jobs.
