## What Changed

- **Prerequisites installer now auto-installs Homebrew on macOS.** Previously, on a fresh Mac without Homebrew, the installer would bail out and tell the user to install Homebrew manually. Now it offers to install Homebrew non-interactively using the official install script, then proceeds to install tmux via `brew install tmux`.

## What to Tell Your User

Nothing — this is a seamless improvement to the setup experience. Users on fresh Macs will now be prompted to install Homebrew automatically instead of being told to do it themselves.

## Summary of New Capabilities

- `npx instar` on a fresh macOS machine now handles the full dependency chain: Homebrew -> tmux -> Claude CLI, all with interactive prompts and no manual steps required.
