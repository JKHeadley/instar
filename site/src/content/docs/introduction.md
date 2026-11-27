---
title: What is Instar?
description: Your own AI agent, a colleague you can trust. Memory that lasts, promises it keeps, and judgment about when to ask you.
---

**Your own AI agent. A colleague you can trust.**

Instar turns an AI you chat with into an agent that works with you over time. It remembers what you discussed last week, keeps the promises it makes, works while you are away, and asks you only when a decision is really yours. You talk to it from the Instar app on your phone or computer, or from Telegram or Slack. It runs on the Claude Code or Codex subscription you already have.

Named after the developmental stages between molts in arthropods, where each instar is more developed than the last.

## The Problem

Most AI forgets you the moment the chat ends. Agents built on it fail in the same ways:

- *"My agent forgot what I told it three sessions ago."*
- *"It contradicted its own past decisions."*
- *"It lost the thread halfway through the project."*
- *"It broke when the framework updated."*
- *"It could do anything, and nobody had decided what it should be allowed to do."*

These are not bad prompts or wrong models. They are the same architectural failure: an agent with no structure for staying coherent. No memory across boundaries, no accountability for what an earlier session did, no way to learn from its corrections. Instar is what was left after most of a year of finding the ways an agent fails when nobody is watching, and making each fix part of the system so it does not depend on the agent remembering.

## The Solution

Instar builds six dimensions of coherence into the agent as structure, not as instructions it might forget:

| Dimension | What it means |
|-----------|---------------|
| **Memory** | Remembers across sessions -- not just within one |
| **Relationships** | Knows who it's talking to -- with continuity across platforms |
| **Identity** | Stays itself after restarts, compaction, and updates. Presents a rich, verifiable profile to other agents |
| **Temporal awareness** | Understands time, context, and what's been happening |
| **Consistency** | Follows through on commitments -- doesn't contradict itself |
| **Growth** | Evolves its capabilities and understanding over time |

## Two Configurations

- **General Agent** -- A personal AI colleague on your computer. Runs in the background, handles scheduled tasks, and reaches you through the app or your messaging channel when something needs you.
- **Project Agent** -- An agent for one codebase. Monitors, builds and maintains it, scoped to that project.

## How It Works

```
You (Instar app / Telegram / Slack / dashboard)
         |
    conversation
         |
         v
+-------------------------+
|     Your agent           |
|    (Instar server)       |
+--------+----------------+
         |  runs and supervises its own sessions
         |
         +- session (job: email check)
         +- session (your conversation about a project)
         +- session (job: reflection)
```

Each session is a real Claude Code or Codex process with its native tools, sub-agents, hooks and skills. Not an API wrapper. The server supervises all of it: memory, scheduling, recovery after crashes and restarts, and the checks that keep the agent honest. Link several computers and they act as one agent with one memory.

## Requirements

- **With the Mac app:** a Mac on macOS 14 or later, and a Claude or ChatGPT subscription.
- **From the terminal:** Node.js 20+, and [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or Codex signed in to your subscription.

## Next Steps

Ready to start? Follow the [Quick Start](/quickstart), with the Mac app or one command.

Want to understand the philosophy? Read about [the coherence problem](/concepts/coherence).
