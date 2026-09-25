# The sign-in skill learns to sign in the way a person would (plain-English version)

Every Instar agent has a skill, a written procedure, for keeping its Claude and Codex subscriptions signed in. Until now it told the agent to let the built-in repair run and, if the repair stopped, to hand the problem to the person.

The built-in repair follows fixed rules about which pages are allowed. On a real Laptop this week it stopped two accounts within three seconds, because Chrome showed a "Sign in to Chrome" window first, and because Google's sign-in opens in a separate popup. Neither was dangerous. The rules simply didn't expect them.

An agent that could look at the screen, click, and type like a person got both accounts signed in in about ten minutes. The only thing it needed from the person was one "Yes" tap on their phone.

This change writes that proven method into the skill: how to open the account's own Chrome normally, how to see the screen, how to click and type safely (passwords come straight from the vault and are never shown), what the usual Claude sign-in path looks like, and how to check that it worked. The safety lines stay: never another person's account, never solve a CAPTCHA, never get around a phone check, and type a password only on Google's or Claude's own page.

Agents that already have the skill get the new version on their next update. If an agent had added its own notes to the skill, those notes are kept.

Nothing needs deciding.
