# Removing Instar no longer touches your project files or uploads uncommitted work

<!-- bump: patch -->

## What Changed

`instar nuke --here` now keeps CLAUDE.md, AGENTS.md, GEMINI.md, .gitignore, .claude, .codex, .mcp.json and instar.config.json exactly as they are and removes only the `.instar` folder. It no longer restores those files from Git, which could overwrite edits. It lists what it kept, before confirming and at the end. `instar nuke <name>` no longer commits everything before its backup push: it pushes only existing commits, warns first that uncommitted changes are not in the backup, and reports whether the push worked.

## What to Tell Your User

- **Removing Instar from a project**: "If you remove me from a project folder, I now leave your files like CLAUDE.md and .claude exactly as they are and only remove my own .instar folder. I'll show you which files I kept, and I can look through them with you if you want to clean out Instar notes."
- **Deleting an agent**: "Before deleting an agent, I now back up only what's already committed and tell you plainly that anything uncommitted won't be in the backup, so nothing private gets uploaded by surprise."
