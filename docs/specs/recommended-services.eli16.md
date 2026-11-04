# Recommended services, in plain words

## What this is

An Instar agent works better with some outside services, like Tailscale or Bitwarden. Justin asked for two things. Each service needs a backup, so no agent depends on it. And each new user should be offered them: on yes the agent does the setup, and on no the agent respects that, using judgment about when an offer is worth making again.

## What already exists

Instar already records whether a person accepted or declined an optional feature, but it can't carry this rule. A no can come back on its own or be erased, any part of the agent can claim you said yes, choices stay on one machine, and real problems don't trigger anything. So these services get their own small record, using the same building blocks.

## What is new

- **A list of services.** Each entry says what the service is for and what the backup is, and whether anyone has actually tested that backup.
- **One short offer.** Each service is offered once, after the agent's first result has reached you. An unanswered offer isn't sent again, but stays in the dashboard and app.
- **Saying yes.** A confirm page on your phone says what leaves your machine, who gets it, and what it costs. Only you can approve it. From there, everything is the agent's job until it has proven the service works: researching it, creating the account, getting the key and setting it up. You only ever approve decisions or supply credentials. The agent can fully manage your own accounts, like an executive assistant, can use accounts of its own, or both, and that's your choice.
- **Saying no.** One tap, and it sticks. Anything already running stops, and you're told about any copies left behind.
- **Coming back after a no.** An offer can return for a real problem, such as your address going down three times in a day. It can also return for a change that matters to you, or after a long cool-off of at least 90 days if there's good reason to think your answer would differ. When you say no, you can tap a reason such as cost or privacy. The agent weighs that, and firm limits sit behind its judgment. The cool-off doubles after a second no, these re-offers stop after three, and there's at most one re-offer a day. The agent's judgment starts in practice mode, so at first only real problems bring an offer back. If unsure, it doesn't ask. Each offer says why it's asking now.

## Safeguards

- If every AI subscription is down, the offer and the setup still work, because they don't need AI.
- A GitHub backup must be private, or the agent won't send anything to it.
- Your choices follow you across machines.

## What it can't do

- Offering a service doesn't give it a backup. Local AI, an off-machine copy that needs no account, on-machine voice and email each need their own build. Justin's first request isn't finished until those ship.
- Apple alerts and npm have no replacement.

## What needs deciding

Nothing is open. Justin confirmed Jev and email go on the list, and told the agent to use judgment on re-offers. The 90-day and one-a-day limits are the agent's picks, and they're easy to change.

## Still to settle before offers go live

The groundwork can tell when a platform first accepted a reply, but that reply might only be a quick "got it", not useful work. A reply sent from another machine may not be seen by the machine that would send the offer. WhatsApp and the app can't prove delivery yet. These values also stay on one machine for now. Step 3 of the rollout settles all four before any offer relies on them, so until then nothing reads them.
