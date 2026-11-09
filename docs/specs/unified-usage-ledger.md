---
title: "Unified Usage Ledger — one attributed record per model call, priced as-of its day, rolled up to the agent"
slug: "unified-usage-ledger"
author: "echo"
parent-principle: "Observable Intelligence — No Autonomous LLM Action Is Unauditable"
lessons-engaged:
  - "P18 Observation Needs Structure (one record shape for every token consumer; unpriced is loud, never $0)"
  - "P1 Structure > Willpower (capture coverage is a tested matrix, not a convention)"
  - "P3 migrations reach existing agents (dev-gate registry entry, PostUpdateMigrator text, capabilities)"
  - "P7 supervision tiers (pool pull and ingest are Tier 0 pure data transforms)"
  - "P19 No Unbounded Loops (pull backoff and breaker, bounded queue, bounded reads, retention with a size ceiling)"
  - "P20 Verify the State, Not Its Symbol (coverage and reconciliation declare corroboration and the unmeasurable case)"
  - "P24 limits are disclosed (every scan limit shows what it left out in /usage/coverage)"
  - "Substance Over Labels (cross-source dedupe on provider session id, settled only on complete data)"
  - "CodexRolloutParser.ts:14-16 — summing per-turn last_token_usage double-counts; per-request rows are deltas of the cumulative total instead"
  - "instar#2121 — large Codex rollouts blocked the event loop; the delta reader stays on the worker thread"
  - "token-audit-completeness (2026-06-11): attribution ratchet, cached-token subset column, usage-coverage tripwire"
  - "routing-control-room-spend-alerts: dated append-only price authority, priced on read at the as-of point, unpriced loud"
  - "TOKENLEDGER-* boot/backfill specs: bounded async scans, rowid backfill, scan-loop close guard"
review-convergence: "2026-11-09T22:24:16.672Z"
review-iterations: 6
review-completed-at: "2026-11-09T22:24:16.672Z"
review-report: "docs/specs/reports/unified-usage-ledger-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 1
contested-then-cleared: 1
approved: true
approved-by: "Justin (telegram topic 141063, 2026-11-09)"
---

# Unified Usage Ledger

## Problem statement

Operator directive (Justin, topic 141063 "Token Usage Tracking", 2026-11-09): track token usage **as granularly as possible**, with **as much metadata as possible** — engine, model, and **equivalent API cost at the time the tokens were used** — forming a **hierarchy tree** up to the whole agent, with many dashboard visualizations. Fleet-wide usage across an owner's agents is a separate track (topic 141067 "Instar Fleet Support") that will read this spec's per-agent interface.

Research on main @ fa4a47533 plus live readings on 2026-11-09 found:

1. **Four overlapping stores, no single record.**
   - `TokenLedger.token_events` (`src/monitoring/TokenLedger.ts:67-84`) — Claude Code transcript lines: model, input, output, cache read/write, session, cwd, a cwd-guessed `attribution_key`. No framework, machine, topic, job, account or cost.
   - `TokenLedger.codex_token_sessions` (`:121-137`) — one **cumulative lifetime total** per Codex session (deliberately, `CodexRolloutParser.ts:14-16`). Excluded from `/tokens/summary`'s main figure and from BurnDetector.
   - `FeatureMetricsLedger.feature_metrics` (`src/monitoring/FeatureMetricsLedger.ts:508-522,739-754`) — in-process intelligence calls: feature, model, framework, job, machine, tokens. No session/topic; `tokensIn` already *includes* cache reads and writes (`ClaudeCliIntelligenceProvider.ts:214-221`); the `claude -p` session id is never read; Gemini CLI and interactive-pool calls report no tokens.
   - `MeteredSpendLedger` — real dollars, pay-per-use keys only.
2. **Wrong scope.** The Claude scan root is hard-coded to `~/.claude/projects` (`src/server/AgentServer.ts:2359`), ignoring `CLAUDE_CONFIG_DIR`. Echo runs under a follow-me config dir and builds in folders outside its home, so its own sessions are largely invisible, while every other agent and test folder on the machine is counted. Live: 5.4M tokens/24h on the M5 ledger, mostly from test agents, versus ~2.2B Claude tokens/week across the pool reported by `/mobile/spend`.
3. **Nothing priced for subscription use.** The price authority (`scripts/routing-prices.manifest.json`, `src/core/routingPriceAuthority.ts`) is dated and as-of correct, but has 4 points, all pay-per-use doors, no cache-write rate, and subscription doors resolve to `subscription-zero`. Live: 879M tokens this week "no price on file". `claude -p`'s `total_cost_usd` is discarded.
4. **No hierarchy.** Rollups exist per session, project, feature, door×model and job (`/tokens/*`, `/metrics/features`, `/routing-spend/summary`, `/jobs/cost`), but none by topic, machine, framework or day over all consumers. The only pooled view (`/mobile/spend`, `mobileCapacityRoutes.ts:905`) re-asks every peer on each 15-second cache miss and stores nothing.
5. **Likely double counts.** `claude -p` calls run without hardening use the server's cwd, so their transcripts are scanned by TokenLedger while FeatureMetrics records the same call. Codex one-shots no longer pass `--ephemeral` (`openai-codex/transport/oneShotCompletion.ts:41-45`), so each writes a rollout in the project dir that the rollout scan also reads.

## Goals and non-goals

**Goals**
- One record per model request (or the finest grain a source offers, labeled), for every token consumer the agent runs, with a fixed attribution shape and one token arithmetic.
- Equivalent API cost at the published price in force on the day the tokens were used.
- Stored rollups along the tree request → session → {topic | job run | feature} → machine → agent, by hour and day, unified across the agent's machines.
- One read interface (`/usage/*`) that the console and, later, the fleet layer consume.
- Console visualizations that answer "where are the tokens going?" without reading tables.

**Non-goals**
- Fleet aggregation across agents (topic 141067).
- Spending caps or enforcement (MeteredSpendLedger / money layer stays the authority for real dollars).
- Changing `TokenLedger`, its tables, its routes, `/jobs/cost`, or BurnDetector. Their scope bug (problem 2) gets its own fix (Left behind), so burn alerts do not change underneath operators as a side effect of this work.

## Proposed design

### Stores

- **`usage-ledger.db`** (in `server-data/`, beside `token-ledger.db`, which git-sync already excludes; WAL, `auto_vacuum=INCREMENTAL` from creation, opened with the existing native-heal wrapper) holds everything that must change together: raw rows (`usage_events`), `session_bindings` (which are also this agent's spawn records), per-file source checkpoints, the dedupe `pairs` table, rollups, the pooled copies of peers' rollups and bindings, and the database's `generation_id` and `machine_id`. Every event insert, `counted` flip, checkpoint advance and rollup delta commits in **one SQLite transaction in one file**, so a crash can never leave them out of step.
- **`usage-ledger.snapshot.db`** (also in `server-data/`) — a slim, consistent copy of what an import needs: this machine's day rollups, `session_bindings`, source checkpoints, open and recent `pairs`, `generation_id`, `machine_id`, agent id and snapshot time. Hour and session-day rollups and pooled peer rows are not included (they are detail, or re-pulled). It is written hourly on a worker thread with its own read-only connection; all pages are read inside **one read transaction** (so checkpoints and rollups are mutually consistent), copied table by table in rowid-ranged pages into a temp database in `journal_mode=DELETE`, then renamed into place. This file, and only this file, is in BackupManager's default set (`server-data/usage-ledger.snapshot.db`); raw rows are never in backups. `.instar/server-data/` is already excluded from git-sync (`FileClassifier.ts:149`, `.gitignore:23`), so neither file travels between machines; a PostUpdateMigrator step only adds the `.gitignore` line for agent projects that lack it.
- **Restore rule.** The live database is always the truth while it exists. Restoring the snapshot file over a live database therefore changes nothing, and coverage says "snapshot restore ignored — live database is authoritative". At open, before ingest or the snapshot writer starts, the snapshot is imported only when the live database is missing, empty, or recreated by native-heal, and only if its agent id is this agent's (another agent's snapshot is always refused). If its `machine_id` is this machine's, or a predecessor id of this machine in the identity-change ledger: rollups, bindings, checkpoints and pairs are loaded and **re-keyed to the current machine id** (the old id kept in a column), a new `generation_id` is created, and ingest resumes from the checkpoints; the holder treats a predecessor id linked in the identity-change ledger as the same machine and replaces, not adds, its pooled rows. If its `machine_id` is another machine's that is not a live pool member (read from the mesh state on disk at open) and no pool holder already has pooled rows for that id — in practice a single-machine agent moved to new hardware: its day rollups are imported as a **local frozen slice** under the original `machine_id`, never put in the replication stream, and its checkpoints and pairs are dropped, because they describe another disk. If a pool holder has that machine's rows, or it belongs to a live pool member, it is refused. Every case is listed in coverage. (The `machine_id` check guards against mistakes, not forgery; anything that can write `server-data/` can write any value.) The writer never replaces a snapshot while the live database is empty. Usage after the snapshot that is still in source files is ingested normally; content before a checkpoint is re-read for detail only (see Replay safety). The import and its time window are listed in coverage. `intelligence-call` rows after the snapshot are lost in that case, which is accepted and stated.

`state-coherence-registry.json` entries, with their real paths: `server-data/usage-ledger.db` as `coherent-on-demand` over `peer-http` (its rollups and bindings replicate through the pull; raw rows are proxied on read; the file never travels), with retention as in Retention and growth; and `server-data/usage-ledger.snapshot.db` as `machine-local` (a backup of this machine's own ingest state, regenerated hourly).

### The record: `usage_events`

| Column | Meaning |
|---|---|
| `observation_id` | Primary key: hash(source, source-native id). Source-native ids: Claude transcript `requestId`; Codex (rollout uuid, envelope ordinal); intelligence call: the funnel's `call_id`. |
| `correlation_key` | (framework, provider session id) — recognises the same work seen by two sources. Claude: `session_id` from the transcript or the `claude -p` JSON result. Codex: `thread_id` (from `thread.started`, already parsed in `openai-codex/observability/sessionId.ts`) or the rollout's session id. |
| `source_pos` | Position of the row in its source file (byte offset of the line), null for intelligence calls; compared with the file's checkpoint. |
| `grain` | `request` (one provider request) · `invocation` (one funnel call, possibly several requests) · `session-total` (only a session aggregate exists). |
| `ts` | Request time (UTC ms) from the source's own timestamp; file mtime only as fallback, counted in coverage. |
| `source` | `claude-transcript` · `codex-rollout` · `intelligence-call` · `pi-session` · `grok-session` · `gemini-session` |
| `framework` | `claude-code` · `codex-cli` · `pi-cli` · `grok-build` · `gemini-cli` · `api` |
| `model` | Provider model id as reported. The pricing family is resolved from it on read (mapping in the price manifest), so a corrected mapping applies to all history. |
| `machine_id` | Pool machine id. |
| `account_id` | Subscription-pool account or API key label; null when unknown. |
| `session_id`, `session_kind`, `parent_session_id` | Provider session id; `interactive` · `job` · `internal` · `subagent`, taken from the binding covering the row's time (the funnel writes `internal` bindings; a row with no binding is `interactive` and unattributed); parent for subagent transcripts. |
| `scope_basis` | Why this row belongs to the agent: `spawn-record` · `cwd`. |
| `topic_id`, `job_slug`, `run_id`, `feature` | Attribution (see Attribution). Null when unresolved. |
| `tok_input`, `tok_cache_read`, `tok_cache_write`, `tok_output`, `tok_reasoning` | See Token arithmetic. Null = not reported, distinct from 0. |
| `counted` | 1 when this row contributes to totals; 0 when another row for the same work is counted instead. |
| `reported_usd`, `reported_basis` | Dollar figure the provider returned, and what it means: `actual` (metered charge, `claude -p` `total_cost_usd`) or `plan-rate` (e.g. Grok's plan-rate dollars, `grok-build/transport/oneShotCompletion.ts:20`). |

Equivalent cost is not stored on the row; it is computed on read (Slice 3).

### Token arithmetic (one meaning for every source)

The five token columns are **disjoint**: `tok_input` is fresh (uncached) input only; `tok_cache_read` and `tok_cache_write` are separate; `tok_output` includes reasoning; `tok_reasoning` is a **subset of `tok_output`**, kept for display and never priced separately. Total tokens = input + cache_read + cache_write + output.

Per-source mapping, each with a fixture test:
- **Claude transcript:** `input_tokens` → input; `cache_read_input_tokens` → cache_read; `cache_creation_input_tokens` → cache_write; `output_tokens` → output.
- **Codex:** `input_tokens` includes cached input, so input = `input_tokens − cached_input_tokens`; cache_read = `cached_input_tokens`; cache_write = null (not reported); output = `output_tokens`; reasoning = `reasoning_output_tokens`.
- **Intelligence call (Claude):** split from the provider's usage block instead of the folded `tokensIn` (the provider change is in Slice 2).
- **pi / Grok / Gemini:** mapped where the framework reports the parts; any part it does not report is null.

### Membership: which sessions belong to this agent

One rule for every source:
1. **Spawn record** — the session id is in this agent's spawn records (`scope_basis=spawn-record`). Spawn records are the `session_bindings` rows, written by the agent for every session it starts, wherever its cwd is (builder worktrees, other repos), storing the session id, the cwd and the framework config root. A hook-reported session id becomes a spawn record only when its transcript's own `cwd` matches the cwd of the session that reported it; otherwise that transcript falls to the cwd rule.
2. **Otherwise, cwd** — the transcript's own `cwd` field (not the encoded directory name, which is ambiguous) lies under the agent's home or project dir, and not under another registered agent's home nested inside it; the longest registered path wins (`scope_basis=cwd`).
3. **Otherwise** not a member; counted as skipped in coverage.

Roots are seeded from the server's own `CLAUDE_CONFIG_DIR`, the default `~/.claude`, every subscription-pool account home, `$CODEX_HOME`, and the pi, Grok and Gemini session dirs, plus any further root named in a spawn record; `/usage/coverage` lists each root and where it came from. The directory scan may use a directory name only to **rule a directory in** (it belongs to a spawn record, or its name is consistent with a cwd under a registered path); it never rules a spawn-record directory out. Rows counted on the cwd rule alone are listed in coverage.

### Slice 1 — Capture of Claude transcripts

- The reader opens only `<configDir>/projects/**/*.jsonl`, does not follow symlinks, and descends at most 3 levels (`projects/<project>/<session>/subagents/*.jsonl` is exactly 3, checked on disk). Deeper files are counted in coverage, not read.
- **Spawn records and bindings** are written by the server's existing handler that records a session's `claudeSessionId` from the SessionStart hook (`SessionManager.setClaudeSessionId`, `SessionManager.ts:3327`), so no hook script changes. Each new session id seen for a tmux session — first start, `/clear`, restart, resume — opens a new binding with `valid_from` at the hook time and closes the previous one. Headless spawns that pin `--session-id` (`SessionManager.ts:4723-4730`) write theirs at spawn. In-process one-shots write theirs from the funnel (Slice 2). Job sessions additionally keep TokenLedger's own `job_sessions` write exactly as it is; the new store writes its own binding alongside (a second write, not a move).
- **Subagent transcripts** are tagged `session_kind=subagent` with `parent_session_id`.
- **Scan budget:** one per-tick file budget (default 500 files, the existing TokenLedger value) shared across all roots, consumed round-robin, with a per-root cursor. The first-boot backfill uses the existing 30-day file-age window; files outside it are counted in coverage.
- Ingest uses `INSERT OR IGNORE`, and a row contributes to the rollups only when it was actually inserted (`changes() = 1`) **and** its `source_pos` is beyond its file's checkpoint (see Replay safety).

### Slice 2 — Every source, deduplicated

- **Codex:** per-request rows are the **deltas of `total_token_usage`** between consecutive `token_count` events in a rollout, skipping events whose total did not change (repeated rate-limit refreshes). This keeps the parser's documented reason for not summing `last_token_usage` (`CodexRolloutParser.ts:14-16`). Key: (rollout uuid, envelope ordinal); `ts` from the envelope timestamp. The rollout's checkpoint stores its byte offset and last-seen total, so a re-read resumes, not replays. The reader runs on the existing rollout worker thread (instar#2121) and hands rows to the main thread for the batched insert. A resumed or forked rollout whose first `token_count` already carries usage stores that first total as its baseline `B` and starts its deltas from it; that inherited usage is counted in the parent rollout when the parent is a member, and otherwise listed in coverage as `inherited-uncounted` (never counted twice). Check per rollout: the sum of deltas equals final total `F − B`; a mismatch is shown in coverage.
- **Intelligence calls:** the funnel (`CircuitBreakingIntelligenceProvider`) hands an `invocation` row, plus a spawn record and binding for the provider session id it read, to a bounded in-memory queue (default 10,000 entries; oldest dropped when full, dropped count in coverage) that the ledger flushes in its batched transaction; the write can never throw into, or block, the calling decision. Every funnel one-shot records the provider session id it receives — Claude `session_id` (with the split usage block and `total_cost_usd`) from the `claude -p` JSON result, Codex `thread_id`, Grok `sessionId` (`grok-build/transport/oneShotCompletion.ts:78`). A framework whose one-shot returns no id either writes no session files (pi runs `--no-session`) or has its invocation rows listed in coverage as `uncorrelated`. The provider's usage callback is extended to carry this: session id, the five token parts, reported dollars with their basis, and start and end times. One-shot paths never resume a provider session, so each invocation has its own session.
- **Cross-source rule.** Any member row whose `correlation_key` matches an `invocation` row takes part, whatever its `scope_basis`. Rows sharing a `correlation_key` describe the same work:
  - With no invocation row (none made, or dropped from the queue), the file rows are simply counted.
  - Once an invocation row exists and the pair is **unsettled**, the invocation stays counted and the file rows are held with `counted=0`.
  - If more than one invocation shares a key (not expected, see above), each invocation is paired only with file rows whose `ts` falls inside its own start–end interval; rows outside any interval, or inside two, leave the invocations counted, and the key is listed as `dedupe-ambiguous`.
  - The pair **settles** once its file's checkpoint has reached the end of the file past the invocation's end time and no new rows have arrived for the settle window (default 2 minutes). At settlement the token sums are compared: if they agree within rounding, the file rows become counted and the invocation is set `counted=0`; if not, nothing changes and the pair is listed as `dedupe-disagreement`.
  - A file row that arrives after settlement re-opens the pair, and it settles again the same way.
  - Every flip is applied with rollup deltas in the same transaction, and only for rows that were beyond their file's checkpoint when they were inserted, so arrival order never changes the final result.
  - Pair state lives in the `pairs` table: key, the invocation's token totals and attribution, the **running file-side token totals held so far, by rollup key**, which side is counted, and whether it is settled. Settlement moves these stored totals between rollup keys, never re-reads raw rows, so a pair that was open at snapshot time settles correctly after an import even though the rows held before the snapshot are gone. An invocation row is never pruned while its pair is open.
  - Only tokens move at settlement. The invocation's reported dollars and its call count of 1 stay counted as invocation-level facts whichever side holds the tokens, because file rows carry no reported dollars; a rebuild sums tokens over `counted=1` rows and reported dollars and calls over all invocation rows.
  - After a successful settlement, a late file row is simply counted (the file side is already the counted side); there is nothing to re-compare. In a `dedupe-disagreement` pair the invocation stays counted, and the file side's tokens beyond the invocation's total are shown in coverage and on the headline as **disputed** usage — visible as uncertain, never silently dropped.
  - After a snapshot import, a settlement delta aimed at an hour or session-day row that no longer exists (those are not in the snapshot) is skipped for that rollup and listed; day rollups always receive it.
  - Attribution precedence: a time-matched binding wins; the invocation's `feature`, `job_slug` and `run_id` only fill fields that are still null.
- **pi, Grok, Gemini sessions:** readers for each framework's session files where they carry per-request usage; otherwise a `session-total` row, or a row with null token columns that is counted in coverage as "no counts reported".

### Attribution

`session_bindings`: (session id, framework, session kind, cwd, topic id, job slug, run id, account id, machine id, valid_from, valid_to). Rows are joined to bindings **by the request's own `ts`**, never by the current registry state, so a late scan or backfill cannot attach old rows to whatever topic owns a tmux name today. A request with no covering binding keeps null fields. The account comes from the session's `subscriptionAccountId` (`SessionManager.ts:2773`), captured in the binding. Bindings are replicated through the pool pull, so a conversation moved to another machine is attributed the same way there.

### Replay safety

Each source file has a checkpoint: (root, path, file identity — inode, size and a hash of the first 256 bytes, as TokenLedger already uses, plus device and birth time where the filesystem reports them — incorporated byte offset, and for Codex the last total and baseline). The checkpoint means "everything before this offset is already in the rollups", and it advances in the same transaction as the rows it covers.
- A row read from before its file's checkpoint (a lost scan cursor, a re-read after raw rows were pruned, or the rescan after a snapshot import) is stored for detail if it is missing, but never added to the rollups again.
- A file whose identity changed, or whose size is now below its checkpoint offset, gets a new checkpoint from zero.
- A row whose `ts` is earlier than its file's birth time and whose `observation_id` is not already present (history copied into a new file, e.g. a resumed session, whose originals were pruned or never seen) is stored for detail but not counted; its tokens are listed in coverage as `copied-history (unresolved)` and the headline shows them as uncertain, not as counted or as zero. Where the filesystem reports no birth time, this rule is skipped for that file, dedupe relies on `observation_id`, and the file is listed in coverage.
- Pruning raw rows never touches checkpoints; a checkpoint is dropped only when its file no longer exists (one small row per file).
- Intelligence-call rows have no file; they are keyed by `call_id` and never arrive twice.

### Slice 3 — Equivalent API prices

- A new door class `list-equivalent` is registered in the price authority, with one door per provider in use (`anthropic-list`, `openai-list`, and others as needed). Points add a `cacheWritePerMtok` field alongside the existing cached-input rate. A manifest `modelFamilies` table maps reported model ids to a family and its list door.
- **Priced on read, as of the day of use.** Every figure — a request, a session-day, an hour or a day bucket — is valued at the manifest point in force on that bucket's UTC day. Points are UTC-day aligned by the price authority's accounting policy, so day-level pricing matches that policy exactly; a provider price change that takes effect at another hour is approximated to its UTC day, as the routing-spend view already discloses: `equiv_usd = input·p_in + cache_read·p_cache_read + cache_write·p_cache_write + output·p_out`. A bucket with tokens in any column whose rate is missing is `unpriced` (shown with its token count), never partially priced. This formula is new code; `reportingCost` (`routingPriceAuthority.ts:454`, which assumes cached ⊂ input) is not reused.
- Because nothing is valued at write time, a price added later (FD1) or a backdated correction applies to all history automatically, including rollups whose raw rows are pruned. The manifest's append-only history records what changed and when.
- `equiv_usd` uses **manifest points only** — never the machine-local overlay or observed-price cache — so the same usage is valued identically on every machine.
- List-equivalent doors are exempt from the freshness SLA: a published list price stays in force until a later point supersedes it. The console shows each point's effective date.
- **Where the numbers come from:** the building agent copies each price from the provider's published pricing page into the manifest with `sourceUrl` and `retrievedAt`, in the same PR; the human PR review is the review. Models with no published API price get no point and stay `unpriced` (FD1).

### Slice 4 — Rollups, pool view, read API

**Rollups** (in `usage-ledger.db`, updated as signed deltas in the same transaction as each counted change):
- `usage_rollup_hour`: key (bucket, machine, framework, model, session_kind, topic, job, run, feature) — `run` keeps separate runs of the same job apart for 400 days after raw rows age out.
- `usage_rollup_day`: the same key without `run`, so the table kept forever does not grow with job frequency.
- `usage_rollup_session_day`: key (day, machine, session_id, framework, model, topic, job, feature) — a session that changes model or binding within a day gets one row per combination, and session totals sum them.
- `session_kind=internal` rows (one-shot calls, each its own session) go to the hour and day rollups only, where `feature` and `job` identify them; their per-call detail stays in raw rows. This keeps session-day growth proportional to real conversations.
- Key columns are `NOT NULL`, with the sentinel `''` for "none" (SQLite treats NULLs as distinct in keys); reads map `''` back to null. Each row carries the five token sums, a count of calls that did not report each token column (so a total built over missing values is shown as partial, not complete), reported dollars split by basis (`reported_actual_usd`, `reported_plan_rate_usd`), call count and `change_seq` — a per-database counter that increases on every insert or update, indexed on every replicated table. Deltas are pre-aggregated per batch, so each batch makes one upsert per rollup key.
- Rollups are rebuildable from `usage_events` exactly within the raw retention window (shorter if the row ceiling has pruned).

**Pool view:**
- Each machine serves `GET /usage/rollup?after=<change_seq>` returning its `generation_id` and its rollup and binding rows in `change_seq` order (one ordered stream across those tables), with a page cap of 5,000 rows and 5 MB — machine-to-machine only (pool machine auth), never on the phone allowlist. The holder stores each peer's `(generation_id, last change_seq)` and advances it only after a page is committed, so a page interrupted midway is re-read and applied idempotently (rows replace by key). When a peer's `generation_id` changes (its database was recreated or imported from a snapshot), the holder discards that peer's pooled rows for buckets at or after the peer's snapshot time (sent in the page header) and keeps the older ones — so hour and session-day detail from before the snapshot, which the slim snapshot does not carry, survives in the pooled view — then pulls the peer again from zero, draining pages with a yield between them; that peer shows `warming` until the re-pull reaches its newest `change_seq`, and generation changes are listed in coverage.
- The lease holder keeps peers' rows in `usage_pool_rollups`, persisted. Peer input is validated at the edge: page caps, integer token counts ≥ 0, finite dollar values, strings ≤ 256 characters (a longer cwd in a binding is truncated, not refused; pooled bindings are used for attribution only, never for membership), and a peer may only write rows under its own authenticated machine id. An invalid row is skipped and listed in coverage, and the cursor still advances past it, so one bad row can never stall a peer. Each machine prunes hour rows on the same 400-day rule and bindings 90 days after they close, and the holder applies the same rules to its pooled copies; nothing else is deleted, so deletions never need replicating. Pooled rows are indexed on (grain, bucket, machine) and (day, session_id).
- Cadence and brakes: a background pull every 5 minutes; a read that finds a peer's data older than 60 seconds returns the cached data at once and triggers a single-flight background pull. Per-peer exponential backoff up to 30 minutes; after 3 consecutive failures the peer shows `not-reached` with the reason, and it recovers on the next success. Each machine's slice carries its last successful pull time.
- On lease handoff the new holder pulls every peer eagerly; until each answers it shows `warming` (distinct from `not-reached`), and its persisted cache from any earlier tenure is used meanwhile.
- A standby answers `/usage/*` by proxying to the holder; when the holder cannot be reached it answers from its own local rollups, labeled as this machine only.
- Raw per-request rows are read only on the machine that holds them: `GET /usage/events?session=` (session id validated for length and characters) is proxied to the owning machine, capped at 500 rows.
- Supervision: the ingest, the pull and pruning are Tier 0 — pure data transforms with no LLM and no outward action.

**Read API** (`/usage/*`, bearer auth only):
- `GET /usage/summary?since=&grain=` — agent totals plus per-machine, with not-reached and warming machines named.
- `GET /usage/tree?since=&by=&parent=` — nested nodes (tokens, equivalent cost, unpriced share), at most 3 levels per response. Each node returns at most 20 children by cost plus an "other" node; the session level is returned only beneath a chosen parent node.
- `GET /usage/series?since=&grain=hour|day&split=model|framework|machine`.
- `GET /usage/top?dim=topic|job|session|feature&limit=`.
- `GET /usage/coverage` — per source and root (with its origin): files scanned / skipped / pending / out of window / too deep, null-token share, unattributed share, cwd-only share, unpriced share, settled and unsettled pairs, dedupe disagreements and ambiguities, Codex delta mismatches and inherited-uncounted usage, queue drops, snapshot imports.
- Parameters are validated against enums. Windows are clamped by grain: hour ≤ 14 days, day ≤ 400 days, `top` ≤ 90 days, session-level (`top?dim=session`, session tree nodes) ≤ 31 days. `limit` defaults to 25, max 200. Reads go through the server's existing request rate buckets.

**Phone:** `GET /mobile/usage` (owner phone only, like `/mobile/spend`) shows totals, series and top topics/jobs/features by name, with no account, session or machine ids. The machine that receives the phone's request checks the device and role, fetches the bearer `/usage/*` data from the holder itself, and trims it locally before replying; the holder's untrimmed response is never passed through.

This interface is the contract the fleet track reads per agent.

### Slice 5 — Console

On the existing "What thinking costs" page (`dashboard/console/costs.js`), in this order:
1. Headline: tokens and equivalent cost for the window, with the unpriced share and any not-reached or warming machines stated next to it.
2. Usage over time, stacked by model or framework (toggle), hour/day grain.
3. Drill-down tree (sunburst) agent → machine → framework/model → topic/job/feature → session; a session opens its request rows.
4. Top topics, jobs and features by equivalent cost, each linking to its detail.
5. Cache hit rate over time; machine comparison.
6. A coverage strip: what share of tokens is attributed and priced, which sources report no counts, and anything unmeasured shown as unknown.

Charts follow the console's existing light/dark tokens and work at phone width.

### Retention and growth

A busy agent is expected to make on the order of 500k requests a week across its five machines, so about 100k a week on a busy machine. With the primary-key hash, correlation key and two indexes (`(ts)`, `(session_id, ts)`), a raw row is estimated at 400–600 bytes, so roughly 40–60 MB a week per busy machine. `usage_events` is pruned after 90 days, and also oldest-first while it holds more than 4 million rows on a machine (a row counter kept in the same transaction as each insert and prune, so the check never scans the table) (about 2 GB at the estimated row size; the ceiling counts raw rows only, because raw rows are the only data that ceiling-pruning can remove); `incremental_vacuum` runs after each prune batch so the file shrinks. `usage_rollup_hour` and `usage_rollup_session_day` are pruned after 400 days, and closed bindings and settled pairs after 90 days. Day rollups and live checkpoints are kept. Durable growth after the raw window: day rollups (bounded by distinct machine × framework × model × topic/job/feature combinations per day, a few thousand rows a day) and session-day rollups for a year (conversations, not one-shots: a few thousand a day across the pool) — plus hour rollups for 400 days. At about 300 bytes per rollup row (nine key columns, thirteen sums, the key index): a busy machine with 1,000 distinct day keys a day adds about 0.3 MB a day of day rollups, ≈110 MB a year; hour rollups, at up to roughly 10× the day rows once `run` is included, reach about 1 GB at their 400-day horizon; session-day rollups for conversations add tens of MB. The backed-up snapshot holds day rollups, bindings, checkpoints and open pairs only — about 100 MB after the first year on such a machine, growing about that much a year — and BackupManager keeps up to 20 copies, copying it synchronously on each backup. The snapshot's size and copy time are shown in coverage, and the snapshot copy is time-bounded; when the snapshot passes 500 MB, coverage flags it so retention of day rollups (FD2) can be revisited. Pruning runs in bounded batches on the ledger's poll, yielding between batches. These defaults are FD2.

## Measurement declarations (P20)

| Symbol read | State it claims | Independent corroboration | When unmeasurable |
|---|---|---|---|
| Sum of `counted` rows | Tokens the agent actually used | Codex: final cumulative total per rollout. Claude: per-root file counts scanned vs present, and directional agreement with the subscription usage windows already read by `/mobile/spend`. | Shown as `unknown`, never 0, for any root not yet fully scanned |
| Coverage shares (null-token, unattributed, unpriced, cwd-only) | How complete the labeling is | The row counts behind each share are shown alongside | A share over zero rows is `unknown`, not 0% |
| Per-machine pool slice | That machine's usage | Last successful pull time and `change_seq` | `not-reached` / `warming`, and the headline names it |
| Dedupe settlement | Two rows are the same work | Token-sum agreement on complete data | Unsettled pairs count the coarser row; disagreement leaves rows unchanged and is listed |

The live reconciliation re-parses the same files, so it cannot see calls the files never recorded; the file-count and subscription-window checks are the corroboration for that direction.

## Coverage and correctness tests

- **Capture matrix:** for each source × session kind (interactive, job, internal, subagent), fixtures produce exactly the expected rows, with the right grain and attribution, null vs zero preserved; includes a topic session after `/clear` and a job session without a pinned id.
- **Token arithmetic:** one fixture per source asserts the disjoint mapping and the valuation formula, including a Claude row with small input and large cache reads.
- **Scope:** two agents' transcripts on one machine; a nested agent home; a sibling directory sharing the home's encoded prefix; a builder worktree outside the home with a spawn record; a non-default `CLAUDE_CONFIG_DIR`; a hand-started session in the project dir; Codex and non-Claude sources. Each row lands with the right agent and `scope_basis`.
- **Dedupe:** a multi-request `claude -p` invocation (hardened, and unhardened in the server's cwd), a Codex one-shot and a Grok one-shot, each seen by funnel and file, with the file ingested in several chunks, in both arrival orders and on replay: counts once after settlement, keeps `session_kind=internal`, writes no session-day row, and keeps its reported dollars; a sum disagreement is listed and changes nothing; a dropped invocation leaves the file rows counted.
- **Codex deltas:** repeated `token_count` events with unchanged totals add nothing; the delta sum equals `F − B`; a re-read of an unchanged rollout adds nothing; a forked rollout's inherited usage is counted once (in the parent) or listed as inherited-uncounted.
- **Attribution:** a row scanned after its tmux name was reused by another topic joins to the topic it had at request time; an invocation's attribution never overrides a time-matched binding.
- **As-of pricing:** buckets on either side of a price change value at their own day's point; a point added later prices earlier unpriced buckets, including days whose raw rows are pruned.
- **Rollup consistency:** two rows with "none" dimensions share one rollup row; rollups equal a fresh aggregation of `usage_events` for random windows inside the raw window, including after settlement changes.
- **Replay safety and restore:** prune then re-read an old file adds nothing; a session resumed into a new file after its raw rows were pruned adds only its new requests; a file appended to long after its last read resumes from its checkpoint; a crash between an event insert and its rollup delta cannot happen (one transaction) and is asserted by killing the writer mid-batch; restoring the snapshot file over a live database changes nothing; deleting the live database and importing the snapshot, with source files still holding usage before and after the snapshot and with a dedupe pair open at snapshot time, yields the same totals as before; a snapshot from a live pool member is refused, one from a replaced machine imports as a frozen slice, and one from this machine's predecessor id imports normally; a dedupe pair with held file tokens at snapshot time settles to the right total after import; a git-sync staging pass excludes both files; a ceiling-driven prune stops at 4 million raw rows.
- **Pool:** one transaction updating more rows than the page cap is pulled completely; an interrupted page is re-applied without double counting; a peer whose database is re-imported (new `generation_id`) is re-pulled from zero and its later changes appear; a peer that always fails reaches `not-reached` with backoff and no busy loop; a peer sending negative, oversized or foreign-machine rows is refused; a lease handoff shows `warming`, then the full view.
- **Reads:** a tree over the longest allowed window stays within the node caps; out-of-range windows are clamped.
- **Auth:** `/usage/*` refuses device-signed requests; `/usage/rollup` refuses non-machine callers; `/mobile/usage` refuses member and guest phones, including through a standby, and its response through a standby contains no ids.
- **Live reconciliation:** on a running agent, an independent re-parse of a day's raw files (a separate code path from ingest) is compared with `/usage/summary` for that day; differences are listed by row, and the build is not called done while one is unexplained.

## Rollout

Everything ships behind `usage.ledger.enabled`, registered in `src/core/devGatedFeatures.ts` (on for the development agent, dark on other installs). The development agent runs it until the live reconciliation is clean and every machine in its pool has been reached by the pool view. Turning it on for other installs is a separate release decision after that.

## Maturation plan

- **test-agent-live:** Run the capture-matrix, token-arithmetic, scope, dedupe, Codex-delta, replay/restore, pool and auth suites against fixture homes, then on a throwaway test agent with real Claude and Codex sessions, a one-shot funnel call of each framework, a forced snapshot import and a two-machine pull.
- **dev-agent-live:** Enable `usage.ledger.enabled` on Echo across all of its machines. Run the live reconciliation daily: an independent re-parse of each day's source files compared with `/usage/summary`, plus the per-root file counts and the subscription-window check. Every unexplained difference is a defect to fix before graduation.
- **graduation criterion:** Seven consecutive days on Echo with a clean live reconciliation, every pool machine reached by the pool view, zero dedupe disagreements that are not explained, and the console page reviewed by the operator at desktop and phone width.
- **fleet:** After graduation, a separate release decision (FD7) turns `usage.ledger.enabled` on by default for other installs; the fleet-wide multi-agent view is the separate Instar Fleet Support track.
- **dark-window:** Dark on other installs until graduation, bounded to 30 days after the dev-agent enable; if graduation is not met by then, the failing checks are reported in topic 141063 with the reconciliation evidence rather than the feature sitting dark silently.
- **ladder:** usage.ledger

## Existing agents on update

- `devGatedFeatures.ts` entry for `usage.ledger.enabled` with its justification.
- A PostUpdateMigrator text block adding the `/usage/*` routes to CLAUDE.md and the capabilities index, so existing agents can find them.
- `/mobile/usage` added to the phone allowlist as an owner-only rule.
- The `state-coherence-registry.json` entries, `server-data/usage-ledger.snapshot.db` in the BackupManager default set, and the `.gitignore` line for `.instar/server-data/` where an agent project lacks it (following `migrateSkillLearningGitignore`, `PostUpdateMigrator.ts:3730`).

## Rollback

Each slice is additive. Turning `usage.ledger.enabled` off stops ingest, the binding writes, the funnel queue, the pool pull, snapshots and pruning, and hides `/usage/*` and `/mobile/usage`; both files stay on disk and inert. `TokenLedger`, `/tokens/*`, `/jobs/cost`, `/metrics/features`, `/routing-spend/*` and BurnDetector are not changed by this spec at any point. Price points are append-only; a bad point is corrected by a later point, and because pricing happens on read the correction applies everywhere at once.

## Multi-machine posture

- Rollups and `session_bindings` — **unified**: each machine's rows are replicated to the lease holder by the `change_seq` pull with `generation_id` (Slice 4) and served from any machine (standbys proxy to the holder).
- `usage_events` raw rows — **proxied-on-read**: per-request rows are fetched from the machine that holds them (`/usage/events`, proxied), so every machine can show any session's requests. The rollups carry every figure the views need.
- Price points — **unified**, shipped in the repo manifest; equivalent cost never consults machine-local price data.
- Source checkpoints, `pairs` and the snapshot file — internal ingest state of the unified rollup surface, not separate surfaces: they describe source files on this machine's disk, the data they produce converges through the rollup pull, and they are never served to the operator on their own.
- Console links — the console reads `/usage/*` from whichever machine serves it; no machine-specific URL is generated.

## Decision points touched

- **Agent-scope membership** — `judgment-candidate`. Floor: the deterministic precedence in Membership (spawn record, then the transcript's own cwd under a registered path with the longest path winning, otherwise not a member). Conservative default: not counted, and counted as skipped in coverage. Arbiter: the `scope_basis` column, the cwd-only share and the multi-agent claims list in `/usage/coverage`. No LLM is involved; the floor is the whole decision in this spec.
- **Cross-source dedupe** — `invariant`; basis: enumerable-domain; evidence: three grains in a fixed order, matched on a provider session id both sides record, settled only on complete data, re-opened by late rows, and left unchanged on disagreement.
- **Price point selection** — `invariant`; basis: external-constraint; evidence: the provider's published rate for that model family on that UTC day, from the append-only repo manifest; no point yields `unpriced`.
- **Pool pull cadence, freshness and backoff** (5 min, 60 s, 30 min ceiling, 3 failures to `not-reached`) — `judgment-candidate` config defaults under `usage.pool`; floor: paging, backoff and the breaker always apply; basis: the 60 s and 15 s pool-read caches already used by `/pool` reads and `/mobile/spend`.
- **Snapshot size flag** (500 MB) — `judgment-candidate` config default; floor: the flag only informs, it never prunes; basis: twenty backup copies at that size approach 10 GB.
- **Read bounds** (limit 25 / max 200; 20 children and 3 levels per tree response; hour ≤ 14 d, day ≤ 400 d, top ≤ 90 d, session ≤ 31 d; 500 event rows; 5,000-row / 5 MB pages; 256-character strings) — `judgment-candidate` config defaults under `usage.reads`; floor: some bound always applies and cannot be configured away, because an unbounded read on the server's single event loop stalls every other route; the numbers themselves match what the console displays (two weeks of hourly points, about 13 months of days, one month of sessions) and are tunable.
- **Retention** (90 days raw, 4 million raw rows per machine, 400 days hourly and session-day, closed bindings and settled pairs 90 days) — `judgment-candidate` defaults under `usage.retention`; floor: day rollups are never pruned, so no total is ever lost; basis: the growth estimate in Retention and growth.
- **Snapshot cadence** (hourly) — `judgment-candidate` config default; floor: an import is only needed when the live database is lost, and the import window it leaves is listed in coverage; basis: bounds `intelligence-call` detail lost on such a loss to about an hour.
- **Scan limits** (3 directory levels, 30-day backfill window, 500-file shared per-tick budget, 10,000-entry funnel queue) — `judgment-candidate`; floor: whatever a limit leaves out is counted in `/usage/coverage`; basis: the measured subagent layout (exactly 3 levels) and the existing TokenLedger backfill window and per-tick budget.
- **Dedupe settle window** (2 minutes after the file is read to its end) — `judgment-candidate` config default; floor: a late row re-opens a settled pair, so settling early can delay but never lose or double a count.

## Frontloaded Decisions

- **FD1 — Unpriced models stay unpriced.** A model with no published API price is shown as `unpriced` with its token count, never estimated. cheap-to-change-after: pricing happens on read, so adding a clearly labeled estimate or a real price later applies to all history and rewrites nothing.
- **FD2 — Retention defaults.** Raw request rows 90 days (or 4 million rows per machine, whichever comes first), hourly and per-conversation daily rollups 400 days, daily rollups kept. Only detail is ever deleted; every daily total survives. Configurable per agent.
- **FD9 — Nothing gates or notifies.** No gate, block or routing decision is added; nothing here changes which calls run, and no operator notice is added.
- **FD3 — Equivalent cost is labeled as such everywhere.** Surfaces show "equivalent API cost" for list-price valuation and the reported figure with its basis (`actual` or `plan-rate`), never a merged figure.
- **FD4 — Legacy stores and routes are not changed.** `TokenLedger`, `/tokens/*`, `/jobs/cost`, `/metrics/features`, `/routing-spend/*` and BurnDetector keep their current behavior; the console moves to `/usage/*` once the live reconciliation is clean.
- **FD5 — Phone access is owner-only and trimmed.** Only `/mobile/usage`, owner phones only, without account, session or machine ids, trimmed on the receiving machine; `/usage/*` stays bearer-only.
- **FD6 — Prices are added by the building agent with sources, reviewed in the PR.** No separate human step in the middle of the build.
- **FD8 — Operator approval at the review cap.** The operator approved this spec with the round-6 fixes unreviewed and kept the FD1 and FD2 defaults (Justin, topic 141063, 2026-11-09).
- **FD7 — Other installs stay dark** until a release decision after the development agent's reconciliation is clean.

## Left behind

- TokenLedger's hard-coded `~/.claude/projects` root (problem 2) is a real bug in the existing burn-alert input; fixing it changes burn alert baselines, so it gets its own small spec with a re-baseline plan. Filed as instar feedback fb-71b3c6a2-25f.
- Reading other registered agents' spawn records to resolve a session both agents could claim by cwd is not built; cwd-only rows are listed in coverage instead.

## Open questions

*(none)*
