<!-- bump: patch -->

## What Changed

`instar add slack` now sets up an agent that people can talk to. It used to store the agent's own bot id as the only authorized Slack user (Slack's `auth.test` with a bot token returns the bot), so every person's message was silently ignored. It now suggests the workspace's only person, or its primary owner, and accepts typed member ids instead; the bot's id is refused, and an empty choice is explained. The generated Slack app manifest turns on the bot's Messages tab so people can DM the agent. `add slack` also installs the Slack reply relay (`.instar/scripts/slack-reply.sh`) right away; before, an agent that added Slack after `init` refused every Slack session (`slack-relay-not-ready`) until its next update. At start, the Slack adapter now reports a degradation when the bot is the only authorized user.

## What to Tell Your User

If you connected Slack and I never answered you there, that was a setup bug: I was listening only to myself. Ask me to set up Slack again, choose yourself as the person I answer, and I will reply there. New setups ask who I should answer and let you message me directly.

## Summary of New Capabilities

- `instar add slack` asks who the agent answers, with a sensible default.
- DMs to the agent work for apps made from the new manifest.
- The Slack reply relay is in place as soon as Slack is added.
- A start-time warning when the only authorized Slack user is the bot.

## Evidence

Unit tests cover the default choice (including the live single-person workspace), the bot never being chosen, id parsing, the manifest's Messages tab and the start-time signal on both sides. Live on a fresh Ubuntu server (agent nimbus, 2026-11-03): each of the three failures was reproduced, and after the fixes a Slack DM got the agent's reply in 18 seconds.
