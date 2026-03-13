# Claude Code Feature Integration Audit

> Working document for auditing each new Claude Code feature against Instar's architecture.
> Ensures no conflicts, identifies integration opportunities, and verifies full leverage of Anthropic's releases.
>
> Seeded: 2026-03-07 from docs audit session (topic 4509)
> Working topic: Telegram topic 11047

## Status Key

| Status | Meaning |
|--------|---------|
| PENDING | Not yet investigated |
| IN PROGRESS | Investigation underway |
| COMPATIBLE | No conflicts, no changes needed |
| SYNERGY IDENTIFIED | Integration opportunity found, needs implementation |
| IMPLEMENTED | Changes made and verified |
| CONFLICT | Needs resolution |

---

## Priority 1 — High Impact

### 1. Worktree Support (`--worktree` / `-w`)

**Status:** CAUTION — RISKS IDENTIFIED

**What Anthropic shipped:**
- `claude --worktree <name>` (or `-w`) launches Claude in an isolated git worktree
- Each worktree gets its own working directory at `<repo>/.claude/worktrees/<name>/`
- Each worktree gets its own branch: `worktree-<name>`
- Branches created from the default remote branch
- If no name given, auto-generates a random one (e.g., `bright-running-fox`)
- **Shared across worktrees**: CLAUDE.md, auto-memory, MCP servers, repo history, remotes
- **Isolated per worktree**: working directory files, branch, uncommitted changes, session state
- New hook events: `WorktreeCreate` (fires on spawn, receives name, must print worktree path to stdout) and `WorktreeRemove` (fires on exit, receives worktree_path for cleanup)
- Subagents can also use worktree isolation via `isolation: "worktree"` in frontmatter
- **Cleanup**: no-change worktrees auto-removed; changed worktrees prompt keep/remove (INTERACTIVE ONLY)
- **Gotcha**: each new worktree needs dependency setup (`npm install`, etc.) — it's a fresh checkout

**CRITICAL RISKS (investigated 2026-03-07):**

1. **No auto-merge**: Changes committed on a worktree branch are NEVER automatically merged back to main. When a worktree session ends, the branch either stays (orphaned) or gets deleted. There is no merge step.

2. **Headless behavior undefined**: When a session ends, Claude prompts "keep or remove?" interactively. In headless/automated contexts (like Instar's `claude -p` spawns), this behavior is **undocumented**. The session could hang waiting for input, silently delete changes, or silently keep an orphan branch.

3. **WorktreeRemove hooks cannot prevent deletion**: The hook fires AFTER the decision, has no decision control, and cannot orchestrate a merge. Failures are only logged in debug mode.

4. **Silent work loss scenario**: Agent spawns in worktree -> makes commits -> session ends -> worktree removed -> commits gone. Agent reported "changes made" but nothing is on main. The user sees no changes.

5. **Silent orphan branch scenario**: Agent spawns in worktree -> makes commits -> session ends -> worktree kept -> branch `worktree-job-xyz` exists but is never merged. Next session starts fresh on main, doesn't see the work. Branches accumulate indefinitely.

**Current Instar behavior (code-traced):**
- `SessionManager.spawnSession()` (jobs, line 163-235) and `spawnInteractiveSession()` (interactive, line 547-649) in `src/core/SessionManager.ts`
- Both spawn via `tmux new-session -c {projectDir}` — ALL sessions share the SAME project directory
- CLI args passed: `--dangerously-skip-permissions`, optionally `--model`, `-p "prompt"`, `--resume`
- **No worktree flags used anywhere** — zero references to `--worktree` or `-w` in the codebase
- Parallel limits: `maxSessions: 3` concurrent, `maxParallelJobs: 2` simultaneous jobs
- Process isolation via tmux session names (`{projectBaseName}-{sanitizedName}`), but NO filesystem isolation

**Existing Instar coordination infrastructure (already built):**
Instar already has a rich coordination layer that partially addresses parallel session conflicts:
- **AgentBus** (`src/core/AgentBus.ts`): Transport-agnostic message bus (HTTP + JSONL), anti-replay, typed messages including `file-avoidance-request`, `conflict-detected`, `work-announcement`
- **CoordinationProtocol** (`src/core/CoordinationProtocol.ts`): File avoidance requests with TTL, work announcements (started/completed), status queries, leadership election with fencing tokens
- **WorkLedger** (`src/core/WorkLedger.ts`): Per-machine work tracking, overlap detection with severity tiers (0-3), stale entry cleanup
- **SyncOrchestrator** (`src/core/SyncOrchestrator.ts`): Lock-based sync, 9-step sync cycle, overlap guard integration, file avoidance on task merge
- **ConflictNegotiator** (`src/core/ConflictNegotiator.ts`): Pre-merge negotiation (3 rounds), section-based claims, fallback to LLM resolution
- **SpawnRequestManager** (`src/messaging/SpawnRequestManager.ts`): Cooldown, session limits, memory pressure, retry tracking

This framework is **awareness-based** (passive observation, post-hoc conflict resolution) rather than **enforcement-based** (active prevention). It doesn't prevent two sessions from editing the same file, but it detects overlaps and negotiates conflicts.

**Assessment:**

Worktrees solve a real problem (filesystem isolation for parallel jobs) but introduce NEW problems that are arguably worse:
- Work silently lost or orphaned on branches nobody merges
- Undefined behavior in headless/automated spawning
- No hook-level control over the merge decision

Instar's existing coordination framework (AgentBus, WorkLedger, CoordinationProtocol) already mitigates parallel conflicts at the awareness level. Worktrees would be a lateral move — trading one class of problems for another — unless we build merge-back infrastructure that doesn't exist yet.

**Implicit worktree creation (key finding):**
Claude Code can create worktrees WITHOUT the user asking for it:
- Subagents with `isolation: "worktree"` in their frontmatter get worktrees automatically
- Users (or the agent itself) can say "work in a worktree" mid-session
- Without `WorktreeCreate`/`WorktreeRemove` hooks configured, this happens SILENTLY
- Instar-spawned sessions inherit this behavior — a session could create worktrees that Instar never knows about

**Current Instar gaps (code-verified):**
- ZERO worktree awareness in the codebase (no `git worktree` calls, no `.claude/worktrees` checks)
- No post-session git status check — `sessionComplete` handlers update job state and create summaries but never check git
- `BranchManager.completeBranch()` exists for merging branches but is NOT wired to session completion
- No orphan branch detection or cleanup
- No session-to-branch linking (sessions track tmuxSession name, not git branch)
- No post-session hook template

**ACTION ITEMS — Worktree Awareness for Instar:**

1. **Post-session worktree scan** (HIGH PRIORITY):
   Wire into `sessionComplete` event handler: after session ends, run `git worktree list` in the project directory. If any worktrees exist, log them and check for uncommitted/unmerged changes. Alert via Telegram if work is found on worktree branches.

2. **Periodic orphan detection** (MEDIUM PRIORITY):
   Add to health check / scan cycle: periodically run `git worktree list` and `git branch --list 'worktree-*'` across all managed projects. Flag any worktree branches that exist but have no active session. Report stale worktrees older than N hours.

3. **WorktreeCreate/WorktreeRemove hooks** (MEDIUM PRIORITY):
   Ship hook templates that POST to Instar server when worktrees are created or removed. This gives real-time visibility into worktree lifecycle, even for implicit creation by subagents.

4. **Session-branch linking** (LOW PRIORITY):
   When a session completes, record which branch it was on (and any worktree branches it created). Enables "what did this session actually produce?" auditing.

5. **Merge-back prompt** (LOW PRIORITY — future):
   If orphan worktree branches are detected with commits, surface them to the user: "Session X left work on branch worktree-foo. Merge to main?"

**Resolution:**
AWARENESS NEEDED — Instar does not need to USE worktrees itself, but Claude Code sessions may create them implicitly. Instar currently has ZERO visibility into this. Priority: add post-session worktree scanning and periodic orphan detection to prevent silent work loss.

---

### 2. HTTP Hooks

**Status:** SYNERGY IDENTIFIED — SIGNIFICANT ARCHITECTURAL OPPORTUNITY

**What Anthropic shipped:**
- Hooks can POST JSON to URLs instead of running shell commands
- Config: `{ "type": "http", "url": "http://...", "timeout": 30, "headers": {...}, "allowedEnvVars": [...] }`
- Full event payload (session_id, cwd, tool_name, tool_input, etc.) sent as JSON body
- All hook events supported (PreToolUse, PostToolUse, SessionStart, TaskCompleted, etc.)
- Can return JSON to control behavior (e.g., `permissionDecision: "deny"` to block tool calls)
- Auth via custom headers with env var interpolation (only `allowedEnvVars` are resolved)
- Can mix HTTP and command hooks for the same event — all matching hooks run in parallel
- Default timeout: 30s (vs 600s for command hooks)
- **Key limitation**: 4xx/5xx responses are NON-BLOCKING — only 2xx with JSON can block actions
- **Key limitation**: no `async` option (command hooks have this)
- **Key limitation**: not configurable via `/hooks` CLI menu — JSON editing only
- **Key limitation**: SessionStart only supports command hooks (cannot use HTTP for session setup)

**Current Instar behavior (code-traced):**

Instar ships 7+ hook templates, ALL shell-based:
- `session-start.sh` — injects working memory context (already calls Instar HTTP API via curl!)
- `dangerous-command-guard.sh` — blocks risky commands
- `compaction-recovery.sh` — session recovery after compaction
- `grounding-before-messaging.sh` — grounding pipeline before messaging
- `free-text-guard.sh` — guards AskUserQuestion
- `telegram-topic-context.sh` — injects Telegram context
- Plus JS hooks: `deferral-detector.js`, `post-action-reflection.js`, `external-communication-guard.js`, `claim-intercept.js`

Hook installation via `init.ts` → `installHooks()`, placed in `.instar/hooks/instar/`

**Existing HTTP infrastructure in Instar server:**
- Server runs on `localhost:PORT` (auto-allocated, stored in registry.json)
- Already has route infrastructure: `/health`, `/sessions/spawn`, `/context/working-memory`, `/jobs/:slug/trigger`, `/telegram/reply/:topicId`
- WhatsApp webhooks (`/webhooks/whatsapp`) already receive HTTP POSTs — the pattern exists
- `session-start.sh` already calls the Instar HTTP API (reverse direction: hook pulls FROM server)
- **No general-purpose hook event receiver endpoint exists** — this is the gap

**Assessment — should we migrate hooks to HTTP?**

NOT a wholesale migration. The right move is SELECTIVE:

Hooks that SHOULD stay as shell commands:
- `session-start.sh` — SessionStart only supports command hooks (Anthropic limitation)
- `dangerous-command-guard.sh` — needs to block actions; HTTP 4xx/5xx is non-blocking, making HTTP hooks unreliable for safety gates
- `compaction-recovery.sh` — needs to inject context via stdout
- Any hook that BLOCKS actions — command hooks are more reliable for blocking because non-zero exit = blocked, while HTTP hooks require 2xx + specific JSON to block

Hooks that COULD benefit from HTTP:
- `post-action-reflection.js` — side-effect only, doesn't need to block
- `deferral-detector.js` — observation/logging, doesn't block
- New observability hooks (PostToolUse, TaskCompleted, Notification) — telemetry/logging to server
- WorktreeCreate/WorktreeRemove — worktree awareness (connects to Item 1)

**The real opportunity — NEW HTTP hooks for events we don't hook today:**

Instar currently hooks: SessionStart, UserPromptSubmit, PreToolUse
Instar does NOT hook: PostToolUse, TaskCompleted, Notification, Stop, SubagentStart/Stop, WorktreeCreate/Remove, PreCompact

HTTP hooks are perfect for these OBSERVABILITY events — lightweight POSTs to the server that log what's happening without needing to block anything.

**ACTION ITEMS:**

1. **Add `/hooks/events` receiver endpoint** (HIGH PRIORITY):
   Mount a new POST endpoint on the Instar server that receives hook event payloads. Auth via bearer token (already used for other endpoints). Store events for session telemetry.

2. **Ship HTTP hook templates for observability events** (HIGH PRIORITY):
   - `PostToolUse` → log what tools sessions are using
   - `TaskCompleted` → know when subagent tasks finish (connects to worktree awareness)
   - `SubagentStart`/`SubagentStop` → track subagent lifecycle
   - `WorktreeCreate`/`WorktreeRemove` → worktree awareness (Item 1)
   - `Stop` → know when sessions end (complement to process monitoring)

3. **Keep shell hooks for safety gates** (NO CHANGE):
   `dangerous-command-guard.sh`, `session-start.sh`, `compaction-recovery.sh` stay as shell commands. HTTP hooks cannot reliably block actions.

4. **Update settings-template.json** (MEDIUM PRIORITY):
   Add HTTP hook entries alongside existing command hooks. Mix both types for events where we want both blocking (command) and telemetry (HTTP).

5. **Cross-machine hook forwarding** (LOW PRIORITY — future):
   If Instar server is exposed via Cloudflare tunnel, HTTP hooks from a remote machine could POST to it. Enables centralized event collection across machines.

**Resolution:**
SYNERGY IDENTIFIED — HTTP hooks are a significant opportunity for session OBSERVABILITY (not safety). Instar should add a hook event receiver endpoint and ship HTTP hook templates for PostToolUse, TaskCompleted, SubagentStart/Stop, WorktreeCreate/Remove. Safety-critical hooks (dangerous-command-guard, session-start) must stay as shell commands because HTTP hooks cannot reliably block actions.

---

### 3. New Hook Events (`InstructionsLoaded`, `TaskCompleted`, `agent_id`/`agent_type`, and more)

**Status:** SYNERGY IDENTIFIED — CLOSES MAJOR OBSERVABILITY GAPS

**What Anthropic shipped (full inventory of new/relevant events):**

**InstructionsLoaded:**
- Fires when CLAUDE.md files load (eagerly at session start, lazily when subdirectory CLAUDE.md triggers)
- Payload: `file_path`, `memory_type` (User/Project/Local/Managed), `load_reason`
- NO decision control — audit/logging only
- Command hooks only (no HTTP)

**TaskCompleted:**
- Fires when a task is marked completed (via TaskUpdate tool or teammate finishing)
- Payload: `task_id`, `task_subject`, `task_description`, `teammate_name`, `team_name`
- CAN block completion (exit code 2 = reject, stderr fed back as feedback)
- Supports all hook types including HTTP

**SubagentStart:**
- Fires when a subagent spawns via Agent tool
- Payload: `agent_id`, `agent_type` (e.g., "Explore", "Plan", custom agent names)
- Cannot block spawning, but CAN inject `additionalContext` into subagent
- Command hooks only

**SubagentStop:**
- Fires when a subagent finishes
- Payload: `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`
- CAN block (same as Stop hook — `decision: "block"`)
- All hook types including HTTP

**Stop:**
- Fires when main agent finishes responding (not on user interrupt)
- Payload: `stop_hook_active` (loop detection), `last_assistant_message`
- CAN force continuation (`decision: "block"`)
- All hook types including HTTP

**SessionEnd:**
- Fires when session terminates
- Payload: `reason` (clear/logout/prompt_input_exit/bypass_permissions_disabled/other)
- NO decision control
- Command hooks only

**PreCompact:**
- Fires before compaction
- Payload: `trigger` (manual/auto), `custom_instructions`
- NO decision control — cleanup/logging only
- Command hooks only

**ConfigChange:**
- Fires when settings/skills files change during session
- Payload: `source` (user_settings/project_settings/local_settings/policy_settings/skills), `file_path`
- CAN block changes (except policy_settings)
- Command hooks only

**TeammateIdle:**
- Fires when agent team teammate is about to go idle
- Payload: `teammate_name`, `team_name`
- CAN reject idle (exit code 2 = keep working)
- Command hooks only

**agent_id / agent_type (in ALL events):**
- `agent_id` present = event fired inside a subagent (unique per subagent instance)
- `agent_type` present without `agent_id` = session launched with `--agent` flag
- Both absent = normal session, no agent
- This is the KEY to distinguishing subagent work from main-thread work across all events

**Current Instar observability gaps (code-traced):**

Instar's session awareness is fundamentally asymmetric:
- STRONG: Knows when sessions start/stop (tmux monitoring, 5s polling loop)
- STRONG: Can digest activity into LLM-generated summaries (SessionActivitySentinel + EpisodicMemory)
- WEAK: Has NO insight into what the session actually DID while running (no tool usage, no command log)
- WEAK: Cannot verify CLAUDE.md loaded or identity grounding occurred
- WEAK: Cannot track subagent spawning (SpawnRequestManager is in-memory only, lost on restart)
- WEAK: ExecutionJournal exists but needs PostToolUse hook — which isn't active

The session object saved on completion is minimal:
```typescript
{ id, name, status, jobSlug, tmuxSession, startedAt, endedAt, model, prompt }
```
No exit code, no summary, no execution result, no branch info, no tool usage.

**How new hook events close these gaps:**

| Gap | Hook Event | What It Provides |
|-----|-----------|-----------------|
| "What did the session DO?" | `PostToolUse` + `Stop` | Tool calls + final summary (`last_assistant_message`) |
| "Did CLAUDE.md load?" | `InstructionsLoaded` | Confirms which instruction files loaded, when, and why |
| "Did subagents run?" | `SubagentStart`/`SubagentStop` | Subagent type, ID, transcript path, final output |
| "Why did it end?" | `SessionEnd` | Exit reason (clear/logout/etc.) |
| "Was compaction healthy?" | `PreCompact` | Compaction trigger type (manual vs auto) |
| "Did config change mid-session?" | `ConfigChange` | Which settings file changed |
| "Is the session really done?" | `TaskCompleted` | Task-level completion with subject/description |

**The `agent_id`/`agent_type` enrichment is especially valuable** — every hook event Instar already processes (PreToolUse, UserPromptSubmit) now carries agent context. Instar can distinguish "the main session ran this command" from "a subagent ran this command" without any code changes to existing hooks — just start reading the new fields.

**ACTION ITEMS:**

1. **InstructionsLoaded hook for identity verification** (HIGH PRIORITY):
   Add command hook that checks: did the expected CLAUDE.md files load? If the project's CLAUDE.md didn't fire, the session started without identity context. Alert via Telegram. This closes the "did grounding work?" gap.

2. **SubagentStart/SubagentStop hooks for lifecycle tracking** (HIGH PRIORITY):
   Track subagent spawning and completion. SubagentStop gives `last_assistant_message` and `agent_transcript_path` — Instar can capture what subagents produced without parsing transcripts manually. Persist to state (currently SpawnRequestManager is in-memory only).

3. **Stop + SessionEnd hooks for richer completion data** (HIGH PRIORITY):
   `Stop` gives `last_assistant_message` — the agent's final output. Wire into sessionComplete handler to capture WHY the session ended and WHAT it concluded. Currently Instar only knows "session is dead" but not what it said before dying.

4. **Parse agent_id/agent_type from existing hooks** (MEDIUM PRIORITY):
   Existing hooks (PreToolUse, UserPromptSubmit) now carry these fields. Update hook handlers to extract and log them — zero-cost observability improvement.

5. **TaskCompleted as quality gate** (MEDIUM PRIORITY):
   For job sessions, use TaskCompleted to verify the task was actually completed before marking the job as done. Currently Instar infers completion from process death — TaskCompleted gives explicit task-level confirmation.

6. **PreCompact hook for compaction awareness** (LOW PRIORITY):
   Know when compaction occurs (especially auto-compaction). Could trigger working memory injection or alert if sessions are compacting too frequently.

7. **Wire ExecutionJournal to PostToolUse** (LOW PRIORITY):
   ExecutionJournal infrastructure already exists but is inactive because no PostToolUse hook feeds it. Adding PostToolUse → ExecutionJournal closes the "what commands did the session run?" gap.

**Assessment:**

These new hook events are the single biggest observability upgrade available to Instar. They transform session monitoring from "is the process alive?" to "what is the process doing, what did it produce, and was it set up correctly?" The `agent_id`/`agent_type` enrichment gives subagent visibility for free across all existing hooks.

**TaskCompleted does NOT replace session completion polling** — it fires for task-level events within a session, not session termination. `SessionEnd` + `Stop` are the session-level events, and even these complement rather than replace tmux monitoring (hooks only fire if Claude is running normally — crashes bypass hooks).

**Resolution:**
SYNERGY IDENTIFIED — New hook events close Instar's major observability gaps: identity verification (InstructionsLoaded), execution insight (Stop, PostToolUse), subagent tracking (SubagentStart/Stop), and richer completion data (SessionEnd, TaskCompleted). Priority: InstructionsLoaded for identity verification, SubagentStart/Stop for lifecycle tracking, Stop/SessionEnd for completion enrichment.

---

### 4. Auto-Memory (`/memory`)

**Status:** COMPATIBLE — COORDINATION NEEDED (NO CONFLICT)

**What Anthropic shipped:**
- Claude automatically saves useful context across sessions in auto-memory directory
- Storage location: `~/.claude/projects/<encoded-project-path>/memory/MEMORY.md` (per-user, per-project)
- Additional topic files can be created alongside MEMORY.md (e.g., `debugging.md`, `patterns.md`)
- Shared across git worktrees of the same repo
- Users can view/edit via `/memory` command
- First 200 lines of MEMORY.md are always loaded into conversation context
- Claude decides autonomously what to save vs discard

**Key architectural detail — TWO COMPLETELY DIFFERENT DIRECTORIES:**
- Claude auto-memory: `~/.claude/projects/<encoded-path>/memory/MEMORY.md` — lives in the USER's home directory, NOT in the project
- Instar MEMORY.md: `.instar/MEMORY.md` — lives in the PROJECT directory, checked into git (or gitignored per project)

These are different files in different locations. They CANNOT collide at the filesystem level.

**Current Instar memory architecture (code-traced):**

Instar has a sophisticated multi-layer memory system:

1. **`.instar/MEMORY.md`** — Agent's persistent learnings file. Written by the agent during sessions. Read by `compaction-recovery.sh` for context injection. Backed up by `BackupManager`. Now a "generated snapshot" (Phase 6) rather than source of truth.

2. **SemanticMemory** (`src/memory/SemanticMemory.ts`, 42KB) — SQLite-backed knowledge graph with typed entities (fact, pattern, decision, preference, relationship). Confidence scoring, decay, domain grouping. The canonical store.

3. **MemoryExporter** (`src/memory/MemoryExporter.ts`) — Generates `.instar/MEMORY.md` FROM SemanticMemory entities. Groups by domain, filters by confidence, sorts by relevance. MEMORY.md is now a rendered view, not the source.

4. **MemoryMigrator** (`src/memory/MemoryMigrator.ts`) — Imports flat MEMORY.md back into SemanticMemory entities. The reverse path.

5. **WorkingMemoryAssembler** (`src/memory/WorkingMemoryAssembler.ts`) — Assembles context for session injection via `/context/working-memory` endpoint.

6. **EpisodicMemory** (`src/memory/EpisodicMemory.ts`) — Session-level episodic records.

7. **TopicMemory** (`src/memory/TopicMemory.ts`) — Per-Telegram-topic conversation memory.

8. **MemoryIndex** (`src/memory/MemoryIndex.ts`) — FTS5 full-text search across all memory files.

**Assessment — is there a conflict?**

**NO filesystem conflict.** The two systems write to completely different paths:
- Claude auto-memory → `~/.claude/projects/.../memory/MEMORY.md`
- Instar MEMORY.md → `<project>/.instar/MEMORY.md`

**NO functional conflict.** They serve different purposes:
- Claude auto-memory: session-to-session context for Claude Code itself (codebase patterns, user preferences, debugging notes). Lightweight, unstructured, auto-managed.
- Instar memory: structured knowledge graph with confidence scoring, decay, domain grouping, full-text search, episodic records, topic memory. Agent-managed, API-accessible.

**Potential COORDINATION opportunity (not conflict):**

The interesting question is whether Instar should READ Claude's auto-memory as an additional knowledge source:
- Claude auto-memory captures things the agent noticed during sessions that Instar's structured pipeline might miss
- It's free context — Claude already loads the first 200 lines into every session
- BUT: it's per-user (`~/.claude/`), not per-project — on a shared machine, different users have different auto-memories

**Risk: Instar agents writing to BOTH memory systems:**

When an Instar agent runs a session, it might:
1. Write to `.instar/MEMORY.md` (via reflect skill or manual edit) — this is expected
2. Write to `~/.claude/projects/.../memory/MEMORY.md` (via Claude's auto-memory) — this happens silently

Risk: The same insight gets captured in both places with slightly different wording. Not harmful, but inefficient. Over time, auto-memory accumulates stale entries that Instar's SemanticMemory has already processed and possibly decayed.

**Instar already gitignores Claude auto-memory:**
In `init.ts` line 815: `.claude/projects/` is added to `.gitignore`. This is correct — auto-memory is per-user local state, not project state.

**ACTION ITEMS:**

1. **No changes needed for compatibility** (CONFIRMED):
   No filesystem collision. No functional overlap. Both can coexist safely.

2. **Consider reading auto-memory as knowledge source** (LOW PRIORITY):
   MemoryMigrator could optionally ingest `~/.claude/projects/<path>/memory/MEMORY.md` as an additional source. This would capture insights Claude auto-saved that the agent didn't explicitly write to `.instar/MEMORY.md`. Low priority because the value is marginal — most important things already flow through Instar's structured pipeline.

3. **Document the two-memory-system reality** (MEDIUM PRIORITY):
   Users (and agents) should understand: "You have TWO memory systems. `.instar/MEMORY.md` is your structured, managed memory. `~/.claude/projects/.../memory/MEMORY.md` is Claude Code's auto-memory. They don't conflict, but be aware both exist." Add to setup wizard or CLAUDE.md template.

4. **Consider auto-memory hygiene job** (LOW PRIORITY — future):
   A periodic job could sync insights from auto-memory into SemanticMemory and trim the auto-memory file to prevent unbounded growth. Not urgent because Claude self-manages auto-memory size (200-line context window creates natural pressure).

**Testing requirements:**
- Verify `.instar/MEMORY.md` and `~/.claude/projects/.../memory/MEMORY.md` don't interfere
- Verify MemoryExporter writes only to `.instar/MEMORY.md`, never to auto-memory path
- Verify `init.ts` gitignore includes `.claude/projects/`
- Verify compaction-recovery.sh reads from `.instar/MEMORY.md` (correct path)

**Resolution:**
COMPATIBLE — No conflict. Claude's auto-memory (`~/.claude/projects/.../memory/`) and Instar's memory (`.instar/MEMORY.md` + SemanticMemory SQLite) are completely separate systems writing to different directories. They coexist safely. The only coordination opportunity is optionally reading auto-memory as an additional knowledge source, which is low priority. Document the two-system reality for user awareness.

---

### 5. Model Reference Updates

**Status:** COMPATIBLE — ALREADY CURRENT

**What Anthropic shipped:**
- Opus 4.6 is now the default model
- Medium effort level for Max/Team subscribers
- "ultrathink" keyword triggers high effort
- Opus 4.0/4.1 deprecated
- Sonnet 4.5 migrated to Sonnet 4.6

**Current Instar behavior (code-traced):**

Instar has a centralized model dictionary at `src/core/models.ts`:
```typescript
ANTHROPIC_MODELS = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5'
}
CLI_MODEL_FLAGS = { opus: 'opus', sonnet: 'sonnet', haiku: 'haiku' }
```

ALL model references throughout the codebase route through this canonical source:
- **3-tier system**: `ModelTier = 'opus' | 'sonnet' | 'haiku'`
- **Legacy aliases**: `fast` → haiku, `balanced` → sonnet, `capable` → opus
- **Job defaults**: Most jobs default to `haiku`, with severity-based escalation (e.g., git-sync escalates to sonnet for state conflicts, opus for code conflicts)
- **Components using models**: StallTriageNurse (sonnet), MessageSentinel (haiku), ExternalOperationGate (haiku), DispatchExecutor (haiku), JobReflector (opus for complex reflection)
- **Test coverage**: `tests/unit/Models.test.ts` (182 lines) + `tests/integration/model-resolution.test.ts` (196 lines) validate model IDs, tier resolution, and cross-component consistency

**Audit results:**
- **No deprecated model references found** — zero instances of `opus-4-0`, `opus-4-1`, `sonnet-4-5`, `claude-3`, or date-suffixed model IDs
- **Model tiering already current** — all three active models (opus-4-6, sonnet-4-6, haiku-4-5) correctly referenced
- **Centralized design** means future model updates require changing ONE file (`models.ts`)
- **Test suite validates** model IDs lack 8-digit date suffixes, preventing accidental pinning to deprecated versions

**"ultrathink" / effort level:**
- NOT currently implemented in Instar
- Claude Code's extended thinking is inherited automatically (agents get it for free when using Opus/Sonnet)
- Explicit effort level control (e.g., `--effort high` or "ultrathink" keyword) is a future opportunity

**ACTION ITEMS:**

1. **No changes needed for model references** (CONFIRMED):
   All model IDs are current. Centralized dictionary ensures single-point updates.

2. **Consider effort level parameter** (LOW PRIORITY — future):
   Instar could expose an `effort` parameter in job definitions: `effort: 'low' | 'medium' | 'high'`. This would let complex jobs (planning, research synthesis) request deeper thinking. Not urgent because Claude Code already uses extended thinking adaptively.

3. **Consider "ultrathink" for planning tasks** (LOW PRIORITY — future):
   Job prompts for complex tasks could include "ultrathink" keyword to trigger high effort. Worth testing empirically to see if quality improvement justifies the cost.

**Testing requirements:**
- Existing tests already validate model resolution and consistency
- No new tests needed for this item

**Resolution:**
COMPATIBLE — Instar's model references are already fully current with Opus 4.6, Sonnet 4.6, and Haiku 4.5. The centralized `models.ts` dictionary with comprehensive test coverage makes updates trivial. No deprecated models found anywhere in the codebase. Extended thinking / effort level control is a future opportunity but not a gap.

---

## Priority 2 — Medium Impact

### 6. Remote Control

**Status:** CONFLICT — INCOMPATIBLE WITH CURRENT ARCHITECTURE (but addressable)

**What Anthropic shipped:**
- `claude remote-control [--name "session name"]` makes local sessions accessible from claude.ai/code, Claude iOS/Android apps
- Outbound-only architecture — local session polls Anthropic API, never opens inbound ports
- Full interaction: send messages, approve file changes, approve tool calls, redirect work
- Session naming via `--name` (appears in session list at claude.ai/code)
- Also available mid-session via `/remote-control` or `/rc` command
- Works over SSH/tmux — survives laptop sleep and brief network drops
- Multiple instances supported (one remote connection per Claude Code instance)
- Config option: "Enable Remote Control for all sessions" via `/config`

**CRITICAL INCOMPATIBILITY:**

`--dangerously-skip-permissions` is **deliberately blocked** with Remote Control. Anthropic requires every action to be explicitly approved as a security decision when accessed remotely.

Instar uses `--dangerously-skip-permissions` on **ALL** spawned sessions (both job and interactive). This is fundamental to autonomous operation — jobs can't run autonomously if every tool call requires human approval.

This means: **Instar-spawned sessions CANNOT use Remote Control in their current form.**

**Current Instar session spawning (code-traced):**

All sessions go through `SessionManager.ts`:
- Job sessions (line 193-197): `claude --dangerously-skip-permissions --model <model> -p <prompt>`
- Interactive sessions (line 605-610): `claude --dangerously-skip-permissions [--resume <id>]`
- **No `--name` flag** used anywhere
- Session identity is entirely tmux-based: `{projectBasename}-{sanitizedName}`

**Assessment — two distinct use cases:**

1. **Autonomous job sessions** (the common case):
   - MUST use `--dangerously-skip-permissions` for unattended operation
   - Remote Control is incompatible AND unnecessary — these sessions don't need human interaction
   - Telegram/WhatsApp monitoring is the right paradigm here
   - **No action needed**

2. **Interactive sessions** (user-initiated via Telegram):
   - Currently use `--dangerously-skip-permissions` but could optionally NOT
   - Remote Control would let users monitor/interact from their phone via claude.ai instead of Telegram
   - BUT: this would mean every tool call needs approval, fundamentally changing the UX
   - **Not a good fit** — Instar's value is autonomous operation, not permission-gated operation

3. **Observation-only use case** (future opportunity):
   - If Anthropic adds a "read-only Remote Control" mode (monitor without approval gates), this becomes valuable
   - Users could watch their agent work in real-time from their phone without interrupting it
   - Currently not possible — Remote Control is all-or-nothing on permissions

**The `--name` flag — worth adding regardless:**

Even without Remote Control, passing `--name` to Claude sessions is valuable:
- Makes sessions identifiable in `claude --list` output
- Better debugging when multiple sessions are running
- Future-proofs for if/when Remote Control becomes compatible with autonomous sessions
- Low effort: just add `--name {jobSlug or sessionName}` to spawn args

**ACTION ITEMS:**

1. **Pass `--name` flag when spawning sessions** (LOW PRIORITY):
   Add `--name` to both `spawnSession()` and `spawnInteractiveSession()` with the job slug or session name. Makes sessions identifiable in `claude --list` and prepares for future Remote Control compatibility.

2. **Document Remote Control incompatibility** (MEDIUM PRIORITY):
   Users should know: "Remote Control requires permission approval for every action, which conflicts with autonomous operation. Use Telegram/WhatsApp monitoring instead." Add to setup wizard awareness or FAQ.

3. **Monitor Anthropic for read-only Remote Control** (WATCH):
   If Anthropic ships observation-only mode (monitor without permission gates), revisit integration. This would be the ideal complement to Telegram — real-time visual monitoring without interrupting autonomous work.

**Testing requirements:**
- Verify `--name` flag is accepted by current Claude Code version
- Verify `--name` doesn't conflict with `--dangerously-skip-permissions`
- Verify `--name` appears in `claude --list` output

**Resolution:**
CONFLICT (addressable) — Remote Control is fundamentally incompatible with Instar's autonomous operation because it blocks `--dangerously-skip-permissions`. This is by design (Anthropic's security decision). Instar's monitoring paradigm (Telegram/WhatsApp) is the correct approach for autonomous agents. The `--name` flag should be added for session identifiability regardless. Watch for Anthropic shipping a read-only observation mode.

---

### 7. Security Changes

**Status:** COMPATIBLE — NO BREAKAGE, ONE FORWARD-LOOKING CONCERN

**What Anthropic shipped:**
- Skill discovery no longer loads from gitignored directories
- Symlink bypass prevention
- Skills don't bypass permissions
- Enhanced sandboxing

**Current Instar behavior (code-traced):**

**Skill directories — SAFE:**
- Skills installed in `.claude/skills/` (NOT gitignored)
- 12+ built-in skills (evolve, learn, gaps, commit-action, etc.)
- Installed via `installBuiltinSkills()` in `init.ts`
- Built-in manifest tracked at `src/data/builtin-manifest.json` (166 entries)
- `.gitignore` does NOT block `.claude/` or `.claude/skills/`

**Symlinks — SAFE:**
- Zero references to `fs.symlink()`, `ln -s`, or symlink creation anywhere in codebase
- All hooks and skills use direct file paths

**Hook placement — SAFE:**
- Hooks installed in `.instar/hooks/instar/` (NOT gitignored)
- 7+ hooks: session-start.sh, dangerous-command-guard.sh, grounding-before-messaging.sh, external-operation-gate.js, claim-intercept.js, deferral-detector.js, etc.
- Settings template configures hooks via `.claude/settings.json` with PreToolUse, PostToolUse, SessionStart matchers

**Sandbox settings — SAFE:**
- Zero references to `--dangerouslyDisableSandbox`
- Default sandboxing behavior inherited from Claude Code

**Permission model — CURRENT STATUS OK, FORWARD-LOOKING CONCERN:**

All sessions currently use `--dangerously-skip-permissions`:
- `spawnSession()` (line 193): hardcoded for job sessions
- `spawnInteractiveSession()` (line 605): hardcoded for interactive sessions

The security changes Anthropic shipped (gitignore blocking, symlink prevention, skill permission scoping) do NOT affect `--dangerously-skip-permissions` sessions — that flag bypasses the permission system entirely.

**However**, TelegramLifeline already has a forward-looking `--allowedTools` fallback (lines 960-975):
```typescript
const useAllowedTools = await this.supportsAllowedTools(claudePath);
const permFlag = useAllowedTools
  ? '--allowedTools Read,Write,Edit,Glob,Grep,Bash'
  : '--dangerously-skip-permissions';
```

This suggests the architects anticipated `--dangerously-skip-permissions` potentially being deprecated. If Anthropic ever removes or restricts it, Instar has a partial migration path — but only in TelegramLifeline's doctor sessions. `spawnSession()` and `spawnInteractiveSession()` lack this fallback.

**Assessment:**

No current breakage. Anthropic's security tightening targets the permission-gated path (skills can't escalate, gitignored dirs blocked, symlinks prevented). Instar bypasses this entirely with `--dangerously-skip-permissions`. The security changes are about defense-in-depth for the permission-gated model, which Instar doesn't use.

The only concern is future: if `--dangerously-skip-permissions` is deprecated or restricted, Instar needs the `--allowedTools` fallback in all spawn paths. But this is speculative — Anthropic explicitly supports the flag for autonomous agent use cases.

**ACTION ITEMS:**

1. **No changes needed for current compatibility** (CONFIRMED):
   All skills in non-gitignored directories. No symlinks. No sandbox overrides. `--dangerously-skip-permissions` unaffected by security tightening.

2. **Extend `--allowedTools` fallback to all spawn paths** (LOW PRIORITY — future-proofing):
   Mirror TelegramLifeline's `supportsAllowedTools()` pattern in `spawnSession()` and `spawnInteractiveSession()`. Not urgent because `--dangerously-skip-permissions` is still fully supported.

3. **Monitor Anthropic's stance on `--dangerously-skip-permissions`** (WATCH):
   If deprecation signals appear, activate the `--allowedTools` migration. The pattern already exists in the codebase.

**Testing requirements:**
- Verify skills load correctly from `.claude/skills/` (no gitignore blocking)
- Verify hooks execute from `.instar/hooks/instar/` under current sandboxing
- Verify `--dangerously-skip-permissions` still functions as expected

**Resolution:**
COMPATIBLE — No breakage from Anthropic's security tightening. All Instar skills and hooks are in non-gitignored directories with no symlinks. The security changes target the permission-gated model, which Instar bypasses via `--dangerously-skip-permissions`. Forward-looking: `--allowedTools` fallback pattern exists in TelegramLifeline and should eventually be extended to all spawn paths.

---

### 8. Plugin System Enhancements

**Status:** SYNERGY IDENTIFIED — MAJOR DISTRIBUTION OPPORTUNITY

**What Anthropic shipped:**
- Full plugin system: `.claude-plugin/plugin.json` manifest, namespaced skills (`/plugin-name:skill`), hooks, MCP servers, agents, LSP servers — all bundled in one distributable unit
- `git-subdir` source type: sparse clone of monorepo subdirectories for efficient plugin hosting
- Scope isolation: plugins namespaced, filesystem-isolated (no path traversal), components independent
- Marketplace system: official Anthropic marketplace + custom marketplaces via GitHub repos
- Installation scopes: user (global), project (shared via git), local (gitignored personal), managed (server-controlled)
- Plugin management: `/plugin` interactive UI, `claude plugin install/enable/disable/update/uninstall` CLI
- `${CLAUDE_PLUGIN_ROOT}` env var for portable script paths
- `/reload-plugins` for live reload without restart

**Current Instar behavior (code-traced):**

Instar's skill system is entirely local:
- Skills are markdown files at `.claude/skills/{slug}/SKILL.md` with YAML frontmatter
- 5 built-in evolution skills installed during `instar init`: evolve, learn, gaps, commit-action, feedback
- `CapabilityMapper.scanSkills()` discovers skills via filesystem scan
- Built-in manifest (`src/data/builtin-manifest.json`, 166 entries) tracks provenance: `instar` | `agent` | `user` | `inherited`
- No plugin infrastructure, no external distribution, no marketplace integration
- Agents self-author additional skills during sessions — captured expertise, not imported packages

**Assessment — plugin distribution is a natural fit:**

Instar's built-in skills (evolve, learn, gaps, commit-action, feedback) + hooks (dangerous-command-guard, session-start, compaction-recovery, etc.) are exactly what the plugin system is designed to distribute. Today, `instar init` writes these files locally. With the plugin system, Instar could be distributed as a Claude Code plugin:

**What an "Instar Plugin" would look like:**
```
instar-plugin/
├── .claude-plugin/
│   └── plugin.json          # name: "instar", version, etc.
├── skills/
│   ├── evolve/SKILL.md
│   ├── learn/SKILL.md
│   ├── gaps/SKILL.md
│   ├── commit-action/SKILL.md
│   └── feedback/SKILL.md
├── hooks/
│   └── hooks.json           # PreToolUse, SessionStart, PostToolUse hooks
├── agents/
│   └── (custom agent definitions)
└── mcp-config.json          # Instar server as MCP server
```

Users would install via: `/plugin install instar@instar-marketplace`

Skills would be namespaced: `/instar:evolve`, `/instar:learn`, etc.

**But: this is a FUTURE architecture, not a current need.**

The plugin system is designed for distribution and sharing. Instar already handles its own distribution via npm (`npx instar`) and `instar init`. Converting to a plugin model would be a significant architectural shift that changes:
- How skills are discovered (plugin namespacing vs direct `/skill-name`)
- How hooks are installed (plugin hooks.json vs init.ts file writes)
- How updates work (plugin update vs npm update + init)
- How the server integrates (MCP server vs standalone HTTP server)

This is worth tracking as a FUTURE direction, not an immediate action.

**Scope isolation — no current impact:**

Instar skills all share the same context (no isolation). This is fine because they're all self-authored by the same agent. Plugin-style scope isolation would matter if Instar supported third-party skill packages — which it doesn't today.

**Marketplace as Instar ecosystem distribution:**

The bigger opportunity: Instar could host a MARKETPLACE of community-contributed skills. Users could share their agent-authored skills with other Instar users. This aligns with Claude Code's marketplace model and would be a natural extension once the user base grows.

**ACTION ITEMS:**

1. **No changes needed for current compatibility** (CONFIRMED):
   Instar's local skill model works alongside plugins. No conflicts — they're parallel systems.

2. **Evaluate Instar-as-plugin architecture** (LOW PRIORITY — future):
   Could Instar's core components (hooks, skills, agent definitions) be packaged as a Claude Code plugin? This would simplify installation for new users: `/plugin install instar` instead of `npx instar`. Major architectural shift — needs dedicated design work.

3. **Consider community skill marketplace** (LOW PRIORITY — future):
   Host a GitHub-based marketplace where Instar users share agent-authored skills. Natural fit with Claude Code's marketplace model. Depends on user base growth.

4. **Consider MCP server integration** (MEDIUM PRIORITY — future):
   Instar server could register as an MCP server via plugin manifest, making its capabilities (working memory, job scheduling, session management) available as native Claude Code tools. This would be a powerful integration point.

**Testing requirements:**
- Verify Instar skills load correctly alongside any installed plugins
- Verify no naming conflicts between Instar skills and plugin-namespaced skills
- Verify `instar init` doesn't interfere with plugin-installed components

**Resolution:**
SYNERGY IDENTIFIED — Claude Code's plugin system is a natural distribution mechanism for Instar's components (skills, hooks, agent definitions). Not actionable today — Instar's npm+init model works well — but tracking as a future architectural direction. The immediate wins are: (1) no current conflicts with plugin system, (2) MCP server integration via plugins could expose Instar's capabilities as native Claude Code tools, (3) community skill marketplace could leverage Claude Code's marketplace infrastructure.

---

### 9. VS Code Integration

**Status:** COMPATIBLE WITH CAVEATS — PARALLEL SYSTEMS, NOT INTEGRATED

**What Anthropic shipped:**
- Session list view in VS Code (see all Claude sessions)
- Plan view for task tracking
- Native `/mcp` management UI
- Improved extension integration

**Current Instar behavior (code-traced):**

Instar's session model is entirely **tmux-based and terminal-centric**:

- All sessions spawned via `tmux new-session -d -s {name} -c {projectDir} ... claude ...`
- Process monitoring via `tmux display-message` (alive/dead check)
- Interactive message injection via tmux pane stdin (`injectMessage()`)
- Session cleanup via `tmux kill-session`
- Dashboard monitoring via WebSocket + HTTP API (`GET /sessions`, `/status`)

**VS Code compatibility analysis:**

1. **Instar server + VS Code terminal**: WORKS. Instar server runs independently (`instar server start`). The Instar server spawns Claude sessions in tmux regardless of where the server was started. VS Code's integrated terminal is just another terminal — it can run `instar` CLI commands, start the server, etc.

2. **VS Code session list**: Instar-spawned sessions show up in VS Code's session list IF the user is logged into the same Claude account. VS Code sees all Claude sessions on the machine. Instar sessions would appear alongside any VS Code-spawned sessions. Session names would be whatever tmux names Instar generates (e.g., `instar-job-ai-guy-abc123`).

3. **VS Code `/mcp` management**: Potential friction. Instar installs Playwright MCP via `.claude/settings.local.json`. VS Code's `/mcp` UI could show and modify this configuration. If a user changes MCP settings via VS Code, Instar's next `init` or update might overwrite them. Not a breakage, but a user confusion risk.

4. **VS Code plan view**: No conflict. Instar doesn't track tasks in Claude Code's task system. VS Code's plan view shows Claude-internal tasks, which are orthogonal to Instar's job scheduler.

5. **Can VS Code spawn sessions that Instar manages?**: NO. Instar's session management requires sessions to be in tmux. VS Code's Claude extension spawns sessions in its own runtime. Instar cannot monitor, inject messages into, or manage VS Code-spawned Claude sessions. These are separate worlds.

**The two-world reality:**

Users running Instar + VS Code will have TWO session systems:
- **Instar sessions**: autonomous jobs, Telegram-interactive sessions, scheduled work — all in tmux, monitored by Instar dashboard + Telegram
- **VS Code sessions**: manual coding sessions, ad-hoc Claude assistance — in VS Code, monitored by VS Code UI

This is fine. They serve different purposes. The risk is user confusion ("which sessions are mine?") — Instar session names should be distinctive enough to identify.

**ACTION ITEMS:**

1. **No changes needed for compatibility** (CONFIRMED):
   Instar and VS Code Claude sessions are parallel systems. No conflicts, no breakage.

2. **Distinctive session naming** (LOW PRIORITY):
   Ensure Instar's tmux session names are clearly identifiable (they already use `{projectName}-job-{slug}` pattern). When `--name` is added (Item 6, L10), use a clear prefix like `instar:job-name`.

3. **Document the two-world model** (LOW PRIORITY):
   Users should know: "Instar manages autonomous sessions via tmux. VS Code manages your manual coding sessions. They coexist — Instar sessions may appear in VS Code's session list but are managed independently."

4. **MCP settings coordination** (LOW PRIORITY):
   Document that Instar manages MCP config in `.claude/settings.local.json`. Users modifying MCP via VS Code's `/mcp` UI should be aware that `instar init` may overwrite local settings.

**Testing requirements:**
- Verify Instar server starts and spawns sessions normally when launched from VS Code terminal
- Verify Instar sessions appear in VS Code's session list view
- Verify no MCP configuration conflicts between Instar setup and VS Code `/mcp` UI

**Resolution:**
COMPATIBLE WITH CAVEATS — Instar and VS Code Claude sessions are parallel systems that coexist without conflict. VS Code can see Instar sessions in its list view but cannot manage them (tmux vs extension runtime). No changes needed. Document the two-world model for user clarity. Coordinate MCP settings to avoid overwrite confusion.

---

## Priority 3 — Incremental Improvements

### 10. Voice Input (20 languages)

**Status:** COMPATIBLE — NOT APPLICABLE TO INSTAR'S USE CASE

**What Anthropic shipped:**
- STT expanded to 20 languages in Claude Code CLI
- Push-to-talk keybinding support

**Current Instar behavior (code-traced):**

Instar has its OWN voice transcription pipeline for Telegram:
- `TelegramAdapter.ts` handles voice messages from Telegram users
- Transcription via Groq (whisper-large-v3) or OpenAI (whisper-1)
- Configurable via `voiceProvider` config or env vars
- Voice messages arrive pre-transcribed before reaching the Claude session

Claude Code's voice input is a CLI-interactive feature (push-to-talk while typing). Instar-spawned sessions are headless (`-p` prompt mode) or tmux-based REPL — neither has a microphone interface.

**Assessment:**

Voice input is irrelevant for Instar's architecture:
- Headless job sessions: no human present to speak
- Interactive Telegram sessions: voice comes through Telegram, transcribed by Instar, sent as text to Claude
- The user talks to their agent via Telegram voice messages, not via Claude Code's CLI microphone

No conflicts, no action needed.

**Resolution:**
COMPATIBLE — Not applicable. Claude Code's voice input is a CLI-interactive feature. Instar handles voice through Telegram's voice message pipeline with its own Whisper transcription. No overlap, no conflict.

---

### 11. Performance Improvements

**Status:** COMPATIBLE — FREE WINS, NO ACTION NEEDED

**What Anthropic shipped:**
- ~16MB memory reduction per session
- Bridge reconnection in seconds (was 10 minutes)
- Images preserved during compaction

**Impact on Instar:**

All three improvements are automatically inherited:

1. **~16MB memory reduction**: Instar runs up to 3 concurrent sessions (`maxSessions: 3`). At 16MB savings each, that's ~48MB less memory pressure. Helps especially on lower-spec machines and when `OrphanProcessReaper` is monitoring memory. Free win.

2. **Bridge reconnection (seconds vs 10 minutes)**: This is the most impactful improvement. Instar's `StallDetector` monitors sessions for hangs and triggers triage after configurable timeouts. Previously, a bridge disconnect looked like a stall — the session appeared unresponsive for up to 10 minutes. Faster reconnection means fewer false stall detections and more reliable long-running autonomous sessions. Free win.

3. **Images preserved during compaction**: Minimal impact for most Instar agents (primarily text-based work). Could matter for agents processing screenshots, diagrams, or visual content. Free win.

**No action needed.** These are upstream improvements that make Instar sessions more reliable and efficient automatically.

**Resolution:**
COMPATIBLE — All three performance improvements are inherited for free. Bridge reconnection improvement is especially valuable for reducing false stall detections in long-running autonomous sessions.

---

### 12. `/loop` Command

**Status:** COMPATIBLE — COMPLEMENTARY, NOT COMPETING

**What Anthropic shipped:**
- `/loop` runs a recurring prompt within a single session at configurable intervals
- Session stays alive between iterations
- Context accumulates across iterations

**Current Instar behavior (code-traced):**

Instar's job scheduler (`JobScheduler.ts`) is fundamentally different:
- Jobs spawn NEW sessions each execution (fresh context every time)
- Scheduling via cron expressions (every N hours, daily at time, etc.)
- Sessions end after job completion
- Cross-session continuity via MEMORY.md and state files, not context accumulation

**Assessment — different layers, different purposes:**

| Aspect | `/loop` | Instar Scheduler |
|--------|---------|-----------------|
| Scope | Within one session | Across sessions |
| Context | Accumulates | Fresh each run |
| Scheduling | Simple interval | Full cron expressions |
| Persistence | Dies with session | Survives restarts |
| Cost | Single session | New session per run |

They're complementary:
- **`/loop`**: Good for intra-session monitoring (watch a log file, poll an endpoint, periodic self-check). Context builds up, enabling the agent to notice trends.
- **Instar scheduler**: Good for independent recurring tasks (daily report, hourly health check). Fresh context each run, no state leakage between executions.

**Potential synergy:**

Instar could inject `/loop` into long-running interactive sessions for periodic self-checks (memory status, stall prevention, working memory refresh). Currently Instar handles this externally via `StallDetector` — `/loop` could make it agent-internal.

**No conflicts.** `/loop` is a session-level command that doesn't affect Instar's scheduling infrastructure.

**ACTION ITEMS:**

1. **No changes needed for compatibility** (CONFIRMED).

2. **Consider `/loop` for intra-session monitoring** (LOW PRIORITY — future):
   Long-running interactive sessions could use `/loop` for periodic self-checks. Complement to external stall detection.

**Resolution:**
COMPATIBLE — `/loop` and Instar's scheduler operate at different layers (intra-session vs cross-session). Complementary, not competing. No conflicts.

---

### 13. `/simplify` and `/batch`

**Status:** COMPATIBLE — INHERITED TOOLS, MINOR SYNERGY

**What Anthropic shipped:**
- `/simplify`: Reviews changed code for reuse, quality, and efficiency, then fixes issues found
- `/batch`: Parallel task execution within a session (multiple subagents working simultaneously)

**Current Instar behavior:**

No references to `/simplify` or `/batch` in the Instar codebase. These are Claude Code session-level commands available to any agent during a session.

**Assessment:**

Both are inherited for free — any Instar agent can invoke them during a session:

- **`/simplify`**: An agent could use this after making code changes as a quality check. Natural fit for Instar's evolution skills — the `evolve` skill could invoke `/simplify` as part of its code improvement workflow. No conflict with existing skills.

- **`/batch`**: Parallel task execution within a session. Different from Instar's parallel sessions (separate tmux processes). `/batch` runs multiple subagents in the SAME context window. Useful for multi-file operations (update 10 config files, refactor across modules). Complementary to Instar's session-level parallelism.

**No conflicts.** These are session-level tools that agents can use freely.

**ACTION ITEMS:**

1. **No changes needed** (CONFIRMED).

2. **Consider `/simplify` in evolution workflow** (LOW PRIORITY — future):
   The `evolve` skill could invoke `/simplify` after code changes as an automated quality pass.

**Resolution:**
COMPATIBLE — Both commands are inherited session-level tools. `/simplify` could integrate into evolution workflows. `/batch` complements Instar's cross-session parallelism with intra-session parallelism. No conflicts.

---

### 14. Configuration Options

**Status:** SYNERGY IDENTIFIED — TUNING OPPORTUNITIES

**What Anthropic shipped:**
- `includeGitInstructions` setting — controls whether Claude includes git-specific instructions in context
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` — controls output token budget during compaction
- Various new configuration knobs for session behavior

**Current Instar behavior (code-traced):**

Instar passes minimal configuration to spawned sessions:
- `--dangerously-skip-permissions` (always)
- `--model <tier>` (optional)
- `-p "<prompt>"` (for job sessions)
- `--resume <id>` (for interactive session resume)
- No environment variable tuning for Claude Code behavior
- No settings overrides beyond what's in `.claude/settings.json`

**Assessment — tuning opportunities:**

1. **`includeGitInstructions`**: Could be set to `false` for non-code agents. Saves context tokens for agents focused on communication, research, or administration rather than code. Currently all agents get git instructions by default — wasted context for non-coding tasks.

2. **`CLAUDE_CODE_MAX_OUTPUT_TOKENS`**: Controls how much the agent can output during compaction summaries. Relevant because Instar's `compaction-recovery.sh` hook fires after compaction and injects identity context. If compaction output is too limited, the agent might lose important context. Testing needed to find optimal values.

3. **Session-level env vars**: Instar already clears sensitive env vars before spawning. Could also SET Claude Code config vars per session type:
   - Job sessions: lower output tokens (focused work), disable git instructions for non-code jobs
   - Interactive sessions: higher output tokens (conversational), keep git instructions

**ACTION ITEMS:**

1. **Test `CLAUDE_CODE_MAX_OUTPUT_TOKENS` impact on compaction** (MEDIUM PRIORITY):
   Determine if the default token budget is sufficient for Instar's compaction recovery flow. If agents lose identity context after compaction, increasing this value could help.

2. **Per-job-type `includeGitInstructions` setting** (LOW PRIORITY):
   Non-code agents (communication, research) could disable git instructions to save context. Add to job definition schema: `gitInstructions: boolean`.

3. **Document available configuration knobs** (LOW PRIORITY):
   Create a reference of Claude Code env vars and settings that Instar could tune per session type. Helps users optimize their agents.

**Testing requirements:**
- Test compaction behavior with different `CLAUDE_CODE_MAX_OUTPUT_TOKENS` values
- Verify `includeGitInstructions: false` saves meaningful context for non-code sessions
- Confirm env vars set before tmux session launch propagate to Claude Code process

**Resolution:**
SYNERGY IDENTIFIED — Configuration options offer tuning opportunities for Instar-managed sessions. Most impactful: `CLAUDE_CODE_MAX_OUTPUT_TOKENS` for compaction quality and `includeGitInstructions` for non-code agents. Not urgent but worth exploring as optimization passes.

---

## Cross-Cutting Concerns

### Documentation Updates Needed
- [ ] README: Reference new Claude Code features Instar leverages
- [ ] Landing page: Promote synergies (worktrees, Remote Control, etc.)
- [ ] Setup wizard: Awareness of new options (worktrees, Remote Control, voice)
- [ ] CHANGELOG: Track integration work

### Testing Requirements
- [ ] Worktree spawning test
- [ ] HTTP hook delivery test
- [ ] Hook event payload verification
- [ ] Auto-memory coordination test
- [ ] Security constraint verification
- [ ] Remote Control compatibility test

### Architecture Decisions Log

1. **Worktrees: awareness, not adoption** — Instar should NOT use worktrees itself, but must detect when Claude Code creates them implicitly and prevent silent work loss.
2. **HTTP hooks: observability, not safety** — HTTP hooks for telemetry (PostToolUse, SubagentStart/Stop, WorktreeCreate/Remove). Shell hooks stay for safety gates (dangerous-command-guard, session-start, compaction-recovery) because HTTP hooks cannot reliably block actions.
3. **Remote Control: incompatible by design** — Blocks `--dangerously-skip-permissions`. Instar's Telegram/WhatsApp monitoring is the correct paradigm for autonomous agents. Not a bug, architectural divergence.
4. **Model references: centralized and current** — Single source of truth at `src/core/models.ts`. No deprecated models found.

---

## Consolidated Action Items

> Extracted from all completed audit items. Prioritized for implementation.

### HIGH PRIORITY

| # | Item | Source | Description | Status |
|---|------|--------|-------------|--------|
| H1 | Post-session worktree scan | Item 1 | Wire into `sessionComplete`: run `git worktree list`, check for uncommitted/unmerged changes on worktree branches, alert via Telegram | IMPLEMENTED (WorktreeMonitor.ts, 22 tests) |
| H2 | Hook event receiver endpoint | Item 2 | Add `POST /hooks/events` to Instar server — receives hook event payloads, stores for session telemetry | IMPLEMENTED (HookEventReceiver.ts + routes, 19+15 tests) |
| H3 | HTTP hook templates for observability | Item 2 | Ship templates for PostToolUse, TaskCompleted, SubagentStart/Stop, WorktreeCreate/Remove, Stop | IMPLEMENTED (http-hook-templates.ts, 9 tests) |
| H4 | InstructionsLoaded hook | Item 3 | Command hook that verifies expected CLAUDE.md files loaded; alerts if identity context missing | IMPLEMENTED (InstructionsVerifier.ts + hook script, 22 tests) |
| H5 | SubagentStart/Stop hooks | Item 3 | Track subagent lifecycle, capture `last_assistant_message` and `agent_transcript_path` from SubagentStop | IMPLEMENTED (SubagentTracker.ts + hook script, 23 tests) |
| H6 | Stop + SessionEnd hooks | Item 3 | Capture `last_assistant_message` (final output) and exit reason; wire into sessionComplete handler | IMPLEMENTED (via HookEventReceiver + HTTP hooks) |

### MEDIUM PRIORITY

| # | Item | Source | Description | Status |
|---|------|--------|-------------|--------|
| M1 | Periodic orphan worktree detection | Item 1 | Health check: `git worktree list` + `git branch --list 'worktree-*'` across managed projects, flag stale worktrees | IMPLEMENTED (via H1 WorktreeMonitor) |
| M2 | WorktreeCreate/WorktreeRemove hooks | Item 1 | POST to Instar server on worktree lifecycle events (also covered by H3) | IMPLEMENTED (via H3 HTTP hook templates) |
| M3 | Update settings-template.json | Item 2 | Add HTTP hook entries alongside existing command hooks | IMPLEMENTED (InstructionsLoaded + SubagentStart added) |
| M4 | Parse agent_id/agent_type from existing hooks | Item 3 | Existing PreToolUse/UserPromptSubmit hooks now carry these fields — extract and log | IMPLEMENTED (scope-coherence-collector updated) |
| M5 | TaskCompleted as quality gate | Item 3 | Verify task completion before marking job done (complement to process-death inference) | IMPLEMENTED (hasTaskCompleted + getLastAssistantMessage + getExitReason, 7 tests) |
| M6 | Document two-memory-system reality | Item 4 | Users should know: `.instar/MEMORY.md` vs `~/.claude/projects/.../memory/MEMORY.md` — add to setup wizard or CLAUDE.md template | IMPLEMENTED (CLAUDE.md template updated) |
| M7 | Document Remote Control incompatibility | Item 6 | Add to FAQ/setup wizard: Remote Control requires permission approval, incompatible with autonomous operation | IMPLEMENTED (CLAUDE.md template updated) |
| M8 | Test `CLAUDE_CODE_MAX_OUTPUT_TOKENS` for compaction | Item 14 | Determine optimal token budget for compaction — affects identity recovery quality | DEFERRED (requires manual experimentation) |

### LOW PRIORITY

| # | Item | Source | Description | Status |
|---|------|--------|-------------|--------|
| L1 | Session-branch linking | Item 1 | Record which branch a session was on and any worktree branches it created | |
| L2 | Merge-back prompt for orphan branches | Item 1 | Surface orphan worktree branches with commits to user for merge decision | |
| L3 | Cross-machine hook forwarding | Item 2 | HTTP hooks from remote machines POST to centralized Instar server via tunnel | |
| L4 | PreCompact hook | Item 3 | Know when compaction occurs; could trigger working memory injection or frequent-compaction alerts | IMPLEMENTED (HTTP hook template added) |
| L5 | Wire ExecutionJournal to PostToolUse | Item 3 | ExecutionJournal infrastructure exists but is inactive — PostToolUse feeds it | |
| L6 | Read auto-memory as knowledge source | Item 4 | MemoryMigrator could optionally ingest Claude auto-memory as additional source | |
| L7 | Auto-memory hygiene job | Item 4 | Periodic sync from auto-memory into SemanticMemory + trim | |
| L8 | Effort level parameter for jobs | Item 5 | `effort: 'low' | 'medium' | 'high'` in job definitions for deeper thinking on complex tasks | |
| L9 | "ultrathink" keyword in planning prompts | Item 5 | Worth testing empirically for complex job prompts | |
| L10 | Session telemetry enrichment | Item 6 | Enrich session listings (API + dashboard) with hook event telemetry: tools used, subagents, last activity, task completion, exit reason. Note: `--name` is only valid for `remote-control`, not `claude` CLI | IMPLEMENTED (routes.ts + WebSocketManager, 3 tests) |
| L11 | Extend `--allowedTools` fallback to all spawn paths | Item 7 | Mirror TelegramLifeline's `supportsAllowedTools()` in `spawnSession()` and `spawnInteractiveSession()` | |
| L12 | Evaluate Instar-as-plugin architecture | Item 8 | Could core components (hooks, skills, agents) be packaged as a Claude Code plugin? Major arch shift — needs design | |
| L13 | Community skill marketplace | Item 8 | GitHub-based marketplace for Instar users to share agent-authored skills. Depends on user base growth | |
| L14 | MCP server plugin integration | Item 8 | Register Instar server as MCP server via plugin manifest — exposes working memory, job scheduling as native tools | |
| L15 | `/loop` for intra-session monitoring | Item 12 | Long-running interactive sessions could use `/loop` for periodic self-checks | |
| L16 | `/simplify` in evolution workflow | Item 13 | The `evolve` skill could invoke `/simplify` after code changes as automated quality pass | |
| L17 | Per-job-type `includeGitInstructions` | Item 14 | Non-code agents disable git instructions to save context | |
| L18 | Document available Claude Code config knobs | Item 14 | Reference of tunable env vars and settings for per-session-type optimization | |

### WATCH

| # | Item | Source | Description |
|---|------|--------|-------------|
| W1 | Read-only Remote Control mode | Item 6 | If Anthropic ships observation-only mode (monitor without permission gates), revisit integration |
| W2 | `--dangerously-skip-permissions` deprecation | Item 7 | If Anthropic signals deprecation, activate `--allowedTools` migration across all spawn paths |

---

## Session Log

| Date | Session | Items Addressed | Notes |
|------|---------|----------------|-------|
| 2026-03-07 | Initial research (topic 4509) | All 14 items identified | Research phase complete |
| 2026-03-07 | Document creation (topic 11047) | Document seated | Ready for deep-dive work |
| 2026-03-07 | Deep-dive session 1 (topic 11047) | Items 1-4 completed | Worktrees, HTTP Hooks, New Hook Events, Auto-Memory |
| 2026-03-08 | Deep-dive session 2 (topic 11047) | Items 5-14 completed | ALL ITEMS COMPLETE. Model refs clean, Remote Control incompatible, Security clear, Plugin synergy, VS Code parallel, Performance free wins, Loop/Simplify/Batch complementary, Config tuning opportunities |
| 2026-03-08 | Implementation session 1 (topic 11047) | H1-H6, M1-M5 implemented | WorktreeMonitor, HookEventReceiver, HTTP hook templates, InstructionsVerifier, SubagentTracker, server wiring, quality gate methods. 117 new tests |
| 2026-03-08 | Implementation session 2 (topic 11047) | M6-M7, L4, L10 implemented, M8 deferred | Two-memory docs, Remote Control docs, PreCompact hook, --name flag for sessions. 121+ new tests total. All HIGH and MEDIUM items resolved |
