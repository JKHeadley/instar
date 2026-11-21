---
title: Quick Start
description: Get your first Instar agent running, with or without a terminal.
---

There are two ways to start. Pick the one that fits you.

## Without a terminal (Mac app)

1. [Download the Mac app](/#download) and move it to Applications.
2. Open it and tap **Create my agent**. The app sets up an agent on that Mac and makes the Mac its owner device.
3. Add your phone: install **Instar Agents** from the App Store and pair it with your agent. Then you can talk to your agent from anywhere.

## From the terminal

You need Node.js 20 or later and one of Claude Code, Codex or Gemini CLI signed in to your subscription. Then run:

```bash
npx instar
```

A guided setup takes it from there. It will:
1. Ask whether this is a general agent or an agent for the project in the current folder
2. Connect a way to talk to it, usually a Telegram bot it helps you create. If Telegram is not an option, the agent still works from its dashboard and the Instar app
3. Ask about your agent's identity and how you want to work together
4. Optionally start your agent automatically when you log in

## Talk to your agent

Send it a message from the app or from Telegram. It answers in its own voice.

Good first things to try:

- **"What can you do?"** It describes what it can do on this machine.
- **"Check my email every two hours."** It sets up a scheduled job.
- **"Remember that I prefer short answers."** It saves that, and still knows it next week.
- **"What needs me?"** It reads your Needs-you list: the few things only you can decide.

## What you will see

- **Conversations**: one per project or topic, each with its own memory.
- **Needs-you**: the one list of what is waiting on you, with where to act.
- **Work**: the Work Board shows what your agent is doing and what it is waiting on.

Scheduled jobs run in the background, and their reports stay quiet unless you ask to see them. See the [default jobs reference](/reference/default-jobs) for what runs out of the box.

## Next steps

- [The Coherence Problem](/concepts/coherence): why an agent you can trust needs structure
- [Job Scheduler](/features/scheduler): create your own jobs
- [Evolution System](/features/evolution): how your agent grows
