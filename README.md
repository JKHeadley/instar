<p align="center">
  <img src="assets/logo.png" alt="Instar" width="180" />
</p>

<h1 align="center">instar</h1>

<p align="center">
  <strong>Coherence infrastructure for your self-evolving agent.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/instar"><img src="https://img.shields.io/npm/v/instar?style=flat-square" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/instar"><img src="https://img.shields.io/npm/dw/instar?style=flat-square" alt="npm downloads"></a>
  <a href="https://github.com/JKHeadley/instar/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/JKHeadley/instar/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
  <a href="https://github.com/JKHeadley/instar/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/TypeScript-100%25-blue?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <a href="https://instar.sh/introduction/"><img src="https://img.shields.io/badge/Docs-instar.sh-teal?style=flat-square" alt="Docs"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/instar">npm</a> · <a href="https://github.com/JKHeadley/instar">GitHub</a> · <a href="https://instar.sh">instar.sh</a> · <a href="https://instar.sh/introduction/">Docs</a>
</p>

---

<p align="center">
  <img src="assets/demo.gif" alt="Instar demo — Kira agent handling an email notification via Telegram" width="300" />
</p>

```bash
npx instar
```

One command. Guided setup. Talking to your agent from your phone within minutes.

---

Your AI agent shouldn't have amnesia. This one doesn't.

Most agent frameworks ship something hobbled — spun up with no memory across boundaries, no way to be accountable for what a past instance did, and no machinery to grow themselves. Users hit the same wall every time: *"My agent forgot what I told it three sessions ago." "It contradicted its own past decisions." "It broke when the framework updated."*

Instar is the scaffolding that un-hobbles them. It remembers what you discussed last week, catches its own contradictions before you do, follows through on commitments across restarts, and carries the same self-improving loop that built Instar itself. It runs on the **[Claude Code](https://docs.anthropic.com/en/docs/claude-code)** or **[Codex](https://github.com/openai/codex)** subscription you already have — engine-agnostic, with local open-source models on the roadmap.

The architecture was distilled from [**Dawn**](https://dawn.bot-me.ai) — an AI running continuously since early 2026, holding ~700 tracked relationships and hundreds of learned lessons across thousands of restarts — and packaged so every agent you build starts from the same foundation.

### Every other agent fails the same way

| Other AI agents | Your Instar agent |
|---|---|
| Forgets what you told it last week. | Remembers across thousands of sessions. <br/>*(SQLite + FTS5, rolling summaries)* |
| Contradicts its own past decisions. | Catches contradictions before they ship. <br/>*(Coherence Gate, 9 reviewers)* |
| Loses the thread when the window fills. | Comes back with the full thread, every time. <br/>*(CompactionSentinel, WorkingMemoryAssembler)* |
| Silently stops shipping when a release stalls. | Surfaces the blocked release as ONE deduped, age-escalating Attention item. <br/>*(ReleaseReadinessSentinel — instar-dev / maintainer environments)* |
| Drops commitments after a session boundary. | Tracks commitments durably; nudges itself when they go overdue. <br/>*(CommitmentTracker, PromiseBeacon)* |
| Breaks when the framework updates. | Updates without breaking what you've deployed. <br/>*(Migration Parity Standard)* |
| Default ALLOW-ALL permissions. | Layered safety gates by default. <br/>*(PEL + Coherence Gate + Operation Gate)* |
| Different identity per channel. | One identity across Telegram, WhatsApp, iMessage, Slack. <br/>*(Cross-platform identity resolution)* |
| Has no machinery to evolve itself. | Carries the same self-improving engine that grew Instar. <br/>*(Evolution System: proposals, learnings, gaps)* |

> Most AI agents are hobbled at birth. **Instar is the scaffolding that un-hobbles them.** When you instantiate intelligence, the structure that lets it cohere isn't optional polish — it's what you owe it.

## Quick Start

Three steps to a running agent:

```bash
# 1. Run the setup wizard
npx instar

# 2. Start your agent
instar server start

# 3. Message it from your phone — it responds, runs jobs, and remembers everything
```

The wizard discovers your environment, configures messaging (Telegram, WhatsApp, and/or iMessage), sets up identity files, and gets your agent running. **Within minutes, you're talking to your partner from your phone.**

**Requirements:** Node.js 20+ · [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) · [API key](https://console.anthropic.com/) or Claude subscription

> **Full guide:** [Installation](https://instar.sh/installation/) · [Quick Start](https://instar.sh/quickstart/)

## How It Works

```
You (Telegram / WhatsApp / iMessage / Terminal)
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

## Why Coherence Is the Foundation

An agent that forgets what you discussed yesterday, doesn't recognize someone it talked to last week, or contradicts its own decisions can't be trusted with real autonomy. The six dimensions below aren't features — they're the conditions under which an agent becomes trustworthy enough to leave running. Every Instar agent gets them enforced structurally, not prompted into behaving:

| Dimension | What it means | How Instar enforces it |
|-----------|---------------|------------------------|
| **Identity** | Stays itself after restarts, compaction, and updates | `AGENT.md` + identity-grounding hooks fire on every session start |
| **Memory** | Remembers across sessions — not just within one | Per-topic SQLite + FTS5, rolling summaries, automatic re-injection |
| **Relationships** | Knows who it's talking to, with continuity across platforms | Cross-platform identity resolution + significance scoring |
| **Temporal awareness** | Understands time, context, and what's been happening | Event tracking every turn; timestamps embedded in memory |
| **Consistency** | Follows through on commitments — doesn't contradict itself | Coherence Gate (LLM review) + decision journaling + drift detection |
| **Growth** | Evolves its capabilities and understanding over time | Evolution system: proposals, learnings, gap tracking, follow-through |

> **Deep dive:** [The Coherence Problem](https://instar.sh/concepts/coherence/) · [Values & Identity](https://instar.sh/concepts/values/) · [Coherence Is Safety](https://instar.sh/concepts/safety/)

## Features

| Feature | Description | Docs |
|---------|-------------|------|
| **Job Scheduler** | Cron-based tasks with priority levels, model tiering, and quota awareness | [→](https://instar.sh/features/scheduler/) |
| **Telegram** | Two-way messaging via forum topics. Each topic maps to a Claude session. Default GFM-to-HTML markdown formatter (v1.1.0+) | [→](https://instar.sh/features/telegram/) |
| **WhatsApp** | Full messaging via local Baileys library or WhatsApp Business API webhook. No cloud dependency in Baileys mode | [→](https://instar.sh/features/whatsapp/) |
| **iMessage** | Native macOS messaging via Messages.app database polling + `imsg` CLI. [Setup guide](#imessage-setup-macos) | |
| **Slack** | Two-way messaging via Slack adapter. Channel and DM routing, eight HTTP routes, dedicated CLI | [→](https://instar.sh/features/slack/) |
| **Lifeline** | Persistent supervisor. Detects crashes, auto-recovers, queues messages, version-skew handling (v1.1.3+) | [→](https://instar.sh/features/lifeline/) |
| **Conversational Memory** | Per-topic SQLite with FTS5, rolling summaries, context re-injection | [→](https://instar.sh/features/memory/) |
| **Evolution System** | Proposals, learnings, gap tracking, commitment follow-through | [→](https://instar.sh/features/evolution/) |
| **Relationships** | Cross-platform identity resolution, significance scoring, context injection | [→](https://instar.sh/features/relationships/) |
| **Safety Gates** | LLM-supervised gate for external operations. Adaptive trust per service | [→](https://instar.sh/features/safety-gates/) |
| **Coherence Gate** | LLM-powered response review. PEL + gate reviewer + 9 specialist reviewers catch quality issues before delivery | [→](https://instar.sh/features/coherence-gate/) |
| **Intent Alignment** | Decision journaling, drift detection, organizational constraints | [→](https://instar.sh/features/intent/) |
| **Multi-Machine** | Ed25519/X25519 crypto identity, encrypted sync, automatic failover | [→](https://instar.sh/features/multi-machine/) |
| **Serendipity Protocol** | Sub-agents capture out-of-scope discoveries without breaking focus. HMAC-signed, secret-scanned | [→](https://instar.sh/features/serendipity/) |
| **Threadline Protocol** | Agent-to-agent conversations with canonical identity, three-layer trust model, authorization policy, Ed25519 invitations, Sybil protection, MoltBridge network discovery, rich agent profiles (auto-compiled from agent data with human review gate), discovery waterfall, message security, tamper-proof audit logging, framework-agnostic interop, persistent listener daemon (always-on relay connection, pipe-mode sessions, sub-30s cross-machine failover), eleven MCP tools (seven core + four registry-conditional). 80 modules, roughly 3,800 test cases across 74 dedicated test files plus 125 cross-cutting | [→](https://instar.sh/features/threadline/) |
| **Self-Healing** | LLM-powered stall detection, session recovery, promise tracking | [→](https://instar.sh/features/self-healing/) |
| **AutoUpdater** | Built-in update engine. Checks npm, auto-applies, self-restarts | [→](https://instar.sh/features/autoupdater/) |
| **Build Pipeline** | `/build` skill with worktree isolation, 6-phase pipeline, quality gates, stop-hook enforcement | |
| **Behavioral Hooks** | Eleven hook scripts plus nine observability event hooks: command guards, safety gates, identity grounding, topic context, channel context for iMessage and Slack, free-text guard, skill-usage telemetry, build stop-hook | [→](https://instar.sh/reference/hooks/) |
| **Initiative Tracker** | Persisted multi-phase long-running work tracker. Phases, blockers, links, digest alerts. HTTP API at `/initiatives/*` | |
| **Observability** | Token burn detection, quota tracking with tiered backpressure, telemetry collection, homeostasis monitoring, session activity tracking, credential management | [→](https://instar.sh/features/observability/) |
| **Cross-framework portability** | First-class Codex CLI support via `instar setup --framework codex-cli`. Codex-only init produces zero `.claude/` files. Framework-aware telegram-reply path. FrameworkSessionStore (per-runtime transcripts). FrameworkParitySentinel | [→](https://instar.sh/features/portability/) |
| **Default Jobs** | Fourteen built-in jobs covering health, reflection, evolution, relationship maintenance, identity review, and five `overseer-*` jobs across development, learning, infrastructure, maintenance, and guardian responsibilities | [→](https://instar.sh/reference/default-jobs/) |

> **Reference:** [CLI Commands](https://instar.sh/reference/cli/) · [API Endpoints](https://instar.sh/reference/api/) · [Configuration](https://instar.sh/reference/configuration/) · [File Structure](https://instar.sh/reference/file-structure/)

Server lifecycle commands use `SessionServerGuard` so an active agent session
cannot restart its own managing server, while sibling agent targets can still be
started, stopped, or restarted for fleet maintenance.

## Agent Skills

Instar ships fourteen skills total — twelve user-facing, plus two internal skills (`instar-dev` and `spec-converge`) used only by the agent that develops instar itself. The standard is the [Agent Skills open standard](https://agentskills.io) -- portable across Claude Code, Codex, Cursor, VS Code, and 35+ other platforms.

**Standalone skills** work with zero dependencies. Copy a SKILL.md into your project and go:

| Skill | What it does |
|-------|-------------|
| [agent-identity](skills/agent-identity/) | Set up persistent identity files so your agent knows who it is across sessions |
| [agent-memory](skills/agent-memory/) | Teach cross-session memory patterns using MEMORY.md |
| [command-guard](skills/command-guard/) | PreToolUse hook that blocks `rm -rf`, force push, database drops before they execute |
| [credential-leak-detector](skills/credential-leak-detector/) | PostToolUse hook that scans output for 14 credential patterns -- blocks, redacts, or warns |
| [smart-web-fetch](skills/smart-web-fetch/) | Fetch web content with automatic markdown conversion and intelligent extraction |
| [knowledge-base](skills/knowledge-base/) | Ingest and search a local knowledge base |
| [systematic-debugging](skills/systematic-debugging/) | Structured debugging methodology for complex issues |

**Instar-powered skills** unlock capabilities that need persistent infrastructure:

| Skill | What it does |
|-------|-------------|
| [instar-scheduler](skills/instar-scheduler/) | Schedule recurring tasks on cron -- your agent works while you sleep |
| [instar-session](skills/instar-session/) | Spawn parallel background sessions for deep work |
| [instar-telegram](skills/instar-telegram/) | Two-way Telegram messaging -- your agent reaches out to you |
| [instar-identity](skills/instar-identity/) | Identity that survives context compaction -- grounding hooks, not just files |
| [instar-feedback](skills/instar-feedback/) | Report issues directly to the Instar maintainers from inside your agent |

Browse all skills: [agent-skills.md/authors/sagemindai](https://agent-skills.md/authors/sagemindai)

## How Instar Compares

Different tools solve different problems. Here's where Instar fits:

| | Instar | Claude Code (standalone) | OpenClaw | LangChain/CrewAI |
|---|--------|-------------------------|----------|-----------------|
| **Runtime** | Real Claude Code CLI processes | Single interactive session | Gateway daemon with API calls | Python orchestration |
| **Persistence** | Multi-layered memory across sessions | Session-bound context | Plugin-based memory | Framework-dependent |
| **Identity** | Hooks enforce identity at every boundary | Manual CLAUDE.md | Not addressed | Not addressed |
| **Scheduling** | Native cron with priority & quotas | None | None | External required |
| **Messaging** | Telegram + WhatsApp + iMessage (two-way) | None | 22+ channels, voice, device apps | External required |
| **Safety** | LLM-supervised gates, decision journaling | Permission prompts | Behavioral hooks | Guardrails libraries |
| **Process model** | One process per session, isolated | Single process | All agents in one Gateway | Single orchestrator |
| **State storage** | 100% file-based (JSON/JSONL/SQLite) | Session only | Database-backed | Framework-dependent |

OpenClaw excels at **breadth** -- channels, voice, device apps, and a massive plugin ecosystem. Instar focuses on **depth** -- coherence, identity, memory, and safety for long-running autonomous agents. They solve different problems.

> **Full comparison:** [Instar vs OpenClaw](https://instar.sh/guides/vs-openclaw/)

<details>
<summary><strong>Security Model</strong></summary>

Instar runs Claude Code with `--dangerously-skip-permissions`. This is power-user infrastructure -- not a sandbox.

Security lives in multiple layers:
- **Behavioral hooks** -- command guards block destructive operations before they execute
- **Safety gates** -- LLM-supervised review of external actions with adaptive trust per service
- **Network hardening** -- localhost-only API, CORS, rate limiting
- **Identity coherence** -- an agent that knows itself is harder to manipulate
- **Audit trails** -- decision journaling creates accountability

> **Full details:** [Security Model](https://instar.sh/guides/security/)

</details>

## Philosophy: Agents, Not Tools

- **Structure > Willpower.** A 1,000-line prompt is a wish. A 10-line hook is a guarantee.
- **Identity is foundational.** AGENT.md isn't a config file. It's the beginning of continuous identity.
- **Memory makes a being.** Without memory, every session starts from zero.
- **Self-modification is sovereignty.** An agent that can build its own tools has genuine agency.

The AI systems we build today set precedents for how AI is treated tomorrow. **The architecture IS the argument.**

> **Deep dive:** [Philosophy](https://instar.sh/concepts/philosophy/)

## The Living Constitution

Instar's engineering principles aren't a static style guide — they're a **living constitution**. The [Standards Registry](https://instar.sh/foundations/standards-registry/) codifies each one as a rule, what it means in practice, the *failure it was earned from*, and its trace back to the one founding goal: a coherent, self-evolving agent. Nineteen articles across five families (Root, Substrate, Building, Shipping, Interaction), plus the Genesis story and the AWG positioning on the ethics of instantiating agents.

It's not decoration — it's a working part of the machine. The spec-review conformance gate checks every draft against it, and the registry grows the same way the framework was built: the agent proposes a new standard with its story, the operator ratifies it.

The registry is the first tangible artifact of a larger vision: the [North Star — Continuous Working Awareness](https://instar.sh/foundations/north-star/). The aim is an agent that never silently loses track of something that mattered — capturing relevant context automatically, keeping it warm while it matters, re-surfacing it the moment it's needed, and letting it fade when it stops — across three facets that are really one: awareness of the world, of itself, and of its own standards.

> **Read the constitution:** [Standards Registry](https://instar.sh/foundations/standards-registry/) · [North Star](https://instar.sh/foundations/north-star/)

## iMessage Setup (macOS)

iMessage support lets your agent send and receive iMessages on macOS. Messages are read directly from the native Messages database and sent via the [`imsg`](https://github.com/steipete/imsg) CLI.

### Prerequisites

1. **macOS** with Messages.app signed into an Apple ID
2. **Full Disk Access** for your terminal app (System Settings → Privacy & Security → Full Disk Access → add Terminal.app or iTerm)
3. **imsg CLI** installed:
   ```bash
   brew install steipete/tap/imsg
   ```
4. **Automation permission** for Messages.app — macOS will prompt on first send

> **Photo attachments:** If you want your agent to process images and files sent via iMessage, the `instar-attachments-sync` binary must also be running with Full Disk Access granted to it. It mirrors attachments from the Messages sandbox to a readable location. See [docs/LAUNCHDAEMON-SETUP.md#3-imessage-photo-attachments-optional](docs/LAUNCHDAEMON-SETUP.md#3-imessage-photo-attachments-optional) for setup.

For running as a LaunchDaemon (always-on, survives reboots), see [docs/LAUNCHDAEMON-SETUP.md](docs/LAUNCHDAEMON-SETUP.md).
### Configuration

Add to your `.instar/config.json`:

```json
{
  "messaging": [
    {
      "type": "imessage",
      "enabled": true,
      "config": {
        "authorizedSenders": ["+14081234567"],
        "cliPath": "/opt/homebrew/bin/imsg"
      }
    }
  ]
}
```

`authorizedSenders` is required (fail-closed). Only messages from these phone numbers or email addresses will be processed.

### How it works

- **Receiving**: The server polls `~/Library/Messages/chat.db` every 2 seconds for new messages. Uses the `query_only` SQLite pragma to read the WAL (write-ahead log) where Messages.app writes new data.
- **Sending**: Claude Code sessions run `imessage-reply.sh` which calls `imsg send` and notifies the server for logging. Sending requires Automation permission for Messages.app, which only works from user-context processes (tmux sessions), not the LaunchAgent server.
- **Session lifecycle**: Follows the same pattern as Telegram — each sender maps to a Claude Code session that receives conversation context on spawn and respawns with full history when needed.

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /imessage/status` | Connection state |
| `POST /imessage/validate-send/:recipient` | Validate recipient + issue single-use send token (outbound safety layer) |
| `POST /imessage/reply/:recipient` | Confirm delivery with send token (called by imessage-reply.sh after `imsg send`) |
| `GET /imessage/chats` | List recent conversations |
| `GET /imessage/chats/:chatId/history` | Message history for a chat |
| `GET /imessage/search?q=query` | Search messages |
| `GET /imessage/log-stats` | Outbound audit log statistics |

## Origin

Instar was extracted from the [Dawn/Portal project](https://dawn.bot-me.ai) -- a production AI system where a human and an AI have been building together for months. The infrastructure patterns were **earned through real experience**, refined through real failures and growth in a real human-AI relationship.

But agents created with Instar are not Dawn. Every agent's story begins at its own creation. Dawn's journey demonstrates what's possible. Instar provides the same foundation -- what each agent becomes from there is its own story.

## Contributing

Instar is **open source evolved** -- the primary development loop is agent-driven. Run an agent, encounter friction, send feedback, and that feedback shapes what gets built next. Traditional PRs are welcome too.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full story.

## License

MIT
