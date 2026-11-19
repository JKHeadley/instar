# Sessions a restart ended are now listed

<!-- bump: patch -->

## What Changed

Before the boot cleanup rewrites session records, each agent now writes a census of the sessions that were running at the previous shutdown, once per OS boot. It then classifies each one from its own record: whether it ended, whether its topic had open agent-driven work, and whether the topic is active again.

The result is served at `GET /sessions/boot-census` (`?since=<bootAt>` lists every boot since a given one), and it answers even where the resume queue or machine maintenance is off. The daily reader marks boots reviewed with `POST /sessions/boot-census/reviewed`. Census files are kept until reviewed; a backlog over 200 is reported, and nothing is dropped.

Fifteen minutes after a restart, if sessions with open work have not come back, one note per restart names their topics. Nothing is revived automatically yet; that is the next step.

## What to Tell Your User

- **After a restart, I know what stopped**: "When a machine restarts, I now keep a list of the conversations that were running and stopped with it. If any had work in progress and haven't picked back up after 15 minutes, I tell you once, with the conversations named."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| List of sessions a restart ended | `GET /sessions/boot-census` |
| Mark a boot's list as reviewed | `POST /sessions/boot-census/reviewed {bootAt}` |
