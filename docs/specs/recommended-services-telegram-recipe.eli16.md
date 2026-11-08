# Your agent can set up Telegram for itself (test agents only, for now)

## What this is

Telegram is how most people talk to their agent from a phone: a bot the agent answers as, and a group with topics to keep conversations apart. Until now, getting that bot and group existed only inside the installer: if an agent was set up without Telegram, adding it later meant following steps yourself. Telegram is one of the recommended services, and this change gives it a setup recipe, so an agent without Telegram can set it up after your yes. Like the other recipes before their live proof, it runs only on test agents until it has been proven for real.

## What the setup session does

Everything happens in your own Telegram, signed in by you, in a browser the agent drives. You supply only your phone number and the login code Telegram sends you, through a one-time private link, never in chat. The agent then creates its bot with Telegram's BotFather, names it after itself, creates a group with topics for the two of you, makes the bot an administrator, and checks that the bot answers and the group is reachable. It writes the new channel into its own settings and asks its supervisor for a planned restart, so it starts listening there. If your Telegram account already has the most bots Telegram allows, it stops and tells you so in one sentence; it never deletes any of your bots.

## If you say no later

Telegram is switched off for this agent after its next restart. Your bot and group stay yours, and the setting stays in place, so a later yes needs no new bot. Because Telegram may be your only way of reaching the agent, the switch-off waits, and says so, until another way in works.

## Safeguards

- The bot token is never printed, logged, put in a command or sent in a message: the setup session reads it from BotFather's reply straight into one call to its own server, and the server, not the session, checks it with Telegram before writing it into the agent's settings.
- A Telegram you already had is never replaced: if a working bot is set up, the agent says so and changes nothing.
- The check says "unknown" when Telegram does not answer, so nothing claims to work on a guess.
- The recipe is dark: available only to a test agent that lists it, until the live proof.

## What you need to decide

Nothing yet. The live proof needs one decision, asked separately: whether a test bot and test group may be created on your Telegram account and deleted afterwards.
