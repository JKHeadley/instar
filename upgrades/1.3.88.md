# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Mentor onboarding now hot-reads the mentor settings from the agent config file
each time the runner checks its configuration. Updating the mentor curriculum or
mentor runtime settings no longer requires a full server restart. If the config
file is missing, unreadable, malformed, or has a malformed mentor block, the
runner falls back to the startup snapshot instead of throwing into a mentor tick.

## What to Tell Your User

- **Mentor settings update without a restart**: "When you adjust the mentor curriculum or related mentor settings, the running server picks them up on the next mentor check. If the config edit is malformed, the mentor keeps using its last safe startup settings instead of failing a tick."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Mentor config hot-read | Edit mentor settings in the agent config file; the next mentor status check or tick reads the updated mentor block |
| Defensive mentor config fallback | Malformed config edits keep the mentor on its startup settings until the file is repaired |

## Evidence

Unit coverage proves changed on-disk mentor agendas are read on the next call
and malformed config falls back to the startup snapshot. Integration coverage
pins the mentor route to fresh runner config reads. Server-backed e2e coverage
proves a running AgentServer reflects mentor config edits without restart and
falls back safely when the config file is malformed.
