# Track 5: Hooks, Safety & Extensibility

## Executive Summary
Instar installs 14+ behavioral hooks covering session start, dangerous command blocking, deferral detection, identity grounding, scope coherence, and false claim detection. Custom hooks are fully supported in `.instar/hooks/custom/` without core modification. Safety gates use Haiku for ~1-2s reviews. The API surface has 25+ endpoints with Bearer token auth and rate limiting. PostToolUse hooks receive tool name/arguments/output as text context, enabling vault protection patterns.

---

## 1. Complete Hook List

**[VERIFIED]** Installed via `src/core/PostUpdateMigrator.ts`

| Hook | Trigger | Purpose | Lines |
|------|---------|---------|-------|
| session-start | SessionStart (startup/resume/clear/compact) | Identity, topic context, capability awareness injection | 1234-1511 |
| compaction-recovery | Pre-compact | Full context re-injection on memory compaction | Delegates to session-start |
| dangerous-command-guard | PreToolUse (Bash) | Blocks rm -rf, git reset --hard, destructive commands | 1512-1739 |
| telegram-topic-context | PreToolUse | Detects unanswered user questions in topic | 1740-2102 |
| external-operation-gate | PostToolUse | MCP tool safety gate for external calls | 2338-2592 |
| deferral-detector | PreResponse | Anti-deferral — detects "I'll do X later" patterns | 2103-2166 |
| post-action-reflection | PostToolUse | Evolution awareness — logs pattern learning | 2167-2276 |
| external-communication-guard | PreResponse | Identity grounding before Telegram/external sends | 2277-2337 |
| scope-coherence-collector | PostToolUse | Tracks implementation depth per scope level | 2593-2708 |
| scope-coherence-checkpoint | PreResponse | Zoom-out checkpoint before response | 2709-2847 |
| free-text-guard | PreResponse | Blocks AskUserQuestion for passwords/free-text | 2848-2854 |
| claim-intercept | PostToolUse | False claim detection on tool output | 2855-3074 |
| claim-intercept-response | PreResponse | False claim detection on agent responses | 3199+ |
| response-review | PreResponse | Coherence gate response review | 3075-3198 |
| grounding-before-messaging | PreResponse | Identity check before external messaging | 1225 |

**HTTP observability hooks** (`src/data/http-hook-templates.ts:52-143`):
- PostToolUse, SubagentStart, SubagentStop, Stop, WorktreeCreate, WorktreeRemove, TaskCompleted, SessionEnd, PreCompact
- All POST to `/hooks/events` with Bearer token auth

---

## 2. Command Guard Blocklist

**[VERIFIED]** `src/core/PostUpdateMigrator.ts:1512-1739`

**Always blocked (ALWAYS_BLOCK):**
```
rm -rf /
rm -rf ~
git reset --hard
git push --force
git clean -fd
dd if=/dev/zero
mkfs
shred
```

**Risky patterns** (behavior depends on safety level):
- Level 1 (default): Block + tell agent to ask user (exit code 2)
- Level 2 (autonomous): Inject self-verification prompt (exit code 0, agent reasons)

---

## 3. Custom Hooks

**[VERIFIED]** Fully supported without core modification:

- **Directory**: `.instar/hooks/custom/` (separate from built-in `hooks/instar/`)
- **Protection**: Migration never touches `custom/` directory (line 81)
- **Format**: Drop `.sh` or `.js` files — they're sourced by Claude Code's hook system
- **Configuration**: Register in CLAUDE.md or `.claude/settings.json` hook configuration

---

## 4. Safety Gate (LLM Review)

**[VERIFIED]** `src/core/ExternalOperationGate.ts`

- **Trigger**: Tool use to external systems (defined in gate config)
- **Model**: Haiku ("Tier 1" supervision)
- **Latency**: ~1-2 seconds
- **Cost**: ~50-100 tokens per review
- **Scoping**: Agent-configured list of "external operations"
- **Fallback**: If LLM unavailable, uses heuristics (file mutability, reversibility)

---

## 5. MCP Server Configuration

**[VERIFIED]**

- **Per-session**: Claude Code's native MCP support (outside Instar scope)
- **Per-job**: `grounding` field in JobDefinition (types.ts:145-154):
  - `contextFiles`: Additional context files
  - `questions`: Custom grounding questions
  - `processesExternalInput`: Security flag
- **Per-topic**: TopicMemory provides awareness context (auto-injected)
- **No dynamic MCP config at runtime** — static during init/setup

---

## 6. Skills Loading

**[VERIFIED]**

- **Claude Code built-in**: `.claude/skills/` (not Instar-managed)
- **Instar-provided**: `setup-wizard`, `secret-setup` (package.json:70)
- **Discovery**: Claude Code scans project for SKILL.md files at startup
- **CLAUDE.md template**: Includes "Building New Capabilities" section with skill examples

---

## 7. API Surface

**[VERIFIED]** `src/server/routes.ts`

**No auth required:**
- `GET /ping` — health check
- `GET /health` — detailed status
- `GET /.well-known/instar.json` — API discovery

**Authenticated (Bearer token):**
- Sessions: `GET/POST /sessions`, `GET /sessions/:id`, `/sessions/:id/history`, `POST /sessions/:id/trigger`, `/sessions/:id/kill`
- Jobs: `GET /jobs`, `/jobs/history`, `/jobs/:slug/history`, `POST /jobs/:slug/trigger`, `/jobs/:slug/pause`, `/jobs/:slug/resume`
- Context: `GET /context`, `/context/session/:id`, `/context/working-memory`
- Hooks: `POST /hooks/events`, `GET /hooks/events/:sessionId`, `/hooks/events/:sessionId/summary`
- Topics: `GET /topic/context/:topicId`, `/topic/search`
- Evolution: `GET /evolution`, `/evolution/gaps`, `/autonomy`
- Feedback: `POST /feedback`
- Reflection: `POST /reflect/:sessionId`

**Rate limiting**: 100 requests per 15 minutes per IP (via middleware)

---

## 8. Vault Protection via PostToolUse Hook

**[VERIFIED]** PostToolUse hooks receive:
- Tool name ✓
- Tool arguments ✓ (as text)
- Tool output ✓ (as text)

**File paths NOT explicitly passed** as structured data — must parse from arguments/output text.

**Vault protection pattern**: Custom hook in `.instar/hooks/custom/` can:
1. Check tool output for `/vault/` path mentions
2. Parse file paths from Write/Edit tool arguments
3. Trigger `git -C /vault commit -a -m "..."` on match
4. Return exit code 2 to block unauthorized operations

**No built-in vault enforcement** — requires user-implemented custom hook.
