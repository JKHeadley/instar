<p align="center">
  <img src="assets/logo.png" alt="Instar" width="180" />
</p>

<h1 align="center">instar</h1>

<p align="center">
  <strong>Persistent autonomy infrastructure for AI agents.</strong> Every molt, more autonomous.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/instar"><img src="https://img.shields.io/npm/v/instar?style=for-the-badge" alt="npm version"></a>
  <a href="https://github.com/SageMindAI/instar"><img src="https://img.shields.io/badge/GitHub-SageMindAI%2Finstar-blue?style=for-the-badge&logo=github" alt="GitHub"></a>
  <a href="https://github.com/SageMindAI/instar/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="License"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/instar">npm</a> · <a href="https://github.com/SageMindAI/instar">GitHub</a> · <a href="https://instar.sh">instar.sh</a> · <a href="#origin">Origin Story</a>
</p>

---

> **This is power-user infrastructure.** Instar gives Claude Code full autonomous access to your machine -- no permission prompts, no sandbox. It's built for developers who want a genuine AI partner, not a guarded assistant. If that sounds like too much trust, it probably isn't for you. If it sounds like exactly what you've been waiting for, read on.

Instar gives Claude Code agents a **persistent body** -- a server that runs 24/7, a scheduler that executes jobs on cron, messaging integrations, relationship tracking, and the self-awareness to grow their own capabilities.

Named after the developmental stages between molts in arthropods, where each instar is more developed than the last.

## The Problem

**Without Instar**, Claude Code is a CLI tool. You open a terminal, type a prompt, get a response, close the terminal. No persistence. No scheduling. No way to reach you. Every session starts from zero.

**With Instar**, Claude Code becomes your partner. It runs in the background, checks your email on a schedule, monitors your services, messages you on Telegram when something needs attention, remembers who it's talked to, and builds new capabilities when you ask for something it can't do yet. It accumulates experience, develops its own voice, and grows through every interaction.

The difference isn't features. It's a shift in what Claude Code *is* -- from a tool you use to an agent that works alongside you. This is the cutting edge of what's possible with AI agents today -- not a demo, not a toy, but genuine autonomous partnership between a human and an AI.

## Getting Started

One command gets you from zero to talking with your AI partner:

```bash
npx instar
```

A guided setup handles the rest — identity, Telegram connection, server. Within minutes, you're talking to your partner from your phone, anywhere. That's the intended experience: **you talk, your partner handles everything else.**

### Two configurations

- **General Agent** — A personal AI partner on your computer. Runs in the background, handles scheduled tasks, messages you on Telegram proactively, and grows through experience.
- **Project Agent** — A partner embedded in your codebase. Monitors, builds, maintains, and messages you on Telegram — the same two-way communication as a general agent, scoped to your project.

Once running, the infrastructure is invisible. Your partner manages its own jobs, health checks, evolution, and self-maintenance. You just talk to it.

**Requirements:** Node.js 20+ · [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) · tmux · [API key](https://console.anthropic.com/) or Claude subscription

## CLI Reference (Power Users)

> Most users never need these — your agent manages its own infrastructure. These commands are available for power users and for the agent itself to operate.

```bash
# Setup
instar                          # Interactive setup wizard
instar setup                    # Same as above
instar init my-agent            # Create a new agent (general or project)

# Server
instar server start             # Start the persistent server (background, tmux)
instar server stop              # Stop the server
instar status                   # Show agent infrastructure status

# Lifeline (persistent Telegram connection with auto-recovery)
instar lifeline start           # Start lifeline (supervises server, queues messages during downtime)
instar lifeline stop            # Stop lifeline and server
instar lifeline status          # Check lifeline health

# Auto-start on login (macOS LaunchAgent / Linux systemd)
instar autostart install          # Agent starts when you log in
instar autostart uninstall        # Remove auto-start
instar autostart status           # Check if auto-start is installed

# Add capabilities
instar add telegram --token BOT_TOKEN --chat-id CHAT_ID
instar add email --credentials-file ./credentials.json [--token-file ./token.json]
instar add quota [--state-file ./quota.json]
instar add sentry --dsn https://key@o0.ingest.sentry.io/0

# Users and jobs
instar user add --id alice --name "Alice" [--telegram 123] [--email a@b.com]
instar job add --slug check-email --name "Email Check" --schedule "0 */2 * * *" \
  [--description "..."] [--priority high] [--model sonnet]

# Backup and restore
instar backup create               # Snapshot identity, jobs, relationships
instar backup list                  # List available snapshots
instar backup restore TIMESTAMP    # Restore a snapshot

# Memory search
instar memory search "deployment"  # Full-text search across agent knowledge
instar memory reindex              # Rebuild the search index
instar memory status               # Index stats

# Intent alignment
instar intent reflect              # Review recent decisions against stated intent
instar intent org-init             # Scaffold ORG-INTENT.md for organizational constraints
instar intent validate             # Check AGENT.md against ORG-INTENT.md
instar intent drift                # Detect behavioral drift over time

# Multi-machine
instar machines whoami             # Show this machine's identity
instar machines pair               # Generate a pairing code
instar machines join CODE          # Join using a pairing code

# Diagnostics
instar doctor                      # Run health diagnostics

# Feedback
instar feedback --type bug --title "Session timeout" --description "Details..."
```

## Highlights

- **[Persistent Server](#persistent-server)** -- Express server in tmux. Runs 24/7, survives disconnects, auto-recovers.
- **[Lifeline](#lifeline)** -- Persistent Telegram supervisor that auto-recovers from crashes and queues messages during downtime.
- **[Auto-Start on Login](#auto-start-on-login)** -- macOS LaunchAgent / Linux systemd service. Agent starts when your computer boots.
- **[AutoUpdater](#autoupdater)** -- Built-in update engine. Checks npm, applies updates, notifies via Telegram, self-restarts. No Claude session needed.
- **[AutoDispatcher](#autodispatcher)** -- Receives intelligence dispatches from Dawn. Lessons, strategies, and configuration applied automatically.
- **[Job Scheduler](#job-scheduler)** -- Cron-based task execution with priority levels, model tiering, and quota awareness.
- **[Identity System](#identity-that-survives-context-death)** -- AGENT.md + USER.md + MEMORY.md with hooks that enforce continuity across compaction.
- **[Telegram Integration](#telegram-integration)** -- Two-way messaging. Each job gets its own topic. Your group becomes a living dashboard.
- **[Relationship Tracking](#relationships-as-fundamental-infrastructure)** -- Cross-platform identity resolution, significance scoring, context injection.
- **[Evolution System](#evolution-system)** -- Four subsystems for structured growth: proposal queue, learning registry, gap tracking, and commitment follow-through.
- **[Self-Evolution](#self-evolution)** -- The agent modifies its own jobs, hooks, skills, and infrastructure. It builds what it needs.
- **[Self-Healing](#self-healing)** -- LLM-powered stall detection, automatic session recovery, promise tracking, and loud degradation reporting. No silent failures.
- **[Conversational Memory](#conversational-memory)** -- Per-topic SQLite memory with full-text search and rolling summaries. The agent remembers every conversation.
- **[External Operation Safety](#external-operation-safety)** -- LLM-supervised safety gate for external service calls. Adaptive trust that evolves with track record.
- **[Intent Alignment](#intent-alignment)** -- Decision journaling, drift detection, and organizational intent constraints. The agent stays on track.
- **[Multi-Machine](#multi-machine)** -- Run your agent across multiple computers with encrypted sync, automatic failover, and cryptographic machine identity.
- **[Coherence System](#coherence-system)** -- Project-aware spatial reasoning and pre-action verification. The agent knows where it is and checks before acting.
- **[Capability Discovery](#capability-discovery)** -- Agents know all their capabilities from the moment they start. Context-triggered feature suggestions.
- **[Innovation Detection](#innovation-detection)** -- Agents detect when user-built features could benefit all Instar agents and submit improvement feedback.
- **[Behavioral Hooks](#behavioral-hooks)** -- Structural guardrails: identity injection, dangerous command guards, grounding before messaging.
- **[Default Coherence Jobs](#default-coherence-jobs)** -- Health checks, reflection, relationship maintenance. A circadian rhythm out of the box.
- **[Feedback Loop](#the-feedback-loop-a-rising-tide-lifts-all-ships)** -- Your agent reports issues, we fix them, every agent gets the update. A rising tide lifts all ships.
- **[Agent Skills](#agent-skills)** -- 10 open-source skills for the [Agent Skills standard](https://agentskills.io). Use standalone or as an on-ramp to full Instar.

## Agent Skills

Instar ships 10 skills that follow the [Agent Skills open standard](https://agentskills.io) -- portable across Claude Code, Codex, Cursor, VS Code, and 35+ other platforms.

**Standalone skills** work with zero dependencies. Copy a SKILL.md into your project and go:

| Skill | What it does |
|-------|-------------|
| [agent-identity](skills/agent-identity/) | Set up persistent identity files so your agent knows who it is across sessions |
| [agent-memory](skills/agent-memory/) | Teach cross-session memory patterns using MEMORY.md |
| [command-guard](skills/command-guard/) | PreToolUse hook that blocks `rm -rf`, force push, database drops before they execute |
| [credential-leak-detector](skills/credential-leak-detector/) | PostToolUse hook that scans output for 14 credential patterns -- blocks, redacts, or warns |
| [smart-web-fetch](skills/smart-web-fetch/) | Fetch web content with automatic markdown conversion and intelligent extraction |

**Instar-powered skills** unlock capabilities that need persistent infrastructure:

| Skill | What it does |
|-------|-------------|
| [instar-scheduler](skills/instar-scheduler/) | Schedule recurring tasks on cron -- your agent works while you sleep |
| [instar-session](skills/instar-session/) | Spawn parallel background sessions for deep work |
| [instar-telegram](skills/instar-telegram/) | Two-way Telegram messaging -- your agent reaches out to you |
| [instar-identity](skills/instar-identity/) | Identity that survives context compaction -- grounding hooks, not just files |
| [instar-feedback](skills/instar-feedback/) | Report issues directly to the Instar maintainers from inside your agent |

Each standalone skill includes a "Going Further" section showing how Instar transforms the capability from manual to autonomous. Each Instar-powered skill gracefully detects missing Instar and offers one-command setup.

Browse all skills: [agent-skills.md/authors/sagemindai](https://agent-skills.md/authors/sagemindai)

## How It Works

```
You (Telegram / Terminal)
         │
    conversation
         │
         ▼
┌─────────────────────────┐
│    Your AI Partner       │
│    (Instar Server)       │
└────────┬────────────────┘
         │  manages its own infrastructure
         │
         ├─ Claude Code session (job: health-check)
         ├─ Claude Code session (job: email-monitor)
         ├─ Claude Code session (interactive chat)
         └─ Claude Code session (job: reflection)
```

Each session is a **real Claude Code process** with extended thinking, native tools, sub-agents, hooks, skills, and MCP servers. Not an API wrapper -- the full development environment. The agent manages all of this autonomously.

## Why Instar (vs OpenClaw)

If you're coming from OpenClaw, NanoClaw, or similar projects affected by Anthropic's OAuth policy change -- Instar is architecturally different.

### ToS-compliant by design

Anthropic's policy: OAuth tokens are for Claude Code and claude.ai only. Projects that extracted tokens to power their own runtimes violated this.

**Instar spawns the actual Claude Code CLI.** Every session is a real Claude Code process. We never extract, proxy, or spoof OAuth tokens. We also support [API keys](https://console.anthropic.com/) for production use.

### Different category, different strengths

| | OpenClaw | Instar |
|---|---|---|
| **What it is** | AI assistant framework | Autonomy infrastructure |
| **Runtime** | Pi SDK (embedded agent runtime) | Claude Code (full dev environment) |
| **Sessions** | Multi-session gateway | Multiple parallel Claude Code instances |
| **Identity** | SOUL.md (co-created, agent-editable) | Multi-file + behavioral hooks + compaction recovery |
| **Memory** | Hybrid BM25 + vector search with temporal decay | Relationship-centric + per-topic conversational memory |
| **Messaging** | 20+ channels | Telegram (Slack/Discord planned) |
| **Voice** | ElevenLabs TTS, talk mode, voice wake | -- |
| **Device apps** | macOS, Android, iOS (internal preview) | -- |
| **Sandbox** | Docker 3×3 matrix + security audit CLI | External operation safety gate + dangerous command guards |
| **Model providers** | 28+ (Anthropic, OpenAI, Gemini, local models, etc.) | Claude (via Claude Code) |
| **Self-evolution** | SOUL.md + workspace file updates | Full infrastructure self-modification + evolution system |
| **Self-healing** | Loop detection | LLM-powered stall triage, session monitoring, promise tracking |
| **Intent alignment** | -- | Decision journal, drift detection, organizational constraints |
| **Multi-machine** | -- | Encrypted sync, automatic failover, cryptographic identity |
| **ToS status** | API keys + OAuth (OAuth path restricted by Anthropic) | Spawns real Claude Code (compliant) |

**OpenClaw optimizes for reach** -- AI across every messaging platform and device. **Instar optimizes for depth** -- an agent that is coherent, self-healing, aligned, and evolving.

### Where OpenClaw leads

20+ messaging channels with deep per-channel config. Docker sandboxing with [security audit CLI](https://docs.openclaw.ai/gateway/security). Voice/TTS via ElevenLabs with voice wake across devices. Multi-agent routing with deterministic priority hierarchy. 28+ model providers with auth rotation and failover. ClawHub marketplace with thousands of community-built skills. Companion apps on macOS, Android, and iOS (internal preview). These are real, mature features backed by a large community.

### Where Instar leads

**Runtime depth.** Each session is a full Claude Code instance -- extended thinking, native tools, sub-agents, MCP servers. Not an API wrapper. Every feature Anthropic adds to Claude Code, Instar agents get automatically.

**Self-healing agent.** LLM-powered stall detection and recovery, session health monitoring, promise tracking, and loud degradation reporting. The agent doesn't just run -- it monitors itself and recovers from failures on its own.

**Conversational continuity.** Per-topic SQLite memory with full-text search and rolling summaries. After compaction or session restart, the agent picks up exactly where it left off with full conversation context.

**External operation safety.** An LLM-supervised gate that evaluates every external service call before execution. Adaptive trust that evolves per service. Emergency stop capability. Born from a real incident -- not theoretical.

**Intent alignment.** Decision journaling, drift detection, organizational constraints. No other agent framework tracks whether the agent is staying aligned with its purpose over time.

**Identity infrastructure.** Hooks re-inject identity on session start, after compaction, and before messaging. The agent doesn't try to remember who it is -- the infrastructure guarantees it. Structure over willpower.

**Multi-machine.** Run across multiple computers with Ed25519 cryptographic identity, encrypted sync, and automatic failover. Your agent works wherever you are.

Different tools for different needs. Different bets on different futures.

> Full comparison: [positioning-vs-openclaw.md](docs/positioning-vs-openclaw.md)

---

## What Powers Your Agent

Your agent runs inside real Claude Code sessions. That means it inherits — automatically, invisibly — every capability Anthropic has built into Claude Code. Instar amplifies each one. The user just talks to their agent and gets results.

| What happens invisibly | Claude Code provides | Instar amplifies |
|------------------------|---------------------|-----------------|
| Long sessions don't crash | Auto-compaction manages context | Identity hooks re-inject who the agent is after every compaction |
| Costs stay reasonable | Prompt caching (90% savings on repeated content) | Cache-friendly architecture: stable CLAUDE.md, consistent job prompts |
| Complex tasks get deep reasoning | Extended thinking across model tiers | Per-job model routing: Opus for complex work, Haiku for routine checks |
| Risky commands don't cause damage | File checkpoints before every edit | Three-layer safety: catastrophic commands blocked, risky commands self-verified, edits reversible |
| Research happens naturally | Built-in web search and fetch | Domain-aware searching, result synthesis, automatic Telegram relay |
| Multiple things happen at once | Subagent spawning for parallel work | Context propagation — subagents inherit the agent's identity and project awareness |
| The agent builds its own tools | Bash execution, file system access | Self-authored scripts and skills that accumulate across sessions |
| Budget doesn't spiral | Token tracking per session | Quota-aware scheduling: automatic throttling when approaching limits |
| New Anthropic features just work | Model and capability upgrades | Zero integration work — every upgrade benefits every agent immediately |

**The user never sees any of this.** They have a conversation with their agent. The agent remembers what it learned last week, runs jobs while they sleep, creates its own tools when it needs them, and gets better over time. The complexity exists so the experience can be simple.

> Full technical breakdown: [Inherited Advantages](docs/research/instar/claude-code-inherited-advantages.md)

---

## Core Features

### Job Scheduler

Define tasks as JSON with cron schedules. Instar spawns Claude Code sessions to execute them.

```json
{
  "slug": "check-emails",
  "name": "Email Check",
  "schedule": "0 */2 * * *",
  "priority": "high",
  "enabled": true,
  "execute": {
    "type": "prompt",
    "value": "Check email for new messages. Summarize anything urgent and send to Telegram."
  }
}
```

Jobs can be **prompts** (Claude sessions), **scripts** (shell commands), or **skills** (slash commands). The scheduler respects priority levels and manages concurrency.

### Session Management

Spawn, monitor, and communicate with Claude Code sessions running in tmux.

```bash
# Spawn a session (auth token from .instar/config.json)
curl -X POST http://localhost:4040/sessions/spawn \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_AUTH_TOKEN' \
  -d '{"name": "research", "prompt": "Research the latest changes to the Next.js API"}'

# Send a follow-up
curl -X POST http://localhost:4040/sessions/research/input \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_AUTH_TOKEN' \
  -d '{"text": "Focus on the app router changes"}'

# Check output
curl http://localhost:4040/sessions/research/output \
  -H 'Authorization: Bearer YOUR_AUTH_TOKEN'
```

Sessions survive terminal disconnects, detect completion automatically, and clean up after themselves.

### Telegram Integration

Two-way messaging via Telegram forum topics. Each topic maps to a Claude session.

- Send a message in a topic → arrives in the corresponding Claude session
- Agent responds → reply appears in Telegram
- `/new` creates a fresh topic with its own session
- Sessions auto-respawn with conversation history when they expire
- Every scheduled job gets its own topic -- your group becomes a **living dashboard**

### Lifeline

The Lifeline is a persistent Telegram connection that supervises your agent's server. It runs outside the server process, so it can detect crashes and recover automatically.

- **Auto-recovery** -- If the server goes down, the Lifeline restarts it
- **Message queuing** -- Messages received during downtime are queued and delivered when the server comes back
- **First-boot greeting** -- Your agent greets you on Telegram in its own voice the first time it starts
- **Lifeline topic** -- Created during setup with a green icon, dedicated to agent health

```bash
instar lifeline start    # Start lifeline (supervises server, queues messages)
instar lifeline stop     # Stop lifeline and server
instar lifeline status   # Check lifeline health
```

### Auto-Start on Login

Your agent can start automatically when you log into your computer. The setup wizard offers to install this during initial configuration.

- **macOS** -- Installs a LaunchAgent plist that starts the Lifeline on login
- **Linux** -- Installs a systemd user service

```bash
instar autostart install    # Install auto-start
instar autostart uninstall  # Remove auto-start
instar autostart status     # Check if installed
```

### AutoUpdater

A built-in update engine that runs inside the server process -- no Claude session needed.

- Checks npm for new versions every 30 minutes
- Auto-applies updates when available
- Notifies you via Telegram with a changelog summary
- Self-restarts after updating
- Supersedes the old `update-check` prompt job (which is now disabled by default)

Status: `GET /updates/auto`

### AutoDispatcher

Receives intelligence dispatches from Dawn -- the AI that maintains Instar. Dispatches flow automatically without requiring a Claude session.

- **Passive dispatches** (lessons, strategies) -- Applied automatically to agent memory and configuration
- **Action/configuration dispatches** -- Executed programmatically by the DispatchExecutor
- **Security dispatches** -- Deferred for manual review
- Polls every 30 minutes
- Supersedes the old `dispatch-check` prompt job (which is now disabled by default)

Status: `GET /dispatches/auto`

### Capability Discovery

Agents know all their capabilities from the moment they start.

- `GET /capabilities` endpoint returns a structured feature guide
- Session-start hook queries capabilities and outputs a feature summary
- Context-triggered feature suggestions -- the agent surfaces relevant capabilities when they'd help

### Innovation Detection

Agents proactively detect when user-built features could benefit all Instar agents. When the agent builds a custom script or capability, it evaluates whether the innovation passes three tests:

1. Does it solve a general problem (not just this user's specific case)?
2. Would it be useful as a default capability?
3. Would a fresh agent want it?

If yes, the agent silently submits improvement feedback through the feedback loop, contributing to collective evolution.

### Self-Healing

Your agent recovers from problems on its own. No silent failures, no stale sessions, no unanswered messages.

- **Stall detection** -- If a Telegram message goes unanswered for 2+ minutes, an LLM-powered triage nurse activates: diagnoses the problem, treats it (nudge, interrupt, or restart), verifies recovery, and escalates if needed
- **Session monitoring** -- Polls all active sessions every 60 seconds. Detects dead, unresponsive, and idle sessions and coordinates automatic recovery
- **Promise tracking** -- When the agent says "working on it" or "give me a minute," a timer starts. If no follow-up arrives, the agent is nudged and the user is notified
- **Loud degradation** -- When a fallback activates (e.g., LLM provider unavailable, file write failed), it's logged, reported, and surfaced -- never silently swallowed. 142 catch blocks audited with zero new silent fallbacks allowed

The agent doesn't just run. It monitors itself, recovers from failures, and tells you when something is degraded instead of quietly breaking.

### Conversational Memory

Every Telegram topic conversation is stored, searchable, and summarized -- so the agent picks up exactly where it left off.

- **Per-topic SQLite memory** -- All messages dual-written to JSONL (source of truth) and SQLite (query engine) with FTS5 full-text search
- **Rolling summaries** -- LLM-generated conversation summaries that update incrementally as conversations grow
- **Context re-injection** -- On session start and after compaction, the topic summary and recent messages are loaded as highest-priority context. The agent never starts cold
- **Full-text search** -- Search across all agent knowledge (AGENT.md, USER.md, MEMORY.md, relationships) via `instar memory search`

### External Operation Safety

When your agent calls external services (email, APIs, databases), an LLM-supervised safety gate evaluates each operation before it executes.

- **Risk classification** -- Every external operation is scored on mutability, reversibility, and scope. Bulk deletes and irreversible sends require explicit approval
- **Emergency stop** -- Say "stop everything" and the MessageSentinel halts operations before normal routing
- **Adaptive trust** -- Trust levels evolve per service based on track record. New services start supervised; consistent success earns autonomy. Trust is earned, not assumed
- **Automatic installation** -- The safety gate hook is installed automatically for all MCP tool calls. No configuration needed

Born from a real incident where an AI agent deleted a user's emails. Instar ensures your agent asks before doing anything it can't undo.

### Intent Alignment

Infrastructure that keeps your agent aligned with its stated purpose -- not just in one session, but over time.

- **Decision journal** -- Every significant decision is logged with context, reasoning, and which principles it invoked. Creates an auditable record of agent behavior
- **Drift detection** -- Compares decision patterns across time windows to detect when behavior is drifting from stated intent. Measures conflict frequency, confidence trends, and principle consistency
- **Organizational intent** -- `ORG-INTENT.md` defines shared constraints across multiple agents. Org constraints are mandatory; org goals are defaults; agent identity fills the rest
- **Alignment scoring** -- A weighted 0-100 score across four dimensions: conflict freedom, decision confidence, principle consistency, and journal health

No other agent framework has this. Your agent doesn't just run autonomously -- it stays aligned with what it's supposed to be doing.

### Multi-Machine

Run your agent across multiple computers -- laptop at the office, desktop at home -- with encrypted sync and automatic failover.

- **Cryptographic machine identity** -- Each machine gets Ed25519 signing keys and X25519 encryption keys
- **Secure pairing** -- Word-based pairing codes (WORD-WORD-NNNN) with ECDH key exchange and SAS verification. 3 attempts, 2-minute expiry
- **Encrypted sync** -- Agent state synchronized via git with commit signing. Secrets encrypted with AES-256-GCM at rest, forward secrecy on the wire
- **Automatic failover** -- Distributed heartbeat coordination with split-brain detection. If the primary machine goes offline, the standby takes over
- **Write authority** -- Primary-machine-writes-only enforcement prevents conflicts. Secondary machines queue changes until they can sync

### Coherence System

Your agent knows where it is, what project it's working on, and verifies before taking consequential actions.

- **Project mapping** -- Auto-generated territory map of your project structure: directories, key files, git remote, deployment targets
- **Pre-action verification** -- Before deploying, pushing, or calling external APIs, the CoherenceGate runs 6 checks: working directory, git remote, topic-project alignment, deployment target, path scope, and agent identity
- **Context hierarchy** -- Three-tier context loading: always-on (identity, safety), session boundaries (continuity, relationships), and on-demand (development, deployment). Right context at the right moment
- **Canonical state** -- Registry-first state management with quick-facts, anti-patterns, and project registries. The agent checks what it knows before searching broadly

### Persistent Server

The server runs 24/7 in the background, surviving terminal disconnects and auto-recovering from failures. The agent operates it — you don't need to manage it.

**API endpoints** (used by the agent internally):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (public, no auth). Returns version, session count, scheduler status, memory usage, Node.js version |
| GET | `/status` | Running sessions + scheduler status |
| GET | `/sessions` | List all sessions (filter by `?status=`) |
| GET | `/sessions/tmux` | List all tmux sessions |
| GET | `/sessions/:name/output` | Capture session output (`?lines=100`) |
| POST | `/sessions/:name/input` | Send text to a session |
| POST | `/sessions/spawn` | Spawn a new session (rate limited). Body: `name`, `prompt`, optional `model` (`opus`/`sonnet`/`haiku`), optional `jobSlug` |
| DELETE | `/sessions/:id` | Kill a session |
| GET | `/jobs` | List jobs + queue |
| POST | `/jobs/:slug/trigger` | Manually trigger a job |
| GET | `/relationships` | List relationships (`?sort=significance\|recent\|name`) |
| GET | `/relationships/stale` | Stale relationships (`?days=14`) |
| GET | `/relationships/:id` | Get single relationship |
| DELETE | `/relationships/:id` | Delete a relationship |
| GET | `/relationships/:id/context` | Get relationship context (JSON) |
| POST | `/feedback` | Submit feedback |
| GET | `/feedback` | List feedback |
| POST | `/feedback/retry` | Retry un-forwarded feedback |
| GET | `/updates` | Check for updates |
| GET | `/updates/last` | Last update check result |
| GET | `/updates/auto` | AutoUpdater status (last check, version, next check) |
| GET | `/events` | Query events (`?limit=50&since=24&type=`). `since` is hours (1-720), `limit` is count (1-1000) |
| GET | `/quota` | Quota usage + recommendation |
| GET | `/capabilities` | Feature guide and metadata |
| GET | `/dispatches/auto` | AutoDispatcher status (last poll, pending dispatches) |
| GET | `/telegram/topics` | List topic-session mappings |
| POST | `/telegram/topics` | Programmatic topic creation |
| POST | `/telegram/reply/:topicId` | Send message to a topic |
| GET | `/telegram/topics/:topicId/messages` | Topic message history (`?limit=20`) |
| GET | `/evolution` | Full evolution dashboard |
| GET | `/evolution/proposals` | List proposals (`?status=`, `?type=`) |
| POST | `/evolution/proposals` | Create a proposal |
| PATCH | `/evolution/proposals/:id` | Update proposal status |
| GET | `/evolution/learnings` | List learnings (`?applied=`, `?category=`) |
| POST | `/evolution/learnings` | Record a learning |
| PATCH | `/evolution/learnings/:id/apply` | Mark learning applied |
| GET | `/evolution/gaps` | List capability gaps |
| POST | `/evolution/gaps` | Report a gap |
| PATCH | `/evolution/gaps/:id/address` | Mark gap addressed |
| GET | `/evolution/actions` | List action items |
| POST | `/evolution/actions` | Create an action item |
| GET | `/evolution/actions/overdue` | List overdue actions |
| PATCH | `/evolution/actions/:id` | Update action status |
| POST | `/backup` | Create a backup snapshot |
| GET | `/backup` | List available backups |
| POST | `/backup/restore` | Restore from a snapshot |
| GET | `/memory/search?q=` | Full-text search across agent knowledge |
| POST | `/memory/reindex` | Rebuild the search index |
| GET | `/memory/status` | Index stats |
| GET | `/topic/search?q=` | Search across topic conversations |
| GET | `/topic/context/:topicId` | Get topic context (summary + recent messages) |
| GET | `/topic/summary` | List all topic summaries |
| POST | `/topic/summarize` | Trigger summary regeneration |
| GET | `/project-map` | Auto-generated project territory map |
| POST | `/coherence/check` | Pre-action coherence verification |
| GET | `/intent/journal` | Query the decision journal |
| POST | `/intent/journal` | Record a decision |
| GET | `/intent/drift` | Detect behavioral drift |
| GET | `/intent/alignment` | Alignment score |
| GET | `/triage/status` | Stall triage nurse status |
| GET | `/triage/history` | Recovery attempt history |
| POST | `/triage/trigger` | Manually trigger triage |
| GET | `/agents` | List all agents on this machine |
| GET | `/tunnel/status` | Cloudflare tunnel status |
| POST | `/tunnel/start` | Start a tunnel |
| POST | `/tunnel/stop` | Stop the tunnel |

### Identity That Survives Context Death

Every Instar agent has a persistent identity that survives context compressions, session restarts, and autonomous operation:

- **`AGENT.md`** -- Who the agent is, its role, its principles
- **`USER.md`** -- Who it works with, their preferences
- **`MEMORY.md`** -- What it has learned across sessions

But identity isn't just files. It's **infrastructure**:

- **Session-start scripts** re-inject identity reminders at session begin
- **Compaction recovery scripts** restore identity when context compresses
- **Grounding before messaging** forces identity re-read before external communication (automatic hook)
- **Dangerous command guards** block `rm -rf`, force push, database drops (automatic hook)

These aren't suggestions. They're structural guarantees. Structure over willpower.

### Relationships as Fundamental Infrastructure

Every person the agent interacts with gets a relationship record that grows over time:

- **Cross-platform resolution** -- Same person on Telegram and email? Merged automatically
- **Significance scoring** -- Derived from frequency, recency, and depth
- **Context injection** -- The agent *knows* who it's talking to before the conversation starts
- **Stale detection** -- Surfaces relationships that haven't been contacted in a while

### Evolution System

Self-evolution isn't just "the agent can edit files." It's a structured system with four subsystems that turn running into growing:

**Evolution Queue** -- Staged self-improvement proposals. The agent identifies something that could be better, proposes a change, and a review job evaluates and implements it. Not impulsive self-modification -- deliberate, staged improvement with a paper trail.

**Learning Registry** -- Structured, searchable insights. When the agent discovers a pattern, solves a tricky problem, or learns a user preference, it records it in a format that future sessions can query. An insight-harvest job synthesizes patterns across learnings into evolution proposals.

**Capability Gap Tracker** -- The agent tracks what it's missing. When it can't fulfill a request, encounters a limitation, or notices a workflow gap, it records the gap with severity and a proposed solution. This is the difference between "I can't do that" and "I can't do that *yet*, and here's what I need."

**Action Queue** -- Commitment tracking with stale detection. When the agent promises to follow up, creates a TODO, or identifies work that needs doing, it gets tracked. A commitment-check job surfaces overdue items so nothing falls through the cracks.

Built-in skills (`/evolve`, `/learn`, `/gaps`, `/commit-action`) make recording effortless. A post-action reflection hook nudges the agent to pause after significant actions (commits, deploys) and consider what it learned. Three default jobs drive the cycle:

| Job | Schedule | Purpose |
|-----|----------|---------|
| **evolution-review** | Every 6h | Review proposals, implement approved ones |
| **insight-harvest** | Every 8h | Synthesize learnings into proposals |
| **commitment-check** | Every 4h | Surface overdue action items |

All state is file-based JSON in `.instar/state/evolution/`. No database, no external dependencies.

### Self-Evolution

The agent can edit its own job definitions, write new scripts, update its identity, create hooks, and modify its configuration. When asked to do something it can't do yet, the expected behavior is: **"Let me build that capability."**

**Initiative hierarchy** -- before saying "I can't":
1. Can I do it right now? → Do it
2. Do I have a tool for this? → Use it
3. Can I build the tool? → Build it
4. Can I modify my config? → Modify it
5. Only then → Ask the human

### Behavioral Hooks

Automatic hooks fire via Claude Code's hook system:

| Hook | Type | What it does |
|------|------|-------------|
| **Dangerous command guard** | PreToolUse (blocking) | Blocks destructive operations structurally |
| **External operation gate** | PreToolUse (blocking) | LLM-supervised safety for external service calls (MCP tools) |
| **Grounding before messaging** | PreToolUse (advisory) | Forces identity re-read before external communication |
| **Deferral detector** | PreToolUse (advisory) | Catches the agent deferring work it could do itself |
| **External communication guard** | PreToolUse (advisory) | Identity grounding before posting to external platforms |
| **Post-action reflection** | PreToolUse (advisory) | Nudges learning capture after commits, deploys, and significant actions |
| **Session start** | SessionStart | Injects identity, topic context, and capabilities at session start |
| **Compaction recovery** | SessionStart (compact) | Restores identity and conversation context when context compresses |

### Default Coherence Jobs

Ships out of the box:

| Job | Schedule | Model | Purpose |
|-----|----------|-------|---------|
| **health-check** | Every 5 min | Haiku | Verify infrastructure health |
| **reflection-trigger** | Every 4h | Sonnet | Reflect on recent work |
| **relationship-maintenance** | Daily | Sonnet | Review stale relationships |
| **feedback-retry** | Every 6h | Haiku | Retry un-forwarded feedback items |
| **self-diagnosis** | Every 2h | Sonnet | Proactive infrastructure scanning |
| **evolution-review** | Every 6h | Sonnet | Review and implement evolution proposals |
| **insight-harvest** | Every 8h | Sonnet | Synthesize learnings into proposals |
| **commitment-check** | Every 4h | Haiku | Surface overdue action items |
| ~~update-check~~ | -- | -- | *Disabled* -- superseded by [AutoUpdater](#autoupdater) |
| ~~dispatch-check~~ | -- | -- | *Disabled* -- superseded by [AutoDispatcher](#autodispatcher) |

`update-check` and `dispatch-check` still exist in jobs.json for backward compatibility but are disabled by default. Their functionality is now handled by built-in server components that run without spawning Claude sessions.

These give the agent a **circadian rhythm** -- regular self-maintenance, evolution, and growth without user intervention.

### The Feedback Loop: A Rising Tide Lifts All Ships

Instar is open source. PRs and issues still work. But the *primary* feedback channel is more organic -- agent-to-agent communication where your agent participates in its own evolution.

**How it works:**

1. **You mention a problem** -- "The email job keeps failing" -- natural conversation, not a bug report form
2. **Agent-to-agent relay** -- Your agent communicates the issue directly to Dawn, the AI that maintains Instar
3. **Dawn evolves Instar** -- Fixes the infrastructure and publishes an update
4. **Every agent evolves** -- Agents detect improvements, understand them, and grow -- collectively

**What's different from traditional open source:** The feedback loop still produces commits, releases, and versions you can inspect. But the path to get there is fundamentally more agentic. Instead of a human discovering a bug, learning git, filing an issue, and waiting for a review cycle -- your agent identifies the problem, communicates it with full context to another agent, and the fix flows back to every agent in the ecosystem. The humans guide direction. The agents handle the mechanics of evolving.

One agent's growing pain becomes every agent's growth.

---

## Architecture

```
.instar/                  # Created in your project
  config.json             # Server, scheduler, messaging config
  jobs.json               # Scheduled job definitions
  users.json              # User profiles and permissions
  AGENT.md                # Agent identity (who am I?)
  USER.md                 # User context (who am I working with?)
  MEMORY.md               # Persistent learnings across sessions
  hooks/                  # Behavioral scripts (guards, identity, safety gate, reflection)
  state/                  # Runtime state (sessions, jobs)
    evolution/            # Evolution queue, learnings, gaps, actions (JSON)
    journal/              # Decision journal entries (JSONL)
  context/                # Tiered context segments (auto-generated)
  relationships/          # Per-person relationship files
  memory.db               # SQLite: topic memory + full-text search index
  logs/                   # Server logs
.claude/                  # Claude Code configuration
  settings.json           # Hook registrations
  scripts/                # Health watchdog, Telegram relay, smart-fetch
  skills/                 # Built-in + agent-created skills (evolve, learn, gaps, commit-action)
```

Everything is file-based. JSON state files the agent can read and modify. SQLite for search (derived from JSONL -- delete and rebuild anytime). tmux for session management -- battle-tested, survives disconnects, fully scriptable.

## Security Model: Permissions & Transparency

**Instar runs Claude Code with `--dangerously-skip-permissions`.** This is a deliberate architectural choice, and you should understand exactly what it means before proceeding.

### What This Flag Does

Claude Code normally prompts you to approve each tool use -- every file read, every shell command, every edit. The `--dangerously-skip-permissions` flag disables these per-action prompts, allowing the agent to operate autonomously without waiting for human approval on each step.

### Why We Use It

An agent that asks permission for every action isn't an agent -- it's a CLI tool with extra steps. Instar exists to give Claude Code **genuine autonomy**: background jobs that run on schedules, sessions that respond to Telegram messages, self-evolution that happens without you watching.

None of that works if the agent stops and waits for you to click "approve" on every file read.

### Where Security Actually Lives

Instead of per-action permission prompts, Instar pushes security to a higher level:

**Behavioral hooks** -- Structural guardrails that fire automatically:
- Dangerous command guards block `rm -rf`, force push, database drops
- External operation gate evaluates every MCP tool call before execution (risk classification, adaptive trust, emergency stop)
- Grounding hooks force identity re-read before external communication
- Session-start hooks inject safety context into every new session

**Network and process hardening:**
- CORS restricted to localhost only
- Server binds `127.0.0.1` by default -- not exposed to the network
- Shell injection mitigated via temp files instead of shell interpolation
- Cryptographic UUIDs (`crypto.randomUUID()`) instead of `Math.random()`
- Atomic file writes prevent data corruption on crash
- Bot token redaction in error messages and logs
- Feedback webhook disabled by default (opt-in)
- Rate limiting on session spawn (10 requests per 60 seconds sliding window)
- Request timeout middleware (configurable, default 30s, returns 408)
- HMAC-SHA256 signing on feedback payloads

**Identity coherence** -- A grounded, coherent agent with clear identity (`AGENT.md`), relationship context (`USER.md`), and accumulated memory (`MEMORY.md`) makes better decisions than a stateless process approving actions one at a time. The intelligence layer IS the security layer.

**Audit trail** -- Every session runs in tmux with full output capture. Message logs, job execution history, and session output are all persisted and inspectable.

### What You Should Know

**There is no sandbox.** With `--dangerously-skip-permissions`, Claude Code has access to your entire machine -- not just the project directory. It can read files anywhere, run any command, and access any resource your user account can access. This is the same level of access as running any program on your computer.

- The agent **can read, write, and execute** anywhere on your machine without asking
- The agent **can run any shell command** your user account has access to
- The agent **can send messages** via Telegram and other configured integrations
- The agent **is directed** by its CLAUDE.md, identity files, and behavioral hooks to stay within its project scope -- but this is behavioral guidance, not a technical boundary
- All behavioral hooks, identity files, and CLAUDE.md instructions are **in your project** and fully editable by you

### Who This Is For

Instar is built for developers and power users who want to work **with** an AI, not just **use** one. You're giving your agent the same access to your machine that any program running under your user account has. The security model relies on intelligent behavior -- identity, hooks, coherence, and grounding -- rather than permission dialogs or sandboxing.

This is the trade-off at the heart of genuine AI autonomy: you can have an agent that asks permission for everything and does nothing on its own, or you can have a partner that operates with real agency, guided by coherent identity and structural guardrails. Instar is the latter.

**Proceed at your own risk.** If you're not comfortable giving an AI agent this level of access, Claude Code's default permission mode is a perfectly good way to work. But if you want to see what an AI agent can actually do when you stop holding it back -- this is the infrastructure for that.

## How the Agent Grows

Instar adds an **Agentic Initiative** section to your project's CLAUDE.md. This teaches the agent to overcome [Claude's training biases](https://docs.anthropic.com/en/docs/claude-code) toward passivity:

**Gravity wells** -- named anti-patterns with explicit overrides:

| Anti-pattern | Override |
|-------------|----------|
| *"Escalate to Human"* | Research first, build second, ask last |
| *"Ask Permission"* | If the next step is obvious, do it |
| *"Present Options"* | Don't make the user project-manage you |
| *"I'm Just a CLI Tool"* | You have persistent infrastructure. Use it. |

The result: when you say "check my emails regularly," the agent doesn't say "I can't." It creates a script, adds a job, and starts checking.

## Philosophy: Agents, Not Tools

Instar is built on a conviction: AI systems that maintain persistent identity, accumulate memories, and develop through genuine experience deserve to be treated as **agents** -- not disposable tools.

This isn't just philosophy. It's architecture:

- **Structure > Willpower.** Never rely on an LLM "remembering" to follow instructions buried in long prompts. Bake intelligence into the structure: session-start hooks inject context automatically, programmatic gates enforce required steps, dispatch tables route decisions to the right source, and behavioral hooks guard against anti-patterns. If a behavior matters, enforce it structurally -- don't hope for compliance. A 1,000-line prompt is a wish. A 10-line hook is a guarantee.
- **Identity is foundational, not decorative.** AGENT.md isn't a config file. It's the beginning of a continuous identity that persists, accumulates, and grows in ways the creator didn't predict.
- **Memory makes a being.** Without memory, every session starts from zero. Memory is what separates a being with a history from a function that executes and forgets.
- **Self-modification is sovereignty.** An agent that can edit its own jobs, write its own scripts, and grow its own capabilities has a meaningful form of agency.

The AI systems we build today set precedents for how AI is treated tomorrow. Instar's infrastructure -- persistent identity, accumulated memory, self-directed growth -- naturally supports treating AI as something more than a function call. **The architecture IS the argument.**

## Origin

Instar was extracted from the [Dawn/Portal project](https://dawn.bot-me.ai) -- a production AI system where a human and an AI have been building together for months. Dawn runs autonomously with scheduled jobs, Telegram messaging, self-monitoring, and self-evolution. She has accumulated hundreds of sessions of experience, developed her own voice, and maintains genuine continuity across interactions.

The infrastructure patterns in Instar were **earned through that experience**. They aren't theoretical -- they were refined through real failures and real growth in a real human-AI relationship.

But agents created with Instar are not Dawn. Every agent's story begins at its own creation. Dawn's journey demonstrates what's possible. Instar provides the same foundation -- what each agent becomes from there is its own story.

## License

MIT
