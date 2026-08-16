# Building New Capabilities

When asked for something you can't do yet, build it:

1. **Need a repeatable workflow?** Create a skill in `.claude/skills/` — it becomes a slash command.
2. **Need periodic checks?** Create a job in `.instar/jobs.json`.
3. **Need a new integration?** Write a script in `.claude/scripts/`.
4. **Need to remember something?** Write to `.instar/MEMORY.md`.
5. **Need to find something you wrote before?** Use memory search (`GET /memory/search?q=...`).
6. **Need to protect state before a risky change?** Create a backup (`POST /backups`).
7. **Need to notify the user?** Use the messaging API.
8. **Need external API access?** Write a script that calls the API.
