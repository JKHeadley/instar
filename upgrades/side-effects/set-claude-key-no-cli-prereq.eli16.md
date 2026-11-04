# ELI16 — set-claude-key works without the Claude CLI installed

`instar set-claude-key` saves a new Claude sign-in key into the agent's config file. To find that file it called `loadConfig`, which also checks that the Claude CLI program is installed and throws if it is not. Saving a key never needs the program itself, only the folder the config lives in. On GitHub's CI machines Claude is not installed, so the command crashed and the `claude-key-alive` end-to-end test failed on main.

The command now works out the folder directly, the same way `loadConfig` does (`<project>/.instar`), and skips the install check. Nothing else changes: it still refuses a key of the wrong shape and still never prints the key.

Why it matters: the whole point of this command is to recover an agent whose sign-in key died. Making that recovery depend on an unrelated install check means it can fail at exactly the moment someone needs it, and it kept every instar PR red while the check sat on main.
