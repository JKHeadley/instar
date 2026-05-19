---
status: draft
date: 2026-05-18
author: echo
audience: justin
type: companion-inventory
parent: framework-functional-parity.md
revision: 4
---

# Required Primitives — Inventory and Instar-Native Fallback Status

## What this is

The formal list of capabilities Instar treats as REQUIRED for any supported framework. For each primitive: a definition, current native support per framework, and the status of Instar's own native implementation that fills the gap when a framework lacks the primitive.

This is the inventory that drives the parity sentinel's "required" cells in the capability matrix. Bonus primitives (framework-specific extras Instar uses opportunistically but doesn't require) live in `framework-functional-parity.md` and the per-framework specs.

## Layer relationship — functional ↔ substrate ↔ adapter

Every required functional primitive in this doc is **Layer 3** in Instar's three-layer model (see `framework-functional-parity.md` → "Layer relationships"). Each entry below now lists its **substrate dependencies** — the **Layer 2** primitives from the v1.0 provider-portability inventory (`specs/provider-portability/01-primitives-inventory.md`) that the functional primitive consumes under the hood.

The chain is: Layer-3 functional primitive → declares which Layer-2 substrate primitives it needs → a Layer-1 framework adapter satisfies those substrate primitives.

**Architectural promise**: any framework whose adapter satisfies the v1.0 substrate primitive set automatically supports all 11 required functional primitives in this inventory.

## How to read the status columns

For each (primitive × framework) cell:

- **native ✓** — framework provides this; Instar wraps and uses the framework-native form. Rendering happens via Instar's framework-specific renderer.
- **partial ⚠️** — framework provides part of the primitive but not all of it; Instar augments with its own implementation to cover the missing pieces.
- **instar-native 🔧** — framework lacks the primitive; Instar's own implementation supplies the capability. The agent feels no difference.
- **not yet built ⏳** — framework lacks the primitive AND Instar's own implementation hasn't been built yet; this is a current gap that the parity layer would fail.
- **wrap exists, not generic 🟡** — Instar has a working implementation but it's tied to one specific framework's runtime; needs extraction into a framework-agnostic Instar-native form before becoming a real fallback.

The principle: every required primitive must reach `native ✓` OR `instar-native 🔧` (or `partial ⚠️` with documented gap coverage) for every supported framework. `not yet built ⏳` cells are work items.

## A primitive is a capability, not a file

Several primitives below name the same on-disk artifact (notably `.instar/AGENT.md`, which is referenced by both **Memory** and **Instruction file**). This is intentional and not a primitive-boundary failure. The primitives are *capabilities*, not files:

- **Memory** is the capability of identity/learning/relationship state surviving across sessions, being backed up, and syncing across machines. AGENT.md, USER.md, MEMORY.md, topic-memory.sqlite, and the knowledge-graph store are all *content artifacts* the Memory capability operates on.
- **Instruction file** is the capability of the framework auto-loading a content blob into the session's system prompt at startup. AGENT.md is the content blob in question; the capability is the auto-loading contract with the framework.

The two capabilities are orthogonal — one is about persistence/sync, the other is about framework-side context loading — and they happen to share a content artifact (AGENT.md) because identity is both "the persistent thing we remember about ourselves" AND "the thing we want loaded at every session start." A future Memory implementation that stored identity in a database row instead of a markdown file would still satisfy the Memory primitive; an Instruction-file implementation that loaded a different blob (say, a per-topic prompt fragment) would still satisfy the Instruction-file primitive. The primitives are independent; the *artifact reuse* is an implementation convenience.

## The required primitives

### 1. Skill

**Definition.** A reusable behavioral capability — markdown + scripts — discoverable as `/<name>` and triggerable by natural-language intent that matches the skill's description.

**Canonical source.** `skills/<name>/SKILL.md` at repo root (framework-agnostic master).

**Substrate dependencies.** `agenticSession` (a skill runs inside one — the framework recognizes the slash command and the session executes the skill body), `toolAccess` (skills need tools to do anything), `toolAllowlist` (per-skill `allowed-tools` frontmatter restricts which tools are callable). Instar-native fallback would also need a discovery-and-dispatch layer Instar doesn't yet own.

| Framework | Status | Notes |
|---|---|---|
| Claude Code | native ✓ | Renders to `.claude/skills/<name>/SKILL.md`. Frontmatter: top-level `user-invocable`, `allowed-tools`, etc. |
| Codex CLI 0.130 | partial ⚠️ | Native discovery works at `.agents/skills/<name>/SKILL.md` BUT requires sibling `agents/openai.yaml` with `interface.display_name` + `short_description`. Instar's current scaffolder writes to `.agent/openai/skills/` (wrong) and doesn't emit the YAML — both fixable in Phase 0. |
| Instar-native fallback | not yet built ⏳ | If a future framework lacked skill discovery entirely, Instar would need to provide a skill-runtime that interprets SKILL.md content and surfaces invocation directly. Not built; not yet needed for currently-supported frameworks. |

**Verification status.** Codex behavior verified via live test on 2026-05-18. See Phase 0 results.

### 2. Hook

**Definition.** A program-defined response to a lifecycle event — session-start, pre-compact, file-edit, session-stop, telegram-message, etc.

**Canonical source.** TBD. Probably `hooks/<event>/<name>.sh` with a manifest.

**Substrate dependencies.** `eventHooks` (the substrate-level callback-on-lifecycle-event pattern), plus — when a hook body needs LLM intelligence — `structuredCompletion` or `oneShotCompletion`. StallTriageNurse is the canonical worked example: it's a Hook whose body calls `structuredCompletion` to diagnose, then `inputInjection` to remediate.

| Framework | Status | Notes |
|---|---|---|
| Claude Code | native ✓ | `.claude/settings.json` configures hook scripts at `.claude/hooks/<event>/<name>.sh`. Extensive event vocabulary. |
| Codex CLI 0.130 | native ✓ (different shape) | `hooks.json` in `.agent/openai/` (per scaffolder). Different event vocabulary — needs cross-framework mapping. |
| Instar-native fallback | partial ⚠️ | Instar runs its own event-driven sentinels (CompactionSentinel, SessionWatchdog) but they're not user-defined hooks. A generic "user-defined-hooks-for-Instar-managed-events" layer would be the fallback. |

**Open question.** Does the canonical hook source format need to encode framework-mapping (event name `session-start` maps to Claude's `SessionStart` and Codex's equivalent)? Or are events Instar-defined and frameworks-as-source emit them through observers we run?

### 3. Agent

**Definition.** A spawnable persona with its own session state, identity, and instruction file. (Claude calls these "subagents"; Codex has its own model.)

**Canonical source.** TBD. Could be `agents/<name>/AGENT.md` + scripts + spec.

**Substrate dependencies.** `agenticSession` (the persona runs as a multi-turn tool-using session), `sessionId` + `processLifecycle` (so the parent can track it), `authCredentialInjection` (per-agent identity). Sub-agents fired from an outer session additionally need `outputStream` and `hardKill` from the parent's perspective.

| Framework | Status | Notes |
|---|---|---|
| Claude Code | native ✓ | Subagents via Task tool or programmatic spawn; share state via Instar's session manager. |
| Codex CLI 0.130 | needs research | Codex's subagent model needs documentation pass — research item. |
| Instar-native fallback | wrap exists, not generic 🟡 | Instar's SessionManager.spawnInteractiveSession spawns sessions, which IS the agent primitive when framework-natively supported. Generic Instar-native version (running an agent without a framework) is the Instar-native-runtime future-state work. |

### 4. Tool

**Definition.** A capability the agent can invoke during a turn — bash, file edit, web fetch, MCP server, etc.

**Canonical source.** Generally framework-provided; tools are part of framework runtime.

**Substrate dependencies.** `toolAccess` (the bare ability for the model to call tools), `toolAllowlist` (restrict which tools), `fileSystemAccess` + `pathAllowlist` (file-touching tools), `bashExecution`, `webAccess`. Tool is the functional primitive most directly mapped onto the substrate capability layer.

| Framework | Status | Notes |
|---|---|---|
| Claude Code | native ✓ | Built-in tools (Read, Edit, Bash, Grep, ...) + MCP servers. |
| Codex CLI 0.130 | native ✓ | Built-in tools (different names) + MCP servers via different config. |
| Instar-native fallback | not yet built ⏳ | An Instar-native runtime would need its own tool-dispatch layer. Significant work; future-state. |

**Note.** Tools are the primitive most closely bound to the substrate. Instar-native-runtime for tools = essentially building an agent harness from scratch.

### 5. Memory

**Definition.** Persistent state that survives session restarts: identity, learning, relationships, topic conversation history, and per-session continuity. A *capability*, not a file.

**Canonical artifact set.** Currently: `.instar/AGENT.md` + `.instar/USER.md` + `.instar/MEMORY.md` + `.instar/state/topic-memory.sqlite` + the knowledge-graph store. The artifact set is implementation; the primitive is the persistence-and-retrieval semantic.

**Internal organization strategies (below the primitive contract).** Memory's *internals* are an active area of design work: recursive tree structures (self-knowledge tree), recursive LLM-driven search, knowledge graphs, semantic search, the playbook scoring system, per-topic memory shards. These are how Memory chooses *what content* to surface for a given session and *how* it's organized — but they sit below the functional-primitive contract. The framework only sees the rendered output (e.g., the assembled AGENT.md blob). It doesn't know or care whether the content was hand-edited, tree-walked, semantic-search-assembled, or generated by recursive LLM summarization. This is why context-engineering strategies are largely *independent* of the parity discussion: they're Memory's internals, not separate primitives. They'd become more visible if/when the Instar-native runtime takes over context assembly directly (see foundational spec → Long-term implication).

**Cross-primitive dependency.** Memory subsystems that need conversation history (e.g., a rolling-topic-summary sentinel, a relationship-tracker reading prior messages) consume **Messaging-platform integration's (#9) historical-access leg** to read message history scoped by platform-native conversation containers (Telegram topic, Slack thread, iMessage chat).

**Watch item.** Memory is intentionally kept as one primitive *for now*, but Justin and Echo flagged 2026-05-18 that it's "broad AND critical" enough to revisit. Likely future split candidates: identity-memory (AGENT.md / MEMORY.md / USER.md) vs topic-memory (per-conversation rolling state) vs relationship-memory (knowledge graph). Tracked here so the next time Memory's internals grow significantly, the split question gets reopened.

**Substrate dependencies.** `contextScopeControl` (which memory files the session is allowed to read at boot), `eventHooks` (session-start hook injects memory; pre-compact hook persists topic memory). Memory itself lives in Instar's own SQLite + flat files; substrate primitives only carry it into and out of sessions.

| Framework | Status | Notes |
|---|---|---|
| Claude Code | partial ⚠️ | Reads CLAUDE.md as system-prompt augmentation. No framework-native session-restoration of arbitrary state — Instar provides that. |
| Codex CLI 0.130 | partial ⚠️ | Reads AGENTS.md similarly. Same story — Instar provides the actual persistence. |
| Instar-native | native ✓ | Memory IS an Instar-native primitive already. The framework's job is just to load the rendered instruction file at session start; the rest is Instar's. |

Memory is the cleanest example of an Instar-native-required primitive: frameworks don't really do this; Instar always does.

### 6. Instruction file

**Definition.** The capability of the framework auto-loading a content blob into the session's system prompt at session start. A *loading mechanism*, not a file.

**Canonical artifact (today).** `.instar/AGENT.md` is the content blob in current use. A future implementation could load a per-topic blob, a tree-assembled blob, or a model-rendered blob; the primitive contract is unchanged.

**Substrate dependencies.** `contextScopeControl` (the substrate has to load this file into the session's prompt scope). Closely linked to Memory above — the instruction file is the entry point through which memory reaches the session.

| Framework | Status | Notes |
|---|---|---|
| Claude Code | native ✓ | Reads `CLAUDE.md` from project root. Rendered by IdentityRenderer. |
| Codex CLI 0.130 | native ✓ | Reads `AGENTS.md` from project root. Rendered by IdentityRenderer. |
| Instar-native fallback | not yet built ⏳ | An Instar-native runtime would read AGENT.md directly without framework rendering. Trivial when needed; not built yet because all current substrates have native support. |

### 7. Session-resume

**Definition.** Mechanism for restoring a paused conversation — agent picks up where it left off after a kill/restart. Has two coupled aspects: (a) restoring the framework-side model-session state (Claude `--resume <uuid>`, Codex `resume` subcommand), and (b) restoring the user-side conversation context by reading prior message history from whichever messaging-platform the conversation lives on. Both aspects must be intact for resume to feel seamless to the user.

**Substrate dependencies.** `sessionId` (so we know which past session to resume), `agenticSession` (to re-attach to it), `processLifecycle` (to know if it actually came back up).

**Cross-primitive dependency.** Consumes **Messaging-platform integration's (#9) historical-access leg** to read prior conversation context per platform-native container (Telegram topic, Slack thread, iMessage chat). Without this, resume restores the model but loses the conversational thread the user is actually living in.

| Framework | Status | Notes |
|---|---|---|
| Claude Code | native ✓ | `claude --resume <UUID>`. Instar uses TopicResumeMap to track. |
| Codex CLI 0.130 | partial ⚠️ | `codex resume` exists as a subcommand. Instar's spawn path currently warns "codex CLI's 'resume' is a subcommand, not a flag — starting fresh" — needs integration. |
| Instar-native fallback | partial ⚠️ | Instar's CompactionSentinel handles compaction-recovery (a form of session-resume), but full state-restoration on cold-start without framework support isn't built. |

### 8. Slash-command or equivalent

**Definition.** User-side textual invocation surface — `/route`, `/local-model`, etc.

**Canonical source.** Each slash command is its own definition; usually tied to a skill OR to a server route + Telegram parser.

**Substrate dependencies.** None at the substrate-call layer when handled by Instar's own Telegram parser (the slash command resolves to an HTTP route on Instar's server, no LLM involved). When the slash command auto-registers from a skill, dependencies are whatever the skill needs (see Skill above).

| Framework | Status | Notes |
|---|---|---|
| Claude Code | native ✓ | Skills auto-register as `/<name>`. Plus Instar's Telegram parser handles `/route`, `/local-model`, etc. |
| Codex CLI 0.130 | native ✓ | Same auto-register pattern from skills + Instar's Telegram parser. |
| Instar-native | native ✓ | Instar's TelegramAdapter parses slash commands independently of the framework. |

Slash-commands have a hybrid story: framework-side auto-registration from skills + Instar-native Telegram parsing. Both layers coexist.

### 9. Messaging-platform integration

**Definition.** The bidirectional, history-aware integration between an Instar agent and a user-side messaging surface (Telegram, Slack, iMessage, WhatsApp, etc.). Covers three coupled responsibilities:

- **Outbound** — agent → user message delivery (currently the relay-script pattern on Telegram).
- **Inbound** — user → agent message ingestion (long-poll / webhook / adapter-specific).
- **Historical access** — reading prior conversation history scoped by platform-native conversation containers (Telegram topic, Slack channel/thread, iMessage chat). Consumed by session-resume (to know where the conversation left off) and by memory subsystems (e.g., a rolling-topic-summary sentinel that needs to read a topic's recent messages).

**Why one primitive covers all three.** All three responsibilities are platform-shaped — Telegram topics, Slack threads, and iMessage chats have different containers, different ID schemes, and different read APIs. An adapter that handles one direction without the others is incomplete from an Instar perspective. Bundling them keeps the parity contract honest: "Instar supports messaging-platform X" means all three work uniformly.

**Substrate dependencies.** `bashExecution` and `contextScopeControl` for the outbound relay-script pattern (currently). Inbound + historical access live in the messaging adapter layer (`src/messaging/`) and don't go through model-call substrate primitives — they're framework-independent infra reachable from any session.

| Framework | Status | Notes |
|---|---|---|
| Claude Code | native ✓ (with Instar config) | Outbound: SessionStart hook injects "MANDATORY: relay back" + relay script. Inbound + history: TelegramAdapter / SlackAdapter (Instar-native, platform-agnostic). |
| Codex CLI 0.130 | instar-native 🔧 (post-PR #247) | Codex doesn't have an equivalent session-start hook for outbound; Instar fills the gap by inlining the relay block in every bootstrap message + auto-rendering it into AGENTS.md via IdentityRenderer. Inbound + history paths are identical to Claude (framework-independent). |
| Instar-native | native ✓ | The relay route, inbound adapters, and history APIs are all Instar-native already. Frameworks only participate in the outbound-from-session leg. |

**Note on cross-primitive references.** Session-resume (#7) consumes this primitive's historical-access leg to restore conversation context after a kill/restart. Memory (#5) consumes it for any subsystem that needs platform-aware history (rolling topic summaries, relationship-tracking against message history, etc.). These references are why messaging-platform integration is a *primitive*, not just an adapter-layer concern: other primitives depend on its contract.

This was the cleanest "Instar filled a framework gap" case shipped this week (Codex outbound relay). Expansion to formally include inbound + history as one primitive — per Justin's 2026-05-18 reframe — closes a quiet implicit dependency from session-resume and memory subsystems.

### 10. Conversational action

**Definition.** The agent's ability to interpret natural-language config intent ("can we switch to a local model?"), ask clarifying questions if needed, and execute via an authed action endpoint. **Foundational stance** (locked 2026-05-18, per Justin): Instar users should not need to know ANY Instar internals. Every aspect of Instar's functionality must be explorable conversationally, and every config change must be doable conversationally on multiple levels. The agent maintains a very high degree of self-awareness of its own architecture AND a responsibility to actively guide the user — suggesting config changes from stated needs, recognizing when a stated need maps to "you want a hook here" or "you want a new skill" without the user having to know hook/skill exist. The slash-command surface is a backstop, not the primary path. Conversational is the default.

**Canonical source.** Skills + AGENT.md self-awareness section + authed POST endpoints.

**Substrate dependencies.** `oneShotCompletion` or `structuredCompletion` (intent classification + clarification phrasing — the same primitive StallTriageNurse uses), `agenticSession` (the in-flight session that hears the user and dispatches), `contextScopeControl` (so the self-awareness section reaches the agent). This primitive is the densest user of substrate-LLM access in the inventory.

| Framework | Status | Notes |
|---|---|---|
| Claude Code | not yet built ⏳ | Self-awareness section in CLAUDE.md not yet auto-rendered; conversational-action API endpoints not yet exposed. Designed in `13-framework-parity-sentinel.md`. |
| Codex CLI 0.130 | not yet built ⏳ | Same status. |
| Instar-native | not yet built ⏳ | The endpoints + the registry + the renderer integration are the work. |

This is the design layer Justin asked for after `/local-model` shipped. It depends on the parity sentinel + functional-component registry being in place.

### 11. MCP server registration

**Definition.** Attaching external tool-server capability to the agent.

**Substrate dependencies.** Extends `toolAccess` (MCP servers expand the tool set). Configuration is framework-local (per-machine), so there's no Instar-side substrate call — registration happens at framework-config layer, not at session-call layer.

| Framework | Status | Notes |
|---|---|---|
| Claude Code | native ✓ | `claude mcp add` writes to `~/.claude.json`. Per-machine, NOT synced by Instar — known constraint. |
| Codex CLI 0.130 | native ✓ | Codex has its own MCP config format. Per-machine. |
| Instar-native fallback | not yet built ⏳ | Instar could provide its own MCP-client layer for an Instar-native runtime. Not currently needed; per-machine framework-native is fine for both supported frameworks. |

## Summary: Status snapshot

Among 11 required primitives × 2 currently-supported frameworks = 22 cells, plus Instar-native fallback column:

- 12 cells `native ✓` (framework natively satisfies the primitive)
- 6 cells `partial ⚠️` (framework partially satisfies; Instar augments)
- 1 cell `instar-native 🔧` (framework gap, Instar's own fills — currently only Codex outbound-relay)
- 3 cells `not yet built ⏳` (in the conversational-action row — work items)
- Plus 4 Instar-native fallback rows marked `not yet built ⏳` (skill, instruction-file, tool, MCP) — these are future-work for the Instar-native-runtime path, not blockers today.

## Priority order for filling gaps

1. **Codex skill rendering correction.** Phase 0 work: fix `.agent/openai/skills/` → `.agents/skills/`; emit `agents/openai.yaml` sibling. Shifts Skill on Codex from `partial ⚠️` to `native ✓`. Smallest gap, highest verified impact.

2. **Codex session-resume integration.** Use `codex resume` subcommand when a session has a tracked Codex session id. Shifts session-resume on Codex from `partial ⚠️` to `native ✓`.

3. **Conversational-action layer.** All three `not yet built ⏳` cells in row 10. This is the spec we discussed — endpoints + registry + renderer integration.

4. **Hook canonical-source format + cross-framework mapping.** Lets users author hooks once and Instar renders them for both Claude and Codex correctly.

5. **Agent primitive research + canonical-source format.** Establishes the pattern for "spawnable persona."

Lower-priority (Instar-native-runtime future-state work):

6. Tool dispatch (Instar-native).
7. MCP-client (Instar-native).
8. Instruction-file loading (Instar-native).
9. Skill discovery (Instar-native).

## Revision history

- **rev 4 (2026-05-18)** — Locked the catalog from Justin's weigh-in: Hook=required, MCP=bonus, Conversational-action=required (with foundational stance on conversational discoverability + agent self-awareness + active user guidance baked into the definition), Memory=one-for-now-watch-closely, Session-resume=own primitive. Renamed primitive #9 from "Outbound relay" to "Messaging-platform integration" — bidirectional + history-aware — and added cross-primitive references to Memory (#5) and Session-resume (#7). Resolved-questions block records each call; new-questions block captures the next layer (Memory-split trigger, hook-event vocabulary, self-awareness granularity, messaging-adapter contract shape).
- **rev 3 (2026-05-18)** — Re-anchored Memory and Instruction-file entries to *capabilities* rather than file paths to resolve the apparent double-listing of `.instar/AGENT.md`. Added "A primitive is a capability, not a file" framing section explaining why artifact overlap between primitives is intentional. Added an "Internal organization strategies" note to Memory explicitly placing context-engineering strategies (recursive trees, knowledge graphs, semantic search, playbook) below the primitive contract.
- **rev 2 (2026-05-18)** — Added "Substrate dependencies" field to every primitive entry naming which Layer-2 substrate primitives (from `specs/provider-portability/01-primitives-inventory.md`) each Layer-3 functional primitive consumes. Added the "Layer relationship" framing section explaining how this inventory sits on top of the v1.0 substrate primitives catalog and the architectural promise: satisfying the v1.0 substrate set automatically satisfies all 11 functional primitives.
- **rev 1 (2026-05-18)** — Initial inventory.

## Resolved questions (2026-05-18)

All four original open questions were resolved with Justin in conversation. Recording the calls so the parity sentinel and downstream specs can rely on them:

- **Q1. Conversational action — separate primitive?** **Yes, primitive.** Drives the foundational stance: users explore + change every aspect of Instar conversationally; agent maintains very high self-awareness; agent guides user. Inlined into primitive #10's definition above.

- **Q2. Hook — required or bonus?** **Required.** Too much load-bearing Instar infrastructure (session-start identity injection, compaction recovery, telegram-message dispatch) depends on lifecycle events. If a framework lacked hooks, Instar would emulate. Tied to a refinement on Q5 below — users don't "request a hook"; the agent recognizes when a stated need calls for one.

- **Q3. MCP server registration — required or bonus?** **Bonus (for now).** Useful when present; Instar doesn't depend on it. Promoting it to required would force an MCP-client shim for any framework that lacked it. Reopen if a future Instar capability becomes structurally dependent on MCP.

- **Q4. Memory — one primitive or several?** **One, for now.** Shared contract is "persists across sessions, survives restarts, syncs across machines." Internal organization (tree / graph / search / playbook) stays below the primitive line. Flagged as a watch item in the Memory entry — broad enough that the split question stays live for next time Memory's internals grow.

- **Q5. Hook canonical-source format — Instar-defined events vs canonical mapping?** **Hybrid.** Instar-defined events for things only Instar sees (compaction, telegram-message). Framework-event mapping for things only the framework sees (file-edit, pre-tool-use). Each event has one canonical owner. Important refinement from Justin: users don't "request a hook" — they state a need and the agent recognizes hook is the right fit. The hook-authoring surface is internal; the user-facing surface is conversational (see primitive #10).

- **Q6. Session-resume — own primitive or parameter of Agent?** **Own primitive.** Resume has distinct failure modes (state corruption, ID-not-found, partial restore) and distinct observability needs from cold-spawn. Also: resume now formally depends on the Messaging-platform integration primitive's historical-access leg (see entry #7).

## New open questions (post-2026-05-18 lock)

- **When does Memory split?** No trigger criterion defined. Probably: when topic-memory and identity-memory grow divergent failure/observability characteristics. Until then, watched.

- **What's the right canonical hook-event vocabulary?** Need a concrete list of Instar-defined events (and which framework-side events get mirrored). Pre-work for the Hook concept spec.

- **How granular should the agent's self-awareness section be?** Every skill listed? Every config knob? Every endpoint? Affects how Conversational-action (#10) is rendered into instruction files. Probably: skills + capability index by default; deeper docs queried on demand via the existing self-knowledge tree.

- **What's the right messaging-platform abstraction shape?** Now that messaging-platform integration is one bidirectional+history primitive, what does the canonical "adapter contract" look like? Affects future Slack/iMessage/WhatsApp parity work.

