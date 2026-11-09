# Your agent can set up a second AI provider for itself

## What this is

An agent runs on one AI provider, usually Claude. If that provider is down or the subscription runs out of quota for the week, the agent's conversations stall. A second provider (today: ChatGPT's Codex) gives the agent somewhere else to work: you can ask it to move a conversation over ("use Codex here"), so the work doesn't stop. A running conversation does not move by itself; this change is careful not to promise that.

The second AI subscription is one of the recommended services. This change adds its setup recipe and marks it available on every agent, after a live proof on a test agent (2026-11-08).

## What the setup session does

It checks first: if a second provider already works for this agent, it says so and changes nothing. Otherwise it installs the provider's program if needed (no administrator rights), and sends you one sign-in link: your one tap signs this machine in with your own account. If you don't have that subscription yet, it tells you the price and waits for your yes before anything is bought. Then it checks that the provider is signed in on this machine, asks the agent's server to add it to this agent's list of providers (the dashboard shows it at once; the agent's own background checks use it after its next restart), and tells you plainly what you now have.

## Safeguards

- The sign-in is always your own tap. The agent never signs in with a login it already holds, and never signs the machine out.
- A provider's sign-in on a computer is shared by every agent that computer's user runs, so a no with switch-off only takes the provider back out of this one agent's list, and only if setup put it there. The sign-in and your subscription stay.
- If a second provider was already on before your yes, a switch-off leaves it as it was.
- Nothing is bought without your yes and the price.
- Switching a provider on changes only this agent's own settings, and takes effect at once.

## How it was proven

On a fresh test agent, as the person: asked for a backup AI subscription; the agent explained it and sent the yes page; after the yes it found Codex already signed in on the machine, passed its check, and the server added Codex to that agent's list within five minutes; a no with switch-off took it back out while the machine's own Codex sign-in stayed. The test also caught the agent promising automatic switching, and a switch-off that made a later yes wait a day; both are fixed. Because Codex was already signed in there, the sign-in tap itself was not exercised in this proof; it is the install's own sign-in step.

## What you need to decide

Nothing. It is available the same way as the other services: ask, or answer the agent's list, and say yes with your PIN.
