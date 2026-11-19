# What is going on

Instar's nuke command removes an agent. For a standalone agent, it removes the agent's whole folder. With `--here`, it removes Instar from the project you are in. Today, that project cleanup can replace edited instruction files with an older Git version or delete files that Git does not track. That can erase your own work. The standalone command also automatically saves all changes into a Git commit before pushing a backup.

# What changes

There are exactly two changes. First, `--here` leaves these project paths unchanged: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.gitignore`, `.claude`, `.codex`, `.mcp.json`, and `instar.config.json`. It keeps them whether or not you use Git. Links stay links, and their targets are not opened or changed. Only the checked `.instar` folder is deleted from the project's artifacts. Before you confirm and in the result, Instar lists what it kept and warns that these files may still contain Instar instructions or hooks.

Second, standalone nuke stops automatically staging files or creating a commit. It pushes only commits that already exist, using the same destination as today. If there are uncommitted changes, it says so before confirmation. It also says plainly that uncommitted changes are NOT in the backup. Deleting the standalone agent folder still deletes that work.

# Safeguards

The existing checks for stopping sessions and deleting folders stay in place. These changes give nuke no extra power to stop or delete anything. A Git error cannot make `--here` overwrite or delete a kept project file. A backup error is reported, but does not add a new reason to block deletion. Keeping files does not clean their contents: you may need to review remaining instructions or hooks yourself.

The implementation will need unit, integration, and full command tests. All use temporary homes and repositories. They must not touch real agents or system services. Any tmux used for a test must have its own private socket. No tests were run to write this draft.

# What needs deciding

The Chief of Staff has already chosen this narrow scope. No new product decision is needed. Review should check that the two changes preserve project files, explain the backup limit clearly, and leave existing teardown safeguards intact. Larger hardening and automatic rebuilding of project files remain outside this work.
