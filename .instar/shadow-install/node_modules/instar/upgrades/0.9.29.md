# Upgrade Guide — vNEXT

## What Changed

### Proactive GitHub CLI Setup During Installation

The setup launcher now actively ensures the GitHub CLI (`gh`) is available before the wizard starts, enabling agent restore from GitHub backups on new machines.

**What happens now:**
1. Launcher detects if `gh` is installed
2. If not, tries to install via `brew install gh` (macOS) or `apt install gh` (Linux)
3. Checks authentication status
4. Passes `ghStatus` (ready/installed/auth-needed/unavailable) to the wizard

**The wizard uses ghStatus to guide the user:**
- `ready` → scans GitHub for `instar-*` repos, offers restore
- `auth-needed` → walks user through `gh auth login --web`
- `unavailable` → asks "Have you used Instar before?" and helps install manually
- No state silently blocks the restore path

### Setup Wizard Decision Tree Improvements

The wizard now handles every `ghStatus` value with a clear next step instead of silently falling through to "set up new agent."

## What to Tell Your User

When setting up Instar on a new machine, the setup process now actively helps you connect to GitHub so it can find any existing agent backups. If the GitHub CLI isn't installed, we'll help you install it. If it's not signed in, we'll walk you through sign-in. No silent skips — every step has clear guidance.

## Summary of New Capabilities

- **Proactive gh install**: Setup launcher tries to install GitHub CLI automatically
- **ghStatus context**: Wizard receives explicit status instead of silent failure
- **auth-needed flow**: Wizard walks through GitHub sign-in when gh is installed but not authed
- **unavailable flow**: Wizard asks about prior usage and helps install gh manually
