## What Changed

The dangerous-command guard matched only exact phrases, so a destructive git command with a flag in the middle, or with `git -C <path>`, got past it. It now also catches those forms for the hard reset, clean and force-push checks. A push with `--force-with-lease` to your own branch is still allowed.

## What to Tell Your User

Nothing changes for you. A safety check now catches more spellings of the same dangerous git commands.

## Summary of New Capabilities

No new capability. The guard covers flags and global options placed between `git`, the verb and the destructive flag, on new and existing agents.
