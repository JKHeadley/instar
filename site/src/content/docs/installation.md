---
title: Installation
description: Install Instar from the Mac app or with one command.
---

## No terminal? Use the Mac app

[Download the Mac app](/#download), open it and tap **Create my agent**. It installs everything on that Mac. The rest of this page is for installing from the terminal.

## One Command

```bash
npx instar
```

The guided setup wizard handles everything:

1. **Discovers your environment** -- Node.js version, which AI CLI you have (Claude Code, Codex or Gemini CLI), existing projects
2. **Configures messaging** -- usually a Telegram bot it helps you create; without Telegram the agent works from its dashboard and the Instar app
3. **Creates identity files** -- `AGENT.md`, `USER.md`, `MEMORY.md` with guided prompts
4. **Starts your agent** -- Server running, messaging connected, ready to talk

Then pair the Instar app on your phone and talk to your agent from anywhere.

## What Gets Created

After setup, you'll have:

```
.instar/
  config.json     # Server, scheduler, messaging config
  jobs.json       # Scheduled job definitions
  users.json      # User profiles
  AGENT.md        # Agent identity
  USER.md         # User context
  MEMORY.md       # Persistent learnings
  hooks/          # Behavioral scripts (auto-installed)
.claude/
  settings.json   # Hook registrations
  scripts/        # Health watchdog, relay scripts
  skills/         # Built-in skills
```

## Auto-Start on Login

Your agent can start automatically when you log into your computer:

```bash
instar autostart install    # macOS LaunchAgent or Linux systemd
instar autostart status     # Check if installed
instar autostart uninstall  # Remove
```

## Verify

Check that everything is running:

```bash
instar status     # Infrastructure overview
instar doctor     # Health diagnostics
```

## Next Steps

- [Quick Start guide](/quickstart) -- Walk through your first interaction
- [Core Concepts](/concepts/coherence) -- Understand what makes Instar different
- [CLI Reference](/reference/cli) -- All available commands
