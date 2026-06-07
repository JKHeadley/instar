# Side-Effects Review - Agent runtime-data Spotlight exclusion

**Version / slug:** `agent-data-spotlight-exclusion`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Extends Instar's existing macOS Spotlight exclusion (currently covers `.worktrees/` #588, `node_modules/` #606, and Claude transcripts #903) to the agent's OWN runtime data dir (`<agentHome>/.instar/`). On a box pinned at load average 30 (2026-06-06, Justin's resource investigation), grounding showed the top CPU consumers were `mediaanalysisd` (~72-78% — analyzing the agent's `telegram-images/`) and `mds_stores`/Spotlight (~28-48% — re-indexing the constantly-rewritten `server-data/` SQLite dbs, `logs/`, `state/`). These were the remaining unexcluded churn source. Adds `ensureAgentDataSpotlightExclusion()` (reuses the generic marker-dropper) + a `PostUpdateMigrator` backfill, and gitignores the two runtime dirs that weren't already ignored.

## Decision-point inventory

- `ensureAgentDataSpotlightExclusion(stateDir)` (new, exported) — drops `.metadata_never_index` in each existing high-churn subdir (`telegram-images`, `server-data`, `logs`, `state`); returns the list created. Reuses `ensureWorktreeSpotlightExclusion` (the dir-agnostic dropper).
- `PostUpdateMigrator.migrateAgentDataSpotlightExclusion` (new, private) — runs the helper on every update, pushes an `upgraded`/`errors` entry.
- Wired into the migrate() sequence right after `migrateClaudeTranscriptSpotlightExclusion`.
- `.gitignore` — adds `.instar/telegram-images/` and `.instar/server-data/` (per-machine runtime data; `logs/`, `state/`, `telegram-inbound/` were already ignored).

## 1. Behavior change / gating

NONE that affects message flow, sessions, or any gate. The only effect is writing empty marker files into the agent's own `.instar/` data subdirs, telling macOS Spotlight + mediaanalysisd to stop indexing them. No runtime behavior of the agent changes; instar's own reads of these dirs (TokenLedger, server-data DBs, log tailing) are filesystem reads, unaffected by Spotlight indexing.

## 2. Over/under-signal

N/A — not a signal/gate. The only "decision" is whether each subdir exists (drop the marker) or not (skip). Both branches are covered by tests.

## 3. Blast radius

Filesystem only, additive, and scoped ENTIRELY INSIDE the agent's own `<agentHome>/.instar/` — unlike #903 it never reaches outside the agent home. Writes up to four empty marker files. No state mutation, no data migration, no config change. On a non-macOS host the markers are inert. The `.gitignore` additions only prevent committing per-machine runtime data (which was never intended to be committed).

## 4. Failure modes

The underlying `ensureWorktreeSpotlightExclusion` swallows write errors (`@silent-fallback-ok`) and returns false — a failed marker write just means Spotlight keeps indexing (status quo), and can never block the migration or an update. `existsSync` guards each absent subdir (brand-new agent with no data yet → returns `[]`). No throw path.

## 5. Migration parity

Covered: the `PostUpdateMigrator` backfill means existing agents get the markers on their next update (fast release cadence drops them within minutes). New agents get them once the subdirs exist. No agent-installed config/hooks/skills/CLAUDE.md change — this is internal OS hygiene with no agent-facing surface, consistent with the precedent (#588/#606/#903 also have no CLAUDE.md template line; they are not capabilities the agent surfaces to a user). No init-path call is needed because the data subdirs don't exist at init time — it would no-op; the migration is the correct single mechanism.

## 6. Scope honesty (what this is NOT)

- One fix in the resource-efficiency initiative (Justin, 2026-06-06). The marker prevents FUTURE indexing/analysis; it does NOT instantly drop `mediaanalysisd`/`mds_stores` — macOS releases already-indexed content on its own schedule, and an immediate purge needs a one-time `sudo mdutil -E` the operator runs (instar cannot run sudo). The durable guarantee is that no agent keeps feeding the churn.
- Does NOT address the ~300 accumulated worktrees (~100GB) — that is the AgentWorktreeReaper's job, gated separately on operator approval because it deletes checkouts.

## 7. Causal autopsy

Origin: **latent** (not a prior-PR regression). The agent's `.instar/` runtime data (images, DBs, logs, state) has been indexed by macOS since agents began writing it. The prior Spotlight-exclusion PRs (#588 worktrees, #606 node_modules, #903 transcripts) progressively closed the largest known trees but never extended to the agent's own data dir — which 2026-06-06 grounding (`ps`/`uptime` census during the load-30 incident) showed was the live `mediaanalysisd` + `mds_stores` fuel via `telegram-images/` and `server-data/`. This PR closes that latent gap by reusing the same marker mechanism. No behavior was broken by a prior change; an existing cost was simply never excluded.
