# Side-Effects Review - Spotlight resource hygiene (Claude transcript exclusion)

**Version / slug:** `spotlight-resource-hygiene`
**Date:** `2026-06-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

Extends Instar's existing macOS Spotlight exclusion (currently covers `.worktrees/` + `node_modules/`) to the agent's Claude Code transcript directory (`~/.claude/projects/<encoded-agent-home>`). The JSONL session transcripts grow on every turn and a busy fleet box accumulates ~18 GB of them — measured as the single largest `mds_stores` (Spotlight) CPU consumer (60-90% of a core, constantly), because Spotlight re-indexes each file on every append. Adds `ensureClaudeTranscriptSpotlightExclusion()` (reuses the generic marker-dropper) + a `PostUpdateMigrator` backfill.

## Decision-point inventory

- `ensureClaudeTranscriptSpotlightExclusion(agentHome, claudeHome?)` (new, exported) — pure-ish: computes the encoded transcript dir, drops `.metadata_never_index` if the dir exists. Reuses `ensureWorktreeSpotlightExclusion` (the dir-agnostic dropper).
- `PostUpdateMigrator.migrateClaudeTranscriptSpotlightExclusion` (new, private) — runs the helper on every update, pushes an `upgraded`/`errors` entry.
- Wired into the migrate() sequence right after `migrateNodeModulesSpotlightExclusion`.

## 1. Behavior change / gating

NONE that affects message flow, sessions, or any gate. The only effect is writing one empty marker file into the agent's Claude transcript dir, which tells macOS Spotlight to stop indexing that subtree. No runtime behavior of the agent changes; instar's own transcript reads (TokenLedger) are unaffected (Spotlight indexing is orthogonal to file reads).

## 2. Over/under-signal

N/A — not a signal/gate. The only "decision" is whether the transcript dir exists (drop the marker) or not (skip). Both branches are covered.

## 3. Blast radius

Filesystem only, additive: writes `~/.claude/projects/<encoded>/.metadata_never_index`. This reaches OUTSIDE the agent home (into `~/.claude`), which is deliberate and bounded: (a) instar already READS that exact directory (TokenLedger/CompactionSentinel), so it is not new territory; (b) the path is scoped to THIS agent's own transcript dir via the home-path encoding, never all of `~/.claude/projects`; (c) the write is a single empty marker, idempotent, reversible. No state, no migration of data, no config. On a non-macOS host the marker is inert.

## 4. Failure modes

The underlying `ensureWorktreeSpotlightExclusion` swallows write errors (`@silent-fallback-ok`) and returns false — a failed marker write just means Spotlight keeps indexing (status quo), and can never block the migration or an update. `existsSync` guards the absent-dir case (brand-new agent, no sessions). The encoding is a pure string transform with no throw path.

## 5. Migration parity

Covered: the `PostUpdateMigrator` backfill means existing agents get the marker on their next update (the fast release cadence drops it within minutes once transcripts exist). New agents get it on their first post-session update. No agent-installed config/hooks/skills/CLAUDE.md change — this is internal OS hygiene with no agent-facing surface (consistent with the precedent: the node_modules + worktree exclusions also have no CLAUDE.md template line, as they are not capabilities the agent surfaces to a user). No init-path call is needed because the transcript dir does not exist at init time (no sessions yet) — it would no-op; the migration is the correct single mechanism.

## 6. Scope honesty (what this is NOT)

- This is fix 1 of 4 in the resource-efficiency initiative (Justin, 2026-06-06). It is the biggest single lever (the 18 GB transcript churn) but does NOT instantly drop `mds_stores`: the marker prevents FUTURE re-indexing; Spotlight releases already-indexed content on its own schedule, and forcing immediate eviction needs a one-time `sudo mdutil -E` the operator runs (instar cannot run sudo). The durable guarantee is that no agent keeps feeding the churn.
- `mediaanalysisd` (macOS media/photo analysis) is a separate high-CPU process NOT addressed here and likely not Instar-triggered.

## 7. Causal autopsy

Origin: **latent** (not a prior-PR regression). The transcript-indexing cost has existed since Claude Code began writing JSONL transcripts; the recent node_modules/worktree exclusion PRs addressed the static trees but never extended to the constantly-churning transcript set, which grounding showed is the larger consumer. This PR closes that gap by reusing the same marker mechanism. No behavior was broken by a prior change; an existing cost was simply never excluded.
