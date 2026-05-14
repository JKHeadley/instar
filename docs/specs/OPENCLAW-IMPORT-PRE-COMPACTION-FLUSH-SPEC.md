---
slug: openclaw-import-pre-compaction-flush
title: Pre-Compaction Memory Flush
review-convergence: true
approved: true
approved-by: justin
approved-at: 2026-05-13
approval-channel: telegram/9003
---

# OpenClaw Import — Pre-Compaction Memory Flush

**Project**: openclaw-imports
**Item**: T1.1 (Round 2 / Tier 1)
**Source**: OpenClaw audit §3 (Compaction-time memory flush); `docs/concepts/memory.md:120-140`
**Architecture**: Option A (server-side, agent-noninterruptive)

## TL;DR

When a Claude Code session is about to undergo context compaction, instar fires a brief LLM extraction over the recent transcript and writes durable facts to the agent's `.instar/memory/` files. Those files survive the compaction; the agent's next session-start hook surfaces them as new memory entries.

## Problem

Instar already has a *post-compaction* recovery hook (`compaction-recovery.sh`) that re-injects identity (AGENT.md + MEMORY.md) into the session context after compaction. It does NOT have a *pre-compaction* flush that proactively writes new memory before compaction collapses the working state.

Result: anything the session learned between memory writes can be lost in the compaction summariser's generic pass. Operators report "the agent forgot what I told it 30 minutes ago" after long conversations. The recovery hook re-injects the old MEMORY.md — it can't recover material that was never written.

## Reference: OpenClaw's design

From `docs/concepts/memory.md:120-140`:

> Before compaction, OpenClaw runs a silent turn that prompts the agent to save important context to memory files. Configurable per-model: `agents.defaults.compaction.memoryFlush.model` can pin the flush turn to a local Ollama model independent of the main session.

Imported properties:
1. **Silent**: user sees no output; flush runs alongside compaction.
2. **Distinct model knob**: flush model can be pinned independently of the session's main model.
3. **Bounded**: writes are caps-respected (max-facts, max-chars, no side effects beyond memory files + audit).

## Design

### Option A — server-side, agent-noninterruptive (this implementation)

Claude Code already emits a `PreCompact` hook event. The existing `hook-event-reporter.js` POSTs that event to instar's server, where `HookEventReceiver` emits a typed `PreCompact` event. This change adds one new listener.

Flow:

1. `PreCompact` event arrives in the instar server with `session_id` + (optionally) `transcript_path`.
2. `PreCompactionFlush.handle()` runs async; never blocks the hook caller, never throws.
3. Flush resolves the transcript path (payload value if present; else standard Claude Code convention: `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`).
4. Flush reads the last `transcriptCharBudget` chars (default 30 KB) of the transcript, aligned on a line boundary.
5. Flush calls `sharedIntelligence.evaluate(prompt)` — subscription-by-default per PR #198's safety guard.
6. Flush parses the response (JSON array, `{facts: [...]}` object, or fenced JSON), coerces each fact to `{slug, body}`, caps at `maxFactsPerFlush` (default 5).
7. Each fact is written to `<projectDir>/.instar/memory/learning_precompact_<ts>_<slug>.md` with frontmatter declaring `metadata.type: learning` and `metadata.source: pre-compaction-flush`.
8. If `<projectDir>/.instar/MEMORY.md` exists, index entries are appended under a `## Pre-Compaction Saves` section.
9. Every fire writes one structured entry to `<projectDir>/.instar/audit/pre-compaction-flush.jsonl`.

### Config knob

```jsonc
{
  "preCompactionFlush": {
    "enabled": false,                  // default off — opt-in feature
    "maxFactsPerFlush": 5,             // hard cap on facts written per fire
    "transcriptCharBudget": 30000      // chars of transcript tail sent to LLM
  }
}
```

Default `enabled: false` so the behavior change is fully opt-in for v1. Operators flip to `true` after observing audit-log shape.

### Failure modes

Every outcome is audited; none throw to the caller.

| Outcome | Trigger | Effect |
|---------|---------|--------|
| `disabled` | `config.enabled === false` | No work; audit only. |
| `no-intelligence` | shared provider unavailable | Audit only. |
| `no-session-id` | payload lacks `session_id` | Audit only. |
| `no-transcript` | transcript file missing or unreadable | Audit only. |
| `provider-error` | LLM call throws | Audit with `reason` truncated to 200 chars. |
| `no-facts` | response is `NONE` or `[]` | Audit only — model decided nothing durable. |
| `parse-failure` | response is non-empty but unparseable | Audit with truncated reason. |
| `write-error` | any write throws | Audit with `factsWritten` so far. |
| `ok` | end-to-end success | Audit with `factsWritten`. |

### Why Option A over Option B

Considered: in-session silent turn — inject a `/save-context` prompt into the live tmux session via PreCompact hook, wait for the agent to process it, then let compaction proceed.

Rejected. Two reasons:

1. **User-visible outcome is identical.** Both approaches result in durable facts surviving compaction. The agent's next session sees the new memory files either way.
2. **Server-side is simpler and lower-risk.** No tmux injection mid-compaction, no race with the compactor, no blocking on the agent's response time. The existing PreCompact hook stays fire-and-forget; the new behaviour is a server-side listener.

The "agent-attested" argument for Option B (the agent itself decides what to remember) is philosophically nicer but doesn't translate to a user-visible difference. Recorded as a possible v2 refinement; not blocking v1.

## Files touched

| File | Change |
|------|--------|
| `src/core/PreCompactionFlush.ts` | NEW — class + types + default config |
| `src/commands/server.ts` | wire `hookEventReceiver.on('PreCompact', flush.handle)` behind config gate |
| `tests/unit/PreCompactionFlush.test.ts` | NEW — 16 assertions over outcomes, parsing, file writes |
| `upgrades/NEXT.md` | append release note |
| `upgrades/side-effects/openclaw-import-pre-compaction-flush.md` | NEW — side-effects review |
| `docs/specs/OPENCLAW-IMPORT-PRE-COMPACTION-FLUSH-SPEC.md` | THIS |
| `docs/specs/OPENCLAW-IMPORT-PRE-COMPACTION-FLUSH-SPEC.eli16.md` | NEW — ELI16 companion |
| `package.json` + `package-lock.json` | version bump |

## What is NOT in this spec

- **Per-model knob for the flush LLM.** Default uses the shared intelligence provider; supporting a separate model (e.g., pin to local Ollama) is straightforward but adds config surface for a v1 with no demonstrated need.
- **Cross-session memory deduplication.** If multiple flushes write similar facts, no dedupe is applied. Memory consumers already handle near-duplicates on read.
- **In-session silent turn (Option B).** Recorded as possible v2; not blocking.
- **Hook script changes.** The existing PreCompact hook in `hook-event-reporter.js` already forwards the event; this change adds a listener server-side. New agents and existing agents both benefit on the next instar update.

## Risk assessment

- **Over-block / spend**: bounded by `maxFactsPerFlush: 5` and `transcriptCharBudget: 30 KB`. Each flush is one LLM call against the subscription path. Negligible cost.
- **Under-block**: at most one flush per compaction event, with `maxFactsPerFlush` items. If the model is conservative (recommended via the prompt's "If nothing durable, respond NONE" line), the under-block is "no facts written" — same as today.
- **Latency**: flush runs detached; hook caller sees no delay. Compaction proceeds normally regardless of flush completion.
- **Spend**: zero on default subscription path (PR #198 safety guard ensures subscription-only by default).
- **Rollback**: set `preCompactionFlush.enabled: false`. Listener becomes a no-op.

## Acceptance criteria

1. `PreCompactionFlush` class is the single chokepoint for flush logic; integration test exercises the full path end-to-end with a stubbed intelligence provider.
2. All 9 failure outcomes are audit-logged with shape `{flushId, sessionId, trigger, at, outcome, durationMs, …}`.
3. Successful flush writes per-fact files to `.instar/memory/learning_precompact_*.md` and appends MEMORY.md index entries.
4. `maxFactsPerFlush` is a hard cap, asserted by unit test.
5. Disabled config keeps the listener wired but the handler exits at `disabled` with audit only.
6. CI green on all shards.
7. ELI16 companion published at `OPENCLAW-IMPORT-PRE-COMPACTION-FLUSH-SPEC.eli16.md`.
