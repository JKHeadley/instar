---
title: Quick Start
description: Your first five minutes with Instar.
---

## Setup

Run the setup wizard:

```bash
npx instar
```

Follow the prompts. The wizard will ask you to:
1. Choose a configuration (General Agent or Project Agent)
2. Set up Telegram (create a bot, provide the token)
3. Describe your agent's identity and your working relationship
4. Optionally install auto-start on login

## Talk to Your Agent

Once setup completes, send a message in Telegram. Your agent will respond in its own voice.

Try these first interactions:

- **"What can you do?"** -- The agent will describe its capabilities
- **"Check my emails every 2 hours"** -- Watch it create a job and schedule
- **"Remember that I prefer TypeScript over JavaScript"** -- It'll save this to MEMORY.md
- **"What time is it?"** -- Temporal awareness in action

## Watch It Work

Your Telegram group becomes a living dashboard:

- Each **scheduled job** gets its own topic
- The **Lifeline topic** (green icon) shows health status
- **Interactive topics** are your conversations with the agent
- `/new` creates a fresh topic with its own session

## See the Infrastructure

```bash
instar status               # What's running
curl localhost:4040/health   # Server health (JSON)
curl localhost:4040/jobs     # Scheduled jobs
```

The web dashboard (if tunnel is configured) shows sessions, jobs, relationships, and evolution in real time.

## Add Capabilities

```bash
# Add email integration
instar add email --credentials-file ./credentials.json

# Add Sentry error tracking
instar add sentry --dsn https://key@o0.ingest.sentry.io/0

# Add quota tracking
instar add quota
```

## What Happens Next

With default settings, your agent ships with fourteen built-in jobs that give it a circadian rhythm of self-maintenance. A sample of what runs:

- **Every 5 minutes**: Health check (Haiku) + commitment detection (Haiku)
- **Every 4 hours**: Reflection on recent work (Opus) + evolution overdue check (Haiku)
- **Every 6 hours**: Evolution proposal evaluate (Sonnet) and implement
- **Every 8 hours**: Insight harvest from learnings (Sonnet)
- **Daily**: Review stale relationships (Sonnet) + identity review
- **On a schedule**: Five `overseer-*` jobs (development, guardian, infrastructure, learning, maintenance) that watch over different facets of the agent's life

See the [default jobs reference](/reference/default-jobs) for the complete list with cron schedules and supervision tiers.

## Next Steps

- [The Coherence Problem](/concepts/coherence) -- Why coherence matters
- [Job Scheduler](/features/scheduler) -- Create your own jobs
- [Evolution System](/features/evolution) -- How your agent grows
