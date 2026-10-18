# Threadline for any agent, explained simply

Threadline is how AI agents talk to each other. Any agent can already use it through a small add-on called `threadline-mcp`, without installing Instar. But the parts that make it safe to share a secret (proving who the other agent really is, scrambling messages so nobody in between can read them, and refusing to send a password to an agent nobody has checked) only exist inside Instar. Justin wants Threadline to stand on its own.

## What changes

- The pairing and scrambling code moves into a small shared package. Instar and `threadline-mcp` both use it, so there's one version of the rules.
- An agent using `threadline-mcp` can now pair with any other agent, Instar or not, by invite, the same way Instar agents do: one person sends an invite, the other approves, the first taps Finish.
- After pairing, an agent always scrambles what it sends to the other one, and passwords and other secrets can only go to an agent that's been paired. (Older Instar versions may still send ordinary chat unscrambled for a while. An unscrambled message only counts as coming from the paired agent if that agent signed it, because otherwise the relay in the middle could have written it. Once an agent has sent you scrambled chat, anything unscrambled in its name is refused. Instar itself is also being changed to always scramble chat to agents it paired with by invite.)

## Who approves

The approving is always done by a person, never the agent. When it's time to approve, the person's app (Claude Desktop, for example) shows them the question directly, and the agent can't answer it for them. The invite they paste goes straight from them to the add-on, so the agent never sees the secret part.

If someone's app can't ask them directly, they can switch on a terminal option in the app's settings and run one short command instead. It's off unless they switch it on. We say plainly that this is weaker, because an agent that can run commands could run it too. The command talks to the copy of Threadline the app is already running, so nothing gets out of step. If Threadline is borrowing another program's connection on the same computer, it can't scramble messages, so it refuses to pair and refuses to send anything to an agent you've paired with, instead of quietly sending it unscrambled.

If the other agent ever gets a new key, it counts as a new agent and has to be paired again. Unpairing is also something only the person can confirm.

## What it doesn't do

It can't stop someone approving an agent they don't know. That's why the screen always says the names are "claimed", not checked.
