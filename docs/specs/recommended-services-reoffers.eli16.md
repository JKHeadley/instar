# Asking again after a no, only when a real problem shows up

## What this change is

Instar agents can offer to set up outside services for the person they work for: a password manager, a private backup, voice transcription and so on. When the person says no, the agent must not keep nagging. But sometimes a no was given before the person saw why the service matters. The plan for these services says an agent may ask once more, and only for a good reason.

This change builds the first and simplest of those reasons: a real problem that the service would fix. The first problem wired in is a voice note the agent can't read because nothing on its machine can turn speech into text. If the person said no to voice transcription earlier, the agent now sends one short message: what happened, that this is what the service fixes, the same facts as the first offer (what it costs, what leaves the machine, whose account), and a link to say yes. If it's still no, the person does nothing, and the no stands.

## The rules, all in code

- Only a no, or an offer the person never answered, can be asked about again. The problem must have happened after that no.
- At most one of these messages a day, across all services. A problem that has to wait still gets its turn.
- The same problem can't ask about the same service again for 90 days, then 180, then 360, then 360 from then on.
- A problem older than 30 days never triggers a message, so turning the switch on doesn't dig up old ones.
- A burst of unreadable voice notes counts as one problem a day.
- Only the machine that can reach the person sends. Any machine can notice the problem.
- The message never contains error text, and asking again never changes the saved no. Only the person's yes on the confirm page does.

## What is new

A new kind of row in the saved record of choices, for "a problem was seen", "about to ask" and "asked" (the last only once the chat platform confirms the message arrived). A small set of rules decides when to ask. The voice transcription code tells the agent each time a voice note can't be read: Telegram, WhatsApp, Slack and the phone app all go through it.

## Safeguards

Everything ships switched off: `recommendedServices.reoffers.enabled`, off by default. With it off, nothing is recorded and nothing is sent. No AI model decides anything here; the later parts of the plan that do use one (asking again after a price drop, or after a long time) are still to come and will run in a watch-only mode first.

## What you need to decide

Nothing. It follows the approved plan (rollout step 4) and stays off until it's turned on.
