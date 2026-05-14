# Pre-Compaction Memory Flush — Plain-English Overview

This is the plain-English companion to the full spec. Read this first.

## The problem in one sentence

When an agent has a long conversation with you, it sometimes "forgets" things you told it earlier — and the culprit is almost always a context compaction that happened in the middle.

## Why compaction causes forgetting

Claude Code (the tool running your agent) keeps the recent conversation in memory. When that memory fills up, it does something called "compaction" — it collapses the older messages into a generic summary to make room. That summary is written by a fast, generic LLM. It doesn't know what's *durable* in your specific conversation versus what's noise.

So a fact you mentioned 90 minutes ago — say, "the production database pool maxes out at 20 connections" — might get smoothed into the summary as "we talked about the database." The specific number is gone. Next time you mention the database, your agent doesn't have it.

Today, instar has a hook that runs *after* compaction to re-inject the agent's identity files. But that hook only re-injects what was *already saved* to MEMORY.md. Anything the agent learned mid-conversation that wasn't yet written stays lost.

## What this change adds

A new hook that fires *before* compaction. It does one thing: takes a quick look at the recent conversation, asks "what's worth remembering?" and writes the answers to the agent's memory files. Then compaction proceeds normally.

Concretely:

1. Claude Code is about to compact. It emits a "PreCompact" signal.
2. Instar catches that signal and reads the last ~30 KB of the session transcript.
3. Instar asks the shared LLM (your Claude subscription — no extra cost): "From this conversation tail, list up to 5 durable facts that should survive compaction." The LLM is allowed to respond with the literal word "NONE" if nothing durable surfaces.
4. For each fact returned, instar writes a new file under `.instar/memory/learning_precompact_*.md` with the fact body.
5. An audit log entry records what happened, including which model was called and how many facts were written.
6. Compaction runs normally. The agent now has the new memory files available the moment it re-reads its memory index.

## What you'll actually notice

After a long conversation that included a compaction, the agent should "remember" the specific facts you told it earlier instead of having a vague summary of them. The win compounds over multi-hour sessions where multiple compactions happen.

What you will NOT notice:

- Any slowdown. The flush runs in the background; compaction never waits for it.
- Any prompts or interruptions. The agent doesn't have to stop what it's doing to do the flush — instar handles it server-side.
- Any extra charges. The flush rides your existing subscription (per PR #198's safety guard, instar refuses to spend on the API unless you explicitly opt in).

## What this is NOT

- It is **not** a guarantee that nothing will ever be forgotten. The LLM picks what looks durable; if it misses something, that thing still gets compacted into the summary.
- It is **not** a replacement for explicitly saving important things to MEMORY.md yourself. If you tell the agent "please remember that the production db pool maxes at 20," and the agent saves that to MEMORY.md immediately, that's still the most reliable path. This flush is a safety net for things that didn't get explicitly saved.
- It is **not** turned on by default. The release ships with `preCompactionFlush.enabled: false` in config. You'll need to flip it to `true` in `.instar/config.json` after the release lands. This is deliberate — the feature is observable via the audit log, and operators can watch it for a few days before enabling.

## Safety properties

- **Bounded blast radius.** Maximum 5 facts written per compaction event, each fact body capped at 500 characters. A misbehaving LLM can't flood your memory directory.
- **Bounded LLM input.** Only the last 30 KB of the transcript goes to the LLM. No PII in older conversation history gets re-read.
- **Audit-logged.** Every fire — success, skip, error — writes one line to `.instar/audit/pre-compaction-flush.jsonl`. You can grep it to see exactly what got written and why.
- **Fail-quiet.** Any failure (LLM unavailable, transcript missing, parse error) audits and exits. Compaction proceeds normally regardless.
- **Easy rollback.** Flip `preCompactionFlush.enabled: false` and the listener becomes a no-op.

## How to enable

In your `.instar/config.json`:

```json
{
  "preCompactionFlush": {
    "enabled": true,
    "maxFactsPerFlush": 5,
    "transcriptCharBudget": 30000
  }
}
```

Restart your agent's server. The flush is now active. Watch `.instar/audit/pre-compaction-flush.jsonl` for a few sessions to confirm the behavior matches expectations.

## How to disable

Set `preCompactionFlush.enabled: false` (or delete the section). Restart. Done.

## Reference

- Full spec: `OPENCLAW-IMPORT-PRE-COMPACTION-FLUSH-SPEC.md`
- Side-effects review: `upgrades/side-effects/openclaw-import-pre-compaction-flush.md`
- Approval: Telegram topic 9003, Justin, 2026-05-13
- Original OpenClaw reference: `docs/openclaw/audit-2026-05-07.md` §3
