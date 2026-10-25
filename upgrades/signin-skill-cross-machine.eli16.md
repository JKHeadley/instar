# The sign-in skill learns to sign in a machine that has no usable browser (plain-English version)

Every Instar agent has a written procedure, a "skill", for keeping its Claude and Codex subscriptions signed in. It assumed the machine that needed the login could open Chrome itself and let the agent drive it. That works on a Mac. It does not work on a Windows machine running Instar inside WSL, or on a headless server. Those machines have no browser the agent can steer.

On 2026-09-27 a Windows machine (the "Mama PC") had six Claude accounts signed out and five more never set up. Here is how the agent fixed all of it without anyone at either machine:
- The Windows machine started each login itself, so the finished login belongs to that machine. Nothing is copied from one machine to another.
- A Mac that already keeps a signed-in Chrome profile for each Google account opened the login link in the right profile and approved it.
- The Mac sent back only the one-time code.

The Mac's screen was locked the whole time. That did not matter, because the agent drives Chrome through Chrome's own scripting and never needs to see the screen.

It found three traps on the way, and the skill now names each one:
- Chrome was blocking Google's sign-in pop-up.
- OpenAI's workspace picker had silently selected a workspace that forbids this kind of sign-in.
- The Windows machine was missing accounts simply because it was offline when they were added elsewhere.

The check that it worked is a real request per account, not a "signed in" label: one account had said "active" for days while actually signed out.

Agents that already have the skill get the new section on their next update. Any notes they added themselves are kept. The safety lines stay the same: only the expected account, only the standard permissions, never around a CAPTCHA or phone check, and passwords only from the vault.

Nothing needs deciding.
