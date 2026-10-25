# ELI16 — agents can still use their own API after a second machine is paired

## What was wrong

Every agent has a private access key for its own local server. Without it, almost every request the agent makes to itself is refused. Instar writes instructions into each agent's CLAUDE.md file, and those instructions said: "read the key out of `.instar/config.json`".

When you pair a second machine with `instar pair`, Instar moves secrets like that key out of the settings file into an encrypted secret store, and leaves a small placeholder (`{"secret": true}`) where the key used to be. Instar's own built-in scripts had already been updated to cope with that. But the instruction in CLAUDE.md had not. An agent that followed it after pairing got the placeholder instead of the key, and every request it made was turned away. Luna reported this on 3 October (tracked as ACT-1303), and I hit the same thing on this machine today.

## What changes

The instruction now looks for the key in this order:

1. The copy every agent session already has in its environment.
2. The encrypted secret store.
3. The settings file, but only if it holds a real key rather than the placeholder.

New agents get the corrected instruction straight away. Existing agents get it on their next update: the update finds the old line in their CLAUDE.md and swaps in the new one. It does this only once, and touches nothing else.

I checked both kinds of agent on this machine, with the session copy deliberately removed. On one whose key is in the secret store and on one whose key is still in the settings file, the new instruction produced a key the server accepted.

## What you need to decide

This is a bug fix with no decision for the operator.
