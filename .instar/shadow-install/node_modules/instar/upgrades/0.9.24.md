# Upgrade Guide — vNEXT

## What Changed

### Cloud Backup in Setup Wizard

The `npx instar` setup wizard now includes a **Cloud Backup** phase (Phase 4.5). After identity and Telegram setup, the wizard walks users through backing up their agent data to a private GitHub repository.

**What happens during setup:**
1. Initializes a local git repository in the agent directory
2. Installs `git` and `gh` CLI if missing (via Homebrew or apt)
3. Walks through GitHub authentication (browser OAuth)
4. Creates a private `instar-<agent-name>` repository automatically

Default is YES — users expect their data to be protected against machine loss.

### Non-Interactive Cloud Backup Fix

When `instar init --standalone` runs in a non-TTY context (e.g., spawned by the setup wizard or another process), the interactive backup prompt previously failed silently and skipped the entire backup setup. Now:

- **Interactive terminal**: Prompts as before (default: YES)
- **Non-interactive**: Automatically sets up local git backup, defers GitHub remote to the agent's first session

### Agent Removal Command

New `instar nuke <name>` command for complete standalone agent removal:
- Stops the running server (tmux session)
- Removes auto-start configuration (launchd/systemd)
- Pushes final backup to git remote (preserves cloud copy)
- Removes from agent registry
- Deletes the agent directory

Requires explicit confirmation. The agent's CLAUDE.md template now includes awareness of this command, but it's deliberately not agent-executable — the user must run it directly as an intentional safety layer.

## What to Tell Your User

Your agent now offers cloud backup during setup. When you run `npx instar`, after setting up identity and Telegram, the wizard will walk you through connecting to GitHub so your agent's data is backed up to the cloud. If your machine ever crashes, your agent's memories, identity, and configuration are safe.

You can also now completely remove an agent with `instar nuke <name>`. This cleanly stops the server, pushes a final backup, and removes all traces. Your GitHub backup remains intact for recovery.

## Summary of New Capabilities

- **Cloud backup in setup wizard**: Private GitHub repo created during `npx instar` setup
- **Non-interactive backup**: `instar init --standalone` auto-sets up git backup even in subprocess contexts
- **`instar nuke`**: Complete agent removal with safety guards and final backup push
- **Agent removal awareness**: Agents know about `instar nuke` via CLAUDE.md template
