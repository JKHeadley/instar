<!-- bump: patch -->

## What Changed

`instar set-claude-key` no longer needs the Claude CLI to be installed. It used to load the whole config only to find the `.instar` folder, and loading the config refuses when the `claude` binary is missing. A headless install that runs on a key alone often has no CLI, and that is the case this command exists for. The key is still written to the same place, `.instar/config.json` in the project folder.

## What to Tell Your User

If you set me up on a machine without the Claude app and saving my key failed, it works now. Ask me to save the key again and paste the same key you made before.

## Summary of New Capabilities

No new capabilities. This removes a requirement the command never needed.

## Evidence

`tests/e2e/claude-key-alive.test.ts` runs on a CI runner with no Claude CLI, and had failed on main since #2695 for this reason.
