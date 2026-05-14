# Pre-Prompt Memory Recall — Plain-English Overview

This is the plain-English companion to the technical spec. Read this first.

## What this is

A small "before your agent answers, check what it knows" step. When you type a message to your agent, before the agent composes its reply, instar quickly looks through its memory for anything relevant, and slips that into the agent's context. The agent gets the relevant memory snippets without you having to ask "did you check your notes?"

## Why it matters

Right now, your agent's responses can feel uneven. Sometimes it pulls up a perfect recall of something you told it last week. Other times it answers as if it has no memory at all. The difference isn't whether the memory has the answer — the difference is whether the specific skill the agent is using happened to query memory before replying. Some skills do, some don't, and they all use slightly different settings.

This change adds a single bounded recall pass that runs before EVERY reply, so the "did I check my notes?" question is always answered the same way.

## How it works (in 5 steps)

1. You type a message to your agent.
2. Claude Code's `UserPromptSubmit` hook fires. Instar's hook script reads your message.
3. The hook POSTs your message to instar's server, which runs a quick (≤2 second) memory search against the agent's SemanticMemory.
4. If anything relevant turns up — up to 5 entries, capped at 1200 characters total — the hook emits a small context block like:
   ```
   <active_memory_recall>
   - prod-db-pool: max connections 20
   - routing-pattern: use router.go(), not history.push
   </active_memory_recall>
   ```
5. Claude Code prepends that block to the agent's context for this turn. The agent sees it like any other system-level context.

## What you'll notice

- More consistent grounding. The agent's response should reference earlier context more reliably, especially on the first message of a new topic.
- Faster responses on repeated queries. The recall is cached for 15 seconds, so if you ask three rapid follow-ups, only the first triggers a search.
- No interruption. The recall runs in the background of the prompt-submit hook; your agent's reply isn't delayed by more than ~2 seconds in the worst case, and typically much less.

## What you will NOT notice

- Any LLM cost. Recall is pure local sqlite search — no model calls, no per-call spend.
- Any change when memory is sparse. If SemanticMemory has nothing relevant to your message, the recall returns empty and Claude Code sees no injected context. The reply is identical to today.
- Any disruption to existing grounding skills. Skills that already check memory continue to do so. This adds a layer; it doesn't replace anything.

## Safety properties

- **Bounded.** Max 5 entries, max 1200 chars of injected text, max 2-second search.
- **Circuit breaker.** If SemanticMemory throws three errors in a row, recall short-circuits to empty for 60 seconds. A misbehaving memory backend can't lock up your prompt submission.
- **Cached.** Identical user messages within 15 seconds reuse the previous result — no repeated searching on duplicate queries.
- **Local-only.** No external network calls. The recall touches SemanticMemory (sqlite) on the same machine.
- **Opt-in.** Default `enabled: false`. Flip in `.instar/config.json` once you've decided you want it.

## How to enable

Two steps after the release lands:

### 1. Enable the server-side primitive

Edit `.instar/config.json`:

```json
{
  "promptBuildRecall": {
    "enabled": true,
    "maxRecallChars": 1200,
    "maxRecallResults": 5,
    "cacheTtlMs": 15000,
    "circuitBreakerMaxFailures": 3,
    "circuitBreakerCooldownMs": 60000,
    "recallTimeoutMs": 2000,
    "minConfidence": 0.5
  }
}
```

Restart your agent's server. You should see `Pre-prompt memory recall enabled` in the startup log.

### 2. Install the hook in your agent

Copy the hook script from instar's repo into your agent's `.claude/hooks/instar/` folder:

```
.claude/hooks/instar/before-prompt-recall.js
```

Then add a `UserPromptSubmit` entry to your agent's `.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node .claude/hooks/instar/before-prompt-recall.js",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

If you already have a `UserPromptSubmit` block, add this hook as an additional entry inside the existing array.

## How to disable

Either set `promptBuildRecall.enabled: false` in config (server stops constructing the singleton, the endpoint returns empty), or remove the hook entry from `.claude/settings.json` (Claude Code stops calling it). Either is sufficient.

## Reference

- Full spec: `OPENCLAW-IMPORT-BEFORE-PROMPT-BUILD-SPEC.md`
- Side-effects review: `upgrades/side-effects/openclaw-import-before-prompt-build.md`
- Approval: Telegram topic 9003, Justin, 2026-05-13
- Original OpenClaw reference: `docs/openclaw/audit-2026-05-07.md` §3 (active-memory plugin)
