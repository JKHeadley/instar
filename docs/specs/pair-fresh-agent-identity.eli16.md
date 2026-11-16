# Adding a second machine to a new agent works the first time

Every Instar agent has an "agent identity": a key that says "this is the agent", which other agents and services use to recognise it. When you add a second machine, the first machine hands that key over during pairing, so both machines are the same agent. A machine that joins must never make up its own key, because then one agent would quietly turn into two that share a name.

During the two-machine test on November 16, pairing a brand-new test agent failed. That agent had been set up with the relay (the part that talks to other agents) switched off, and only the relay ever created the key. So the first machine had no key to hand over. The joining machine correctly refused to make one up, but then printed that the other machine was "likely on an older version", which was false: both were on the same release. Worse, after that failed attempt the first machine itself listed a second machine, so its own safety rule now refused to create a key. Every retry failed the same way.

What changes:

1. The first machine now creates the agent's key at the moment of its first pairing, while it is still the agent's only machine: after the pairing code is checked, and before the new machine is recorded. It uses the same guarded path as everywhere else, so a machine that already lists another machine still refuses to create one.
2. When no key can be handed over, the first machine says why, and the joining machine prints that reason in plain words. "Older version" now appears only when the other machine really gives no reason at all.
3. The joining machine takes the agent's name from the first machine when its own settings do not name it. A project folder with a different name no longer breaks the handover. If the settings do name a different agent, that is still refused, because it really is a mismatch.
4. One misleading warning is corrected. When the macOS keychain cannot be written (for example when joining over SSH), the warning said the master key was "only in memory, lost on restart". That never happens: the key is saved in a private file instead, and the warning now says so.

What does not change: the joining machine still never creates a key itself, the handover is still sealed to the joining machine and checked on arrival, and agents that already have a key are untouched. Undoing this is a plain revert.
