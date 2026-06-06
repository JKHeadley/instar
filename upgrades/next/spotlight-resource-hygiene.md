<!-- bump: patch -->
<!-- change_type: fix -->

## What Changed

macOS Spotlight (`mds_stores`) was a top constant CPU consumer on busy fleet
boxes because it re-indexed the Claude Code session transcripts on every turn —
~18 GB of JSONL that grows with every message. Instar already excluded
`.worktrees/` and `node_modules/` from Spotlight; this extends the same
`.metadata_never_index` exclusion to the agent's Claude transcript directory
(`~/.claude/projects/<encoded-agent-home>`), the largest churning set.

New `ensureClaudeTranscriptSpotlightExclusion()` helper + a `PostUpdateMigrator`
backfill so existing agents get the relief on their next update.

## What to Tell Your User

Nothing required — this is silent OS-level resource hygiene. If they've noticed
the Mac running hot, part of the cause was Spotlight endlessly re-indexing
session transcripts; this stops that going forward.

## Summary of New Capabilities

- `ensureClaudeTranscriptSpotlightExclusion()` — drops a `.metadata_never_index`
  marker at the agent's Claude transcript dir so macOS Spotlight stops
  re-indexing the constantly-appended JSONL session transcripts (~18GB churn).
- `PostUpdateMigrator` backfill — existing agents get the exclusion on their next
  update; new agents get it once they have transcripts. Internal OS hygiene; no
  agent-facing API or config surface.

## Scope (honest)

This prevents FUTURE re-indexing. It does not instantly drop `mds_stores` —
Spotlight releases already-indexed content on its own schedule; forcing
immediate eviction needs a one-time `sudo mdutil -E ~/.claude/projects` the
operator runs. One of several resource-efficiency fixes (2026-06-06).

## Evidence

Unit + migration tests (both sides of every boundary: marker dropped when
transcripts exist, correct encoding, graceful no-op for a new agent, idempotent;
migration backfills/skips/idempotent). 15/15 green. `tsc --noEmit` clean.
Mirrors the existing node_modules/worktree exclusion pattern.
