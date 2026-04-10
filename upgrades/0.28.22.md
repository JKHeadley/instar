## What Changed

- **GitHub CLI is now a real prerequisite.** Previously the setup wizard only emitted a soft warning when gh was missing, then continued without it — silently disabling cloud-backed agent discovery, GitHub backup sync, CI status checks, and PR/issue management. GitHub CLI is now part of the prerequisites check alongside Node.js, tmux, and Claude CLI, with auto-install support via Homebrew on macOS and apt on Linux. If Homebrew is missing on macOS, the wizard offers to install Homebrew first (same flow as the existing tmux path).

## What to Tell Your User

If you're on a fresh machine, the setup wizard will now offer to install GitHub CLI automatically. After install, I can help you sign in to GitHub so I can sync state across machines and discover any other agents you've set up. Without GitHub CLI, I still work locally but can't back things up to GitHub or find your other agents.

## Summary of New Capabilities

- GitHub CLI added as a fourth prerequisite with auto-install on macOS (Homebrew) and Linux (apt)
- Two-step install flow: if Homebrew is missing on macOS, wizard offers to install it before installing GitHub CLI
