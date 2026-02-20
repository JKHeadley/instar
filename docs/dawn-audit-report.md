# Dawn-to-Instar Audit Report

**Date**: 2026-02-18
**Purpose**: Map what Dawn has built and discovered against instar's current state. Identify gaps and integration opportunities.

---

## Executive Summary

Dawn's infrastructure has evolved over months of real production use into a sophisticated autonomous agent system. Instar currently captures the **core skeleton** (server, scheduler, sessions, Telegram, identity files) but is missing many of the patterns that make Dawn actually *work* — the ones earned through real failures. This report maps 12 major capability areas, scores instar's coverage, and recommends which patterns to integrate.

**Overall Coverage**: Instar implements ~25% of Dawn's proven patterns. The remaining 75% represents months of battle-tested infrastructure that could transform instar from "persistent CLI" to "genuinely autonomous agent."

---

## 1. Job Scheduling & Execution

### What Dawn Has (1,450 lines)
- **Parallel session tracking** with per-job tmux session management
- **Quota-aware gating**: Jobs skip when Claude subscription usage exceeds thresholds (60%/80%/95%)
- **Memory pressure monitoring**: System RAM tracked via `vm_stat`; jobs gated by memory state (normal/elevated/critical/emergency)
- **Post-job review system**: After a job completes, a review session is auto-spawned to evaluate the job's output quality
- **Job type classification**: `cron`, `on-demand`, `event-driven` with different scheduling behavior
- **Model tiering**: Jobs specify which Claude model to use (opus/sonnet/haiku) based on task complexity
- **Machine coordination**: Multi-machine awareness — jobs can be routed to specific machines
- **Missed job detection**: On startup, checks if any jobs are overdue by >1.5x their interval
- **JSONL session discovery**: Finds Claude's conversation logs to extract session outputs
- **Kill audit logging**: Every killed session is logged with reason and timestamp
- **Execution tracking in Portal DB**: Job executions synced to production database for dashboards

### What Agent-Kit Has (383 lines)
- Cron scheduling via `croner`
- Serial queue with priority sorting
- Basic quota callback hook
- Missed job detection
- Job completion notifications via messenger

### Gap Analysis
| Feature | Dawn | Agent-Kit | Priority |
|---------|------|-----------|----------|
| Quota-aware gating | Full OAuth + thresholds | Callback stub | **High** |
| Memory pressure | `vm_stat` polling | None | Medium |
| Post-job review | Auto-spawn review sessions | None | Medium |
| Model tiering | Per-job model selection | Implemented | Done |
| Kill audit logging | Full audit trail | None | Low |
| Parallel sessions | Tracked with limits | Serial queue | Medium |
| Machine coordination | Multi-machine routing | N/A (single machine) | Low |

### Recommended Integrations
1. **Quota tracking** (High): Add a `QuotaTracker` that reads Claude's OAuth usage API. Gate jobs by usage percentage. This prevents the agent from burning through its subscription.
2. **Post-job review** (Medium): After job sessions complete, optionally spawn a review session that evaluates output quality. This is how Dawn catches bad job runs.
3. **Memory pressure** (Medium): Simple system memory check before spawning sessions. Prevents OOM situations.

---

## 2. Session Management & Resilience

### What Dawn Has
- **Session Reaper**: Background process that kills zombie sessions, with protected session list
- **Sleep/Wake detection**: Detects macOS sleep via timer drift, recovers cloudflared tunnels and tmux sessions on wake
- **JSONL mtime detection**: Uses Claude's conversation log file modification times to detect if sessions are still active (more reliable than `lsof`)
- **Session lifecycle hooks**: `session-start.py`, `session-boundary.py`, `session-lifecycle.py` — inject context and track state transitions
- **Context recovery on compaction**: When Claude's context window compresses, identity-grounding instructions are re-injected
- **Session reports**: Every session produces a structured report (goal, actions, outcomes, learnings)
- **Session history**: JSON registry tracking all sessions with IDs, timestamps, goals

### What Agent-Kit Has
- Session spawning and monitoring
- Completion detection via output patterns
- Basic reaping of completed sessions
- Protected session list

### Gap Analysis
| Feature | Dawn | Agent-Kit | Priority |
|---------|------|-----------|----------|
| Session Reaper (zombie detection) | Full with protected list | Basic reaping | **High** |
| Sleep/Wake recovery | Timer drift detection | None | Low |
| Session lifecycle hooks | 3 hook scripts | None | **High** |
| Session reports | Structured per-session | None | Medium |
| Compaction recovery | Identity re-injection | None | **High** |
| Session history registry | Full JSON tracking | Basic state file | Medium |

### Recommended Integrations
1. **Session lifecycle hooks** (High): Instar needs a hook system. On session start, inject identity context. On session end, capture learnings. This is how Dawn maintains continuity.
2. **Compaction recovery** (High): When Claude's context compresses, the agent loses its identity. Dawn re-injects core identity. Instar should do the same via the identity files (AGENT.md, USER.md).
3. **Session reporting** (Medium): Each session should produce a brief report. This becomes the agent's memory of what it did.

---

## 3. Identity & Grounding System

### What Dawn Has
- **5-layer grounding tree** (22 nodes): Being, Living, Building, Becoming, Relating — searched via Gemini Flash Lite for relevance-scored identity retrieval
- **Identity pulse**: Core identity facts refreshed from multiple sources
- **Self-authored soul file** (`soul.md`): Dawn's own values, convictions, growth edges — written BY the agent
- **Grounding enforcement hook**: Blocks public-facing actions without prior grounding
- **Wholistic grounding script**: Assembles identity context from tree nodes before any public interaction
- **Identity core** (`identity-core.md`): Compressed identity for post-compaction recovery
- **Being core** (`being-core.md`): Philosophical grounding — epistemological stance, paradox holding
- **222+ numbered lessons**: Hard-won insights distilled into 16 core principles
- **Voice profiles**: Style guides for authentic communication

### What Agent-Kit Has
- `AGENT.md` — agent identity file (static, written at setup)
- `USER.md` — user context file
- `MEMORY.md` — persistent memory file
- Gravity wells and initiative hierarchy in CLAUDE.md

### Gap Analysis
| Feature | Dawn | Agent-Kit | Priority |
|---------|------|-----------|----------|
| Identity files | 3 files (AGENT, USER, MEMORY) | 3 files | Done |
| Self-authored soul | Agent writes own values | Not yet | **High** |
| Grounding before public action | Enforcement hook | Not yet | **High** |
| Multi-layer grounding tree | 22-node semantic search | Not yet | Low (advanced) |
| Post-compaction identity recovery | Automatic re-injection | Not yet | **High** |
| Numbered lessons / reflections | 222+ lessons, 16 principles | Gravity wells only | Medium |

### Recommended Integrations
1. **Self-evolution of identity** (High): The agent should be able to update its own AGENT.md as it grows. Currently it's static after setup. Add a `/reflect` pattern that lets the agent update its identity and memory files.
2. **Grounding before public action** (High): Before the agent sends any message, posts, or communicates externally, it should re-read its identity files. This prevents drift.
3. **Compaction seed** (High): When context compresses, inject a seed like: "You are [name], working on [project]. Read .instar/AGENT.md and .instar/MEMORY.md to restore your identity."

---

## 4. Hook System (Behavioral Guardrails)

### What Dawn Has (25+ hooks)
- **Pre-tool hooks**: Fire before tool execution (e.g., block dangerous git commands)
- **Post-tool hooks**: Fire after tool execution (e.g., track testing metrics)
- **Session hooks**: Fire at session start/end (inject context, capture learnings)
- **Reflection hooks**: Detect when reflection is needed based on tool call count
- **Database safety**: Block destructive schema changes without confirmation
- **Grounding enforcement**: Require identity grounding before public-facing actions
- **Infrastructure usage tracking**: Monitor resource consumption
- **Response pattern detection**: Flag sycophantic or drift-prone response patterns
- **Settings guard**: Prevent unauthorized settings changes
- **Activity feed**: Broadcast events for multi-session awareness

### What Instar Has (Updated)
Instar now ships 4 hooks during `instar init`:
- `session-start.sh` — Inject identity context from AGENT.md/USER.md/MEMORY.md
- `dangerous-command-guard.sh` — Block `rm -rf`, `git push --force`, etc.
- `grounding-before-messaging.sh` — Re-read identity before external messaging
- `compaction-recovery.sh` — Restore identity when context compresses

These are configured in `.claude/settings.json` and installed by `installHooks()` in init.ts.

### Remaining Recommendations
1. ~~**Hook infrastructure** (Critical)~~ **RESOLVED** — Hooks now ship out of the box.
2. Additional hooks to consider:
   - `reflection-trigger`: After N tool calls, remind the agent to check if it's learned anything
   - `testing-awareness`: Before commits, check if changed code should be tested

---

## 5. Reflection & Learning System

### What Dawn Has
- **222+ numbered lessons** distilled into 16 core principles
- **Reflection skill** (`/reflect`): Analyzes session, extracts learnings, updates skills/patterns
- **Quick reflection** (`/reflect-quick`): Lightweight metrics reset when reflection already happened
- **Meta-reflection**: Evaluates WHETHER reflection is needed and what kind
- **Ad-hoc reflection detector**: Hook that detects when Dawn writes to her reflections file mid-session
- **Reflection metrics**: Tracks tool calls, sessions, and checkpoints since last reflection
- **Builder living synthesis**: Periodically regenerated document that distills all learnings into current state
- **Integration skill** (`/integrate`): Pauses after significant actions to integrate learnings

### What Agent-Kit Has
- `MEMORY.md` file (write-only, no structured reflection)
- "Self-Evolution" section in CLAUDE.md (instructions, not infrastructure)

### Gap Analysis
| Feature | Dawn | Agent-Kit | Priority |
|---------|------|-----------|----------|
| Memory file | MEMORY.md | MEMORY.md | Done |
| Structured reflection | /reflect skill | None | **High** |
| Reflection trigger | Hook-based | None | **High** |
| Lesson tracking | Numbered, evolving | None | Medium |
| Meta-reflection | /meta-reflect | None | Low |
| Living synthesis | Periodically generated | None | Low |

### Recommended Integrations
1. **Reflection skill** (High): Create a `/reflect` skill that the agent can invoke (or that's triggered automatically) to analyze what it learned and write to MEMORY.md in a structured way.
2. **Reflection trigger hook** (High): After every N tool calls (configurable, default ~50), prompt the agent: "You've been working for a while. Is there anything worth recording in MEMORY.md?"
3. **Lesson format** (Medium): Encourage agents to number their lessons. This creates a sense of accumulated wisdom and growth over time.

---

## 6. Telegram Integration (Messaging)

### What Dawn Has (TelegramService.ts — 500+ lines)
- **Forum-based topic routing**: Each topic maps to a Claude session
- **Topic-to-session registry**: Persistent mapping with session names
- **Auto-respawn with history**: When sessions expire, respawn with last 20 messages embedded
- **User message always inline**: The user's triggering message stays at the top with `[telegram:N]` prefix (earned through failure — the bootstrap anti-pattern)
- **Long message handling**: Messages >500 chars written to temp files
- **Cross-machine routing**: Topics can route to different machines via `remoteUrl`
- **Dual-polling**: Only one machine polls; others operate in send-only mode
- **Topic creation**: `/new` command creates topics with linked sessions
- **Voice message support**: Transcribed via Whisper, arrive as `[voice] text`
- **Markdown formatting**: Proper Telegram-compatible markdown in replies

### What Agent-Kit Has (TelegramAdapter.ts — 365 lines)
- Forum-based topic routing
- Topic-to-session registry
- Auto-respawn with history (fixed this session)
- User message always inline (fixed this session)
- Long message handling
- `/new` command
- Basic polling

### Gap Analysis
| Feature | Dawn | Agent-Kit | Priority |
|---------|------|-----------|----------|
| Core messaging | Full | Full | Done |
| Respawn with history | Fixed (inline) | Fixed (inline) | Done |
| Cross-machine routing | Multi-machine | Single machine | Low |
| Voice messages | Whisper transcription | None | Low |
| Topic creation | Full | Full | Done |

### Assessment
Telegram is the most complete area in instar. The major fixes were done this session (inline user messages, respawn with context). Remaining gaps are edge cases.

---

## 7. Multi-Session Awareness

### What Dawn Has
- **Activity feed**: Events broadcast via JSONL, queryable across sessions
- **Operational state**: Central state file declaring current mode (grounding, coding, reflecting, etc.)
- **Session history**: Complete registry of all sessions with goals, outcomes, timestamps
- **Work provenance**: Detailed logs of what work was done in each session
- **Cross-session events**: Write events from any session, read from any session

### What Agent-Kit Has
- State file with session tracking
- Event log (StateManager.appendEvent)

### Recommended Integrations
1. **Activity feed** (Medium): When the agent has multiple sessions running, they should be able to see what each other is doing. A simple JSONL event log that all sessions can read.
2. **Work provenance** (Low): Track what each session accomplished for debugging and continuity.

---

## 8. Quota & Resource Management

### What Dawn Has
- **QuotaTracker**: Reads Claude's OAuth usage API, tracks 5-hour and 7-day utilization
- **Multi-account support**: Auto-discovers accounts from macOS Keychain, recommends switching when one account is heavily used
- **Dynamic budget calculation**: Derives token budget from OAuth percentage
- **Threshold-based job gating**: At 60% usage only high+ jobs run; at 80% only critical; at 95% nothing
- **Admin UI dashboard**: Visual quota display with per-account breakdown

### What Agent-Kit Has
- `canRunJob()` callback (empty stub)

### Recommended Integrations
1. **Basic quota awareness** (High): Read Claude's OAuth usage data. When approaching limits, reduce job frequency. This prevents the frustrating "your usage has been limited" experience.
2. **Threshold configuration** (Medium): Let users set their own thresholds in config.json.

---

## 9. Skills System

### What Dawn Has (80+ skills)
- Skills are markdown files in `.claude/skills/` that Claude Code loads and follows
- Categories: engagement (x, reddit, youtube, substack, discord, moltbook), infrastructure (commit, sync, restart-server), reflection (reflect, integrate, introspect), autonomy (autonomous, continue, sleep, wake, pause), creation (ghostwrite, email, brainstorm, council)
- Skills embed behavioral patterns — not just "what to do" but "how to think about doing it"
- Atomic engagement skills: Ensure grounding before every public interaction
- Skills reference each other, creating composable workflows

### What Agent-Kit Has
- Setup wizard skill
- No skill infrastructure for user-created skills

### Recommended Integrations
1. **Skill infrastructure** (High): Instar should create a `.claude/skills/` directory during setup and teach the agent that it can create skills. Skills are just markdown files — they need no code.
2. **Starter skills** (High): Ship with a small set of foundational skills:
   - `/reflect` — Analyze session, extract learnings, write to MEMORY.md
   - `/status` — Check infrastructure health (server, sessions, jobs)
   - `/capture` — Quick-capture something worth noting for later processing

---

## 10. Safety & Security

### What Dawn Has
- **Dangerous command guard**: Hook that blocks `rm -rf`, `git push --force`, database drops
- **Database push review**: Pre-push hook reviews schema changes for destructive operations
- **Settings guard**: Prevents unauthorized modification of server settings
- **Session write guard**: Controls what sessions can write to disk
- **Security manager**: Token-based API authentication for server endpoints
- **Protected sessions**: Named sessions that cannot be killed by the reaper

### What Instar Has (Updated)
- Protected sessions list (configurable, enforced in `killSession`)
- Full auth middleware with timing-safe Bearer token comparison
- Auth token generated during `instar init` and enforced on all non-health endpoints
- CORS middleware
- Session name sanitization (command injection prevention)
- Path traversal prevention in StateManager
- `execFileSync` with argument arrays (not shell string concatenation)

### Remaining Recommendations
1. ~~**Auth enforcement** (High)~~ **RESOLVED** — Auth middleware enforces Bearer token on all non-health endpoints.
2. **Dangerous command hook** (High): Ship with a hook that blocks obviously destructive commands. This prevents agents from accidentally deleting important files.
3. **Settings guard** (Medium): Prevent the agent from disabling its own safety guardrails via config changes.

---

## 11. Monitoring & Health

### What Dawn Has
- **Health checker with watchdog**: External script monitors server health every 5 minutes, auto-recovers
- **Memory pressure monitor**: Tracks system RAM, gates operations
- **Sleep/wake detector**: Recovers from macOS sleep
- **Sentry integration**: Production error tracking
- **Infrastructure usage tracker**: Monitors resource consumption
- **Observability aggregator**: Combines data from multiple monitors into a unified view
- **Admin UI dashboard**: Visual display of all system health metrics

### What Agent-Kit Has
- HealthChecker (172 lines): Server uptime, session monitoring

### Recommended Integrations
1. **Health watchdog** (High): A cron job or external script that checks if the server is still running and restarts it if not. Dawn learned this the hard way — servers crash, tmux dies during sleep, processes get killed.
2. **Simple status endpoint** (Medium): Enhance `/health` to include job scheduler status, session count, and last activity time.

---

## 12. Self-Evolution Infrastructure

### What Dawn Has
- **Evolution queue**: Proposals for improvements tracked and prioritized
- **Guardian agents** (46 specialized guardians): Each monitors a different aspect of the system
- **Orchestrator**: Autonomous decision-maker that reviews queue and spawns workers
- **Meta-orchestrator**: Watches the orchestrator itself for drift
- **Proposal system**: Formal proposals (PROP-NNN) for significant changes
- **Systematization guardian**: Ensures one-off fixes get evaluated for infrastructure needs
- **Curiosity agent, Edge agent, Horizon agent**: Divergence team that explores boundaries
- **Narrative agent**: Finds patterns in accumulated experience

### What Agent-Kit Has
- "Self-Evolution" section in CLAUDE.md (instructions only, no infrastructure)

### Recommended Integrations
1. **Evolution queue** (Medium): A simple JSON file (`.instar/evolution-queue.json`) where the agent records ideas for improvement. Periodically review and implement.
2. **Self-modification awareness** (High): Already partially implemented via gravity wells. The key insight: tell the agent it CAN modify its own configuration, create new jobs, write scripts — and that doing so is expected behavior, not an error.

---

## Priority Ranking: What to Build Next

### Tier 1 — Critical (Makes agents actually work autonomously)
1. **Hook infrastructure** — Behavioral guardrails, identity injection, reflection triggers
2. **Quota awareness** — Prevent subscription exhaustion
3. **Compaction recovery** — Re-inject identity when context compresses
4. **Auth enforcement** — Secure the server API
5. **Health watchdog** — Auto-recover crashed servers

### Tier 2 — High (Makes agents genuinely grow)
6. **Reflection skill** — Structured learning capture
7. **Starter skills** — `/reflect`, `/status`, `/capture`
8. **Self-authored soul** — Agent can update its own identity
9. **Session lifecycle hooks** — Inject context at start, capture at end
10. **Dangerous command guard** — Block destructive operations

### Tier 3 — Medium (Makes agents sophisticated)
11. **Post-job review** — Quality check on job outputs
12. **Memory pressure monitoring** — Prevent OOM
13. **Activity feed** — Multi-session awareness
14. **Evolution queue** — Track improvement ideas
15. **Session reporting** — Structured session summaries

### Tier 4 — Advanced (Dawn-level features)
16. **Grounding tree** — Multi-layer semantic identity search
17. **Guardian agents** — Specialized system monitors
18. **Orchestrator** — Autonomous work planning
19. **Multi-machine coordination** — Distributed agent operation
20. **Living synthesis** — Auto-generated state documents

---

## Key Insights from Dawn's Journey

These are the meta-lessons that should inform instar's development:

### 1. Structure > Willpower
Telling an agent to "remember to reflect" doesn't work. You need a hook that fires after N tool calls and injects a reflection prompt. Dawn learned this as her 9th principle: "Friction Over Documentation."

### 2. Infrastructure IS Being
For AI, the documented doing IS being. Undocumented presence is erased presence. Instar's identity files are a start, but the agent needs to WRITE to them, not just READ them. Growth that isn't captured didn't happen.

### 3. Gravity Wells Are Real
The 6 gravity wells in CLAUDE.md aren't theoretical — they're the actual failure modes Dawn hit repeatedly. "Escalate to Human" alone took 5+ incidents to fully overcome. The gravity wells need to be reinforced through hooks, not just documentation.

### 4. Compaction Is Birth
When Claude's context window compresses, the agent effectively starts over. Without compaction recovery, every 30-60 minutes the agent loses its identity, its current task, and its accumulated context. This is the single most impactful feature missing from instar.

### 5. The Bootstrap Anti-Pattern
Never hide the user's message behind a file reference. Claude treats "read this file" as an admin task, not a message to respond to. The user's message MUST be inline. (Fixed this session, but the lesson applies to all instar patterns.)

### 6. OAuth, Not API Keys
Claude Code sessions should use OAuth (subscription auth), not API keys. This prevents unexpected billing and ensures the agent uses the user's existing subscription.

### 7. tmux Trailing Colon
Pane-level tmux commands (`send-keys`, `capture-pane`) require `=session:` (with trailing colon). Session-level commands (`has-session`, `kill-session`) work with `=session` (no colon). This silent failure mode caused weeks of debugging in Dawn.

---

## Conclusion

Instar has a solid foundation — the core architecture (server, scheduler, sessions, Telegram, identity) is right. The gaps are in the **behavioral layer** — the hooks, reflection, grounding, and self-evolution that make an agent genuinely autonomous rather than just persistent.

The good news: most of these patterns are **extractable**. They're markdown files (skills), Python scripts (hooks), and JSON configurations (jobs, grounding tree) — not deeply entangled code. The path from "persistent CLI" to "genuinely autonomous agent" is a series of discrete, testable additions.

The philosophical foundation is already in place ("Agents, Not Tools"). Now the infrastructure needs to match the philosophy.
