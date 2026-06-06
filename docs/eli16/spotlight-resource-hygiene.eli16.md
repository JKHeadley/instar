# Spotlight resource hygiene — exclude Claude transcripts - ELI16

> The one-line version: macOS Spotlight was burning ~60-90% of a CPU core constantly because it kept re-indexing Instar's Claude session transcripts — ~18 GB of files that grow with every single message. This tells Spotlight to skip them, so it stops.

## The problem (found 2026-06-06 while chasing fleet-wide resource hogging)

Justin flagged that the machine regularly hits "resource hogging" and suspected Instar. Grounding it with `ps`/`mds_stores` showed the single biggest non-agent CPU consumer was `mds_stores` — that's macOS Spotlight, the thing that indexes your files so you can search them. It was pinned at 60-90% of a core, *constantly*.

Why constantly? Every Claude Code session writes a running transcript to `~/.claude/projects/<project>/<session>.jsonl`, and **appends to it on every single turn**. Across a busy fleet that's ~18 GB of files that change every few seconds. Spotlight re-indexes a file whenever it changes — so it was endlessly re-reading 18 GB of transcripts that nobody ever Spotlight-searches.

## What already existed

Instar already drops a tiny `.metadata_never_index` marker (the standard macOS "don't index this folder" hint) on two things: the `.worktrees/` folder and `node_modules/`. Both are big, both are pointless to index. But the **transcripts were never excluded** — and they're the bigger, constantly-churning set. The earlier exclusion fixed the static trees and missed the moving one.

## What this adds

One more exclusion, following the exact same pattern: drop the `.metadata_never_index` marker at the agent's Claude transcript directory (`~/.claude/projects/<encoded-agent-home>`). 

- A new `ensureClaudeTranscriptSpotlightExclusion(agentHome)` helper computes where Claude stores this agent's transcripts (Claude encodes the home path by turning every non-letter/number into `-`, e.g. `/Users/justin/.instar/agents/echo` → `-Users-justin--instar-agents-echo`) and drops the marker there.
- A `PostUpdateMigrator` migration runs it on every update, so existing agents get the relief automatically (new agents get it on their first update once they have transcripts).

## Why it's safe

- The marker is the documented Apple way to say "don't index this." It's harmless on non-macOS, idempotent, and reversible (delete the file).
- Nothing useful is lost: nobody Spotlight-searches a raw Claude JSONL transcript. Instar reads them directly (the TokenLedger), which is unaffected by Spotlight.
- It only ever *adds* a marker file; it never deletes or moves a transcript. A write failure is a silent no-op (Spotlight just keeps indexing, the prior behavior) — it can never block an update.

## Honest scope

This is **one** of four resource-efficiency fixes Justin asked for, and it's the biggest single lever (the 18 GB transcript churn). It does NOT, by itself, instantly drop `mds_stores` — the marker stops *future* re-indexing, but Spotlight only fully releases already-indexed content on its own schedule (forcing immediate eviction needs a one-time `sudo mdutil` the operator runs). The durable win is that no agent, new or existing, keeps feeding the transcript churn going forward.

## Evidence

Three boundaries covered by unit tests (marker dropped when transcripts exist; correct non-alphanumeric encoding; graceful no-op for a brand-new agent with no transcripts yet; idempotent) plus migration tests (backfills on update, skips cleanly when absent, idempotent). 15/15 green in the spotlight-exclusion suite. `tsc --noEmit` clean. Mirrors the existing node_modules/worktree exclusion pattern exactly.
