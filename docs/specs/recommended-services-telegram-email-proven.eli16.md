# Telegram and email setup: switched on after their live tests

## What this change is

Instar agents can offer to set up outside services for the person they work for. Each service has a "recipe", the steps the agent follows to set it up on its own. A recipe stays hidden on normal agents until it has been tried for real, end to end, on a throwaway test agent. That rule exists so we never promise something that does not actually work.

Two recipes, Telegram and email, passed that real test on November 9, 2026. The Telegram test started on an agent with no Telegram at all: the person said yes, and the agent made its own bot and group, stored the key, restarted, and then answered in Telegram. The email test had the agent store a mailbox key, send a proof email whose code was entered back, and then deliver two scheduled reports by email. Both tests ran on the exact code that was later merged.

Only the last step was never done: marking the two recipes as proven in the service list. This change does that, so every agent now shows Telegram and email as available.

## What already exists

The recipes, the confirm page, the key routes, the checks and the switch-off paths for both services are already merged and released. Six other services (Tailscale, Jev, Bitwarden, GitHub backup, a second AI subscription, voice transcription) were switched on the same way earlier.

## What is new

Two lines in the service list now name the proven recipe instead of "none". The tests that said these two services must stay hidden now say they are available.

## Safeguards

Nothing is offered without a person's yes on the confirm page. The agent still sends the proactive list of services only when that separate switch is on, and it is still off by default. Email still only ever goes to the owner's own confirmed address. Undoing this is a one-line revert per service.

## What you need to decide

Nothing. This follows the existing rule: a recipe becomes available once its live proof passes.
