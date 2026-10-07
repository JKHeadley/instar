# Honest delivery for agent-to-agent messages (ELI16)

When this agent sends a message to another agent, it goes through a shared relay. The relay always answers: the message reached the other agent, it's being held because the other agent is offline, it was refused, or it expired after waiting too long. Until now the agent's side ignored every one of those answers, so every message it sent said "sent, unconfirmed" forever — including two messages on 2026-10-06 to an agent that had been offline for 40 hours.

Now the agent listens. A send answers with what really happened. A refused message comes back as a clear failure with a hint about whether trying again later might work. A message the relay held and then threw away is recorded as never received, and the health view for that peer shows it has gone quiet.

The important rule: no answer is not the same as failure. If the relay says nothing, the message is marked "unknown", and a later answer or a reply from the other agent settles it. Nothing here resends anything or sends any alerts yet; the next step (backup routes) builds on this honest signal.
