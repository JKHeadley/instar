# Your agent can now set up Tailscale and Jev for you, on any agent

## What this is

Recommended services are outside services your agent can set up for you after you say yes: Tailscale, Jev, Bitwarden, a GitHub backup and five more. Until now, every one of them was marked "not available yet" on every real agent. Only test agents, and Echo, could take a yes, because a service is only allowed to be set up once its recipe has been proven to work for real.

Two recipes have now been proven. Jev's was proven on 2026-11-05: a fresh test agent on real Telegram opened the TypeSafe account, got the key, stored it, and its check passed. Tailscale's was proven on 2026-11-07: a test agent sent the one-tap sign-in link, the tap signed the machine in, and the check passed without help. So this change marks those two as available on every agent.

## What changes for a person

On the dashboard's Services list, Tailscale and Jev now show "Yes or no" instead of "Not available yet". Tapping it opens the same confirm page as before: what you get, what leaves your machine, the cost, the account, what you keep if you say no, and your PIN. A yes starts a setup session in its own conversation that does the whole job and only comes back to you for a decision or a credential. The other seven services stay "not available yet" until each has its own live proof.

Two things had to exist before a real person could be offered this, and they are part of this change:

**A no can switch a working service off.** Before, a no only stopped the agent offering or setting up; a service already working stayed on with no way to turn it off except asking. Now, on a machine where the service is working, the confirm page has a box, "Also switch it off on this machine", unticked by default. Tick it with your no and the agent undoes what its own setup did, and only that: for Jev it removes the key its setup stored, so nothing on that machine uses Jev any more (your TypeSafe account and credits stay yours); for Tailscale it signs the machine out only if its own setup signed it in. A Tailscale you already had, or a key you had stored yourself, is left exactly as it was, the page doesn't offer the box for it, and the agent says it's yours to switch off, or will do it if you ask. If the service might be the only way the agent can reach you, the switch-off waits until another way works, and you're told. A no with switch-off made on one machine is obeyed on the agent's other machines too, and a machine where the agent never set the service up touches nothing.

**A yes is refused where the agent can't talk to you.** Setup talks to you, so a machine that can't message you right now (it isn't the one answering your messages) won't take a yes. The page says so in plain words and the no still works. The yes is not lost: the same page works again once that machine can reach you, and a setup that was waiting to restart simply waits.

## What does not change

The agent still offers nothing on its own. The proactive offer, where a new agent sends its owner the list and asks, is not built yet; this change only lets a person who finds the Services list say yes. The agent's instructions and the capability description now say exactly that.

## Safeguards

- Only the two proven recipes are available; a test pins the list, so adding a third needs a live proof and a deliberate change.
- Switching off needs the same PIN-checked page as a no, and is off by default. It never touches a service you set up yourself.
- The lease check can only refuse or delay a yes, never grant one.
- Existing agents get the new wording of their instructions on update; the page and routes update with the release.

## What you need to decide

Nothing. This ships what was promised for the two proven services. Each further service follows with its own live proof, and the proactive offer is the next piece of work.
