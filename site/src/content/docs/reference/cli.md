---
title: CLI Commands
description: Complete reference for all Instar CLI commands.
---

Most users never need these -- your agent manages its own infrastructure. These commands are available for power users and for the agent itself to operate.

## Setup

```bash
instar                          # Interactive setup wizard
instar setup                    # Same as above
instar init [project-name]      # Create a new agent (general or project)
```

## Server

```bash
instar server start [name]      # Start the persistent server (background, tmux)
instar server stop [name]       # Stop the server
instar server restart [name]    # Restart the server
instar server status [name]     # Show server status
instar status                   # Show agent infrastructure status
```

## Lifeline

```bash
instar lifeline start           # Start lifeline (supervises server, queues messages)
instar lifeline stop            # Stop lifeline and server
instar lifeline status          # Check lifeline health
instar lifeline list            # List lifeline instances
instar lifeline instances       # List instances (hidden alias)
```

## Auto-Start

```bash
instar autostart install        # Agent starts when you log in
instar autostart uninstall      # Remove auto-start
instar autostart status         # Check if auto-start is installed
```

## Add Capabilities

```bash
instar add telegram --token BOT_TOKEN --chat-id CHAT_ID
instar add whatsapp
instar add email --credentials-file ./credentials.json [--token-file ./token.json]
instar add quota [--state-file ./quota.json]
instar add sentry --dsn https://key@o0.ingest.sentry.io/0
```

## Users

```bash
instar user add --id alice --name "Alice" [--telegram 123] [--email a@b.com]
instar user list
```

## Jobs

```bash
instar job add --slug check-email --name "Email Check" --schedule "0 */2 * * *" \
  [--description "..."] [--priority high] [--model sonnet]
instar job list
```

## Backup and Restore

```bash
instar backup create            # Snapshot identity, jobs, relationships
instar backup list              # List available snapshots
instar backup restore [id]      # Restore a snapshot
```

## Memory

```bash
instar memory search <query>    # Full-text search across agent knowledge
instar memory reindex            # Rebuild the search index
instar memory status             # Index stats
instar memory export             # Export memory data
```

## Knowledge Base

```bash
instar knowledge ingest <content>  # Ingest content into knowledge base
instar knowledge list              # List knowledge sources
instar knowledge search <query>    # Search knowledge
instar knowledge remove <sourceId> # Remove a knowledge source
```

## Semantic Memory

```bash
instar semantic search <query>  # Semantic search across memory
instar semantic remember        # Store a semantic memory
instar semantic forget <id>     # Remove a semantic memory
instar semantic stats           # Memory statistics
instar semantic export          # Export semantic memories
instar semantic decay           # Run memory decay process
```

## Intent Alignment

```bash
instar intent reflect           # Review recent decisions against stated intent
instar intent org-init [name]   # Scaffold ORG-INTENT.md
instar intent validate          # Check AGENT.md against ORG-INTENT.md
instar intent drift             # Detect behavioral drift over time
```

## Reflection

```bash
instar reflect job <slug>       # Reflect on a specific job
instar reflect all              # Reflect on all recent activity
instar reflect analyze [slug]   # Analyze reflection patterns
instar reflect consolidate      # Consolidate learnings
instar reflect run [slug]       # Run a reflection cycle
```

## Git Backup

```bash
instar git init                 # Initialize git backup
instar git status               # Show git state
instar git push                 # Push to remote
instar git pull                 # Pull from remote
instar git log                  # Show git history
instar git remote <url>         # Set remote URL
instar git commit [message]     # Create a commit
```

## Multi-Machine

```bash
instar machines                 # List all paired machines and their roles
instar machines remove <name-or-id>  # Revoke a machine from the mesh
instar whoami                   # Show this machine's identity and role
instar pair                     # Generate a pairing code for a new machine
instar join <url>               # Join an existing agent mesh (--code <code>, --name <name>)
instar wakeup                   # Move the agent to this machine (transfer awake role)
instar leave                    # Remove this machine from the mesh
```

Note: `whoami`, `pair`, `join`, `wakeup`, and `leave` are top-level commands, not subcommands of `machines`.

## Channels

```bash
instar channels login <adapter> # Authenticate a messaging adapter
instar channels doctor [adapter] # Diagnose adapter issues
instar channels status          # Show adapter status
```

## Relationships

```bash
instar relationship list        # List tracked relationships
instar relationship import      # Import relationship data
instar relationship export      # Export relationship data
```

## Playbook (Context Engineering)

```bash
instar playbook init            # Initialize playbook system
instar playbook doctor          # Diagnose playbook health
instar playbook status          # Show playbook status
instar playbook list            # List playbook items
instar playbook read <itemId>   # Read a playbook item
instar playbook add             # Add a playbook item
instar playbook search <query>  # Search playbook
instar playbook assemble        # Assemble context from playbook
instar playbook evaluate [log]  # Evaluate playbook against session
instar playbook lifecycle       # Run lifecycle management
instar playbook validate        # Validate playbook structure
instar playbook mount <path>    # Mount external data source
instar playbook unmount <name>  # Unmount a data source
instar playbook export          # Export playbook data
instar playbook import <file>   # Import playbook data
instar playbook eject [script]  # Eject a script for customization
instar playbook user-export <userId>  # Export user-specific data
instar playbook user-delete <userId>  # Delete user data (DSAR)
instar playbook user-audit <userId>   # Audit user data footprint
```

## Diagnostics

```bash
instar doctor                   # Run health diagnostics
instar review                   # Review system state
instar nuke <name>              # Remove an agent completely
instar migrate                  # Run pending migrations
instar upgrade-ack              # Acknowledge an upgrade
```

## Feedback

```bash
instar feedback --type bug --title "Session timeout" --description "Details..."
```
