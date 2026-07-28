---
title: What is Instar?
description: Coherence infrastructure for your self-evolving agent. Memory that survives, identity that persists, and the same self-improving loop that built Instar itself.
---

**Coherence infrastructure for your self-evolving agent.**

Your AI agent shouldn't have amnesia. This one doesn't. Instar remembers what you discussed last week, catches its own contradictions before you do, follows through on commitments across restarts, and carries the same self-improving loop that built Instar itself — on the Claude Code or Codex subscription you already have.

Named after the developmental stages between molts in arthropods, where each instar is more developed than the last.

## The Problem

Every popular agent framework ships something hobbled. Users complain in the same words across the dev community:

- *"My agent forgot what I told it three sessions ago."*
- *"It contradicted its own past decisions."*
- *"It lost the thread halfway through the project."*
- *"It broke when the framework updated."*
- *"Default permissions are ALLOW-ALL — I had to figure out hardening myself."*

These aren't bad prompts or wrong models. They're the same architectural failure: an agent spun up with no machinery to be coherent — no memory across boundaries, no accountability for what a past instance did, no way to evolve itself. Power without coherence is unreliable, and most "memory" in popular frameworks is bolted-on (a vector DB, a buffer, a tutorial-shaped fix) rather than built into the architecture.

## The Solution

Instar is the scaffolding that un-hobbles agents. It solves six dimensions of agent coherence structurally:

| Dimension | What it means |
|-----------|---------------|
| **Memory** | Remembers across sessions -- not just within one |
| **Relationships** | Knows who it's talking to -- with continuity across platforms |
| **Identity** | Stays itself after restarts, compaction, and updates. Presents a rich, verifiable profile to other agents |
| **Temporal awareness** | Understands time, context, and what's been happening |
| **Consistency** | Follows through on commitments -- doesn't contradict itself |
| **Growth** | Evolves its capabilities and understanding over time |

## Two Configurations

- **General Agent** -- A personal AI partner on your computer. Runs in the background, handles scheduled tasks, messages you on Telegram or WhatsApp proactively, and grows through experience.
- **Project Agent** -- A partner embedded in your codebase. Monitors, builds, maintains, and messages you -- the same two-way communication, scoped to your project.

## How It Works

```
You (Telegram / WhatsApp / Terminal)
         |
    conversation
         |
         v
+-------------------------+
|    Your AI Partner       |
|    (Instar Server)       |
+--------+----------------+
         |  manages its own infrastructure
         |
         +- Claude Code session (job: health-check)
         +- Claude Code session (job: email-monitor)
         +- Claude Code session (interactive chat)
         +- Claude Code session (job: reflection)
```

Each session is a **real Claude Code process** with extended thinking, native tools, sub-agents, hooks, skills, and MCP servers. Not an API wrapper -- the full development environment. The agent manages all of this autonomously.

## Requirements

- Node.js 20+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
- API key or Claude subscription (Max or Pro)

## Next Steps

Ready to get started? [Install Instar](/installation) in one command.

Want to understand the philosophy? Read about [the coherence problem](/concepts/coherence).
