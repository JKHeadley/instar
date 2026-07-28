# Agent runtime-data Spotlight exclusion — ELI16

> The one-line version: macOS was burning a whole CPU core indexing and photo-analyzing the agent's OWN runtime folder — chat images, databases, logs — none of which anyone ever searches. This tells macOS to skip them, so it stops.

## The problem (found 2026-06-06, machine pinned at load average 30)

Justin reported work had "paused." Grounding it with `ps`/`uptime` showed the machine at **load average 30** — and the top CPU consumers were not Instar sessions at all, but two macOS system processes: `mediaanalysisd` (~72-78% of a core) and `mds_stores` (Spotlight, ~28-48%). The server was so starved it couldn't even answer its own health check.

Why were they so busy? `mediaanalysisd` analyzes images; `mds_stores` indexes changing files. The agent's runtime data folder (`~/.instar/agents/<agent>/.instar/`) holds:
- `telegram-images/` — every photo a user sends (377 of them on this box) → `mediaanalysisd` runs vision analysis on each.
- `server-data/` — SQLite databases rewritten continuously by every feature → constant Spotlight re-indexing.
- `logs/`, `state/` — appended/rewritten on nearly every tick.

## What already existed (and why it wasn't enough)

Instar already drops the standard macOS `.metadata_never_index` "don't index this" marker on three things: `.worktrees/` (#588), `node_modules/` (#606), and Claude transcripts (#903). But the agent's OWN `.instar/` data — the images and databases that feed `mediaanalysisd` and `mds_stores` — was **never excluded**. That's exactly why "we thought we fixed the macOS issue but didn't": the prior fixes covered the static/throwaway trees and the transcripts, but missed the agent's own churning runtime data.

## What this adds

One more exclusion, following the exact same pattern: a new `ensureAgentDataSpotlightExclusion(stateDir)` helper drops the `.metadata_never_index` marker inside each high-churn subdir of the agent's `.instar/` data folder (`telegram-images`, `server-data`, `logs`, `state`). A `PostUpdateMigrator` migration runs it on every update, so existing agents get the relief automatically. `.instar/telegram-images/` and `.instar/server-data/` are also added to `.gitignore` (they're per-machine runtime data that should never be committed — and that keeps the markers out of git).

## Why it's safe

- The marker is the documented Apple way to say "don't index this." Harmless on non-macOS, idempotent, reversible (delete the file).
- Nothing useful is lost: nobody Spotlight-searches a downloaded chat image or a SQLite WAL. Instar reads these files directly via the filesystem, which Spotlight has nothing to do with.
- It only ever *adds* an empty marker file inside subdirs that already exist; it never deletes or moves data. A write failure is a silent no-op (the prior behavior).

## Honest scope

This is one fix in the resource-efficiency initiative. The marker stops *future* indexing/analysis; macOS only fully releases already-indexed content on its own schedule (an immediate purge needs a one-time `sudo mdutil -E` the operator runs). The other big lever — reclaiming ~300 accumulated worktrees (~100GB) — is tracked separately and gated on operator approval because it deletes checkouts.

## Evidence

Unit tests cover every boundary (marker dropped in each existing subdir; only-existing subdirs marked; `[]` for a brand-new agent with no data yet; idempotent) plus migration tests (backfills on update, skips cleanly when absent, idempotent). 22/22 green in the spotlight-exclusion suite. `tsc --noEmit` clean. Mirrors the existing node_modules/worktree/transcript exclusion pattern exactly.
