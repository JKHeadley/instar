# Instar Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**ABI-aware node selection — the durable end of the recurring "SQLite broke after a brew upgrade" problem.**

When the agent's `.instar/bin/node` symlink drifts to a newer Node major (e.g. `brew upgrade` bumps `/opt/homebrew/bin/node` to Node 25), the bundled `better-sqlite3` native module — which only ships a prebuilt for the previous major and won't compile from source against the new one — silently fails to load. The SQLite layer degrades (durable relay queue off, token ledger off, knowledge graph off) until a human intervenes. This has recurred across many agents.

Root cause: the node-selection logic preferred the "most durable" path (`/opt/homebrew/bin/node`) without checking whether that node could actually load the native modules. `/opt/homebrew/bin/node` is exactly the symlink homebrew bumps forward.

Three coordinated fixes:
1. **`selectDurableNode`** (extracted, pure, ABI-aware): among candidate node paths, prefer ABI-compatible ones (those that can load `better-sqlite3`), and only apply the durability heuristic *within* the compatible set. Falls back to durability-only when nothing is compatible (so you still get a working `node --version`, with the native-module degradation surfaced separately).
2. **`ensureStableNodeSymlink`**: passes the shadow-install's `better-sqlite3` binary as the ABI anchor, and re-points the symlink when the current node can't load it — even if `node --version` works (the gap that let this go undetected).
3. **boot-wrapper `selfHealNodeSymlink`**: its "symlink works, leave it alone" check now ALSO verifies the node can load `better-sqlite3`; ABI drift triggers a re-heal to a compatible candidate.

## Evidence

- New unit tests: `durable-node-selection.test.ts` (11) — durability-only behavior preserved; ABI-compatible version-specific node chosen over an incompatible stable node; durability-only fallback when nothing compatible; usability+compatibility interplay.
- `PostUpdateMigrator-bootWrapperAbiCheck.test.ts` (3) — idempotent skip when marker present; graceful skip when no wrapper; regeneration branch taken when marker absent.
- Empirical: codey was running Node 25 with `better-sqlite3` compiled for Node 22 (NODE_MODULE_VERSION 127 vs 141), SQLite degraded. Pinned codey to Node 22; the SQLite-backed token ledger now returns real data and the `sqlite-runtime-broken` degradation is gone.

## Migration

- `ensureStableNodeSymlink` runs on every setup/update, so deployed agents get ABI-aware selection on their next update.
- `migrateBootWrapperAbiCheck` regenerates `instar-boot.cjs` for existing `.cjs` agents that predate the ABI check (the `.js→.cjs` migration skipped them). Idempotent via a marker sniff.

## Rollback

Revert the `selectDurableNode` extraction + `nodeCanLoadNativeModule`, the `ensureStableNodeSymlink` ABI anchor, the boot-wrapper check, and remove `migrateBootWrapperAbiCheck`. The prior durability-only behavior returns.

---

### Codex activity-signal correction (stuck-session detection)

The framework activity signal used to detect "is this session actively working vs idle/stuck" was non-functional for Codex:
- `toolCallOrSpinner` matched the bare word `codex` — but "gpt-5.3-codex" is ALWAYS in Codex's idle status line, so every idle Codex session read as "actively working".
- `escapeToInterrupt` required a "press/hit" prefix Codex never renders (Codex shows a bare "esc to interrupt").

Net effect: the detector couldn't tell idle/working/stuck apart on Codex, so genuinely-stuck sessions stayed invisible to the silence sentinel and the presence proxy defaulted to "still working" forever (the 2026-05-23 stuck-session incident Justin hit).

Fixed empirically from live gpt-5.3-codex panes: the canonical work indicator is the `Working (Ns • esc to interrupt)` status line plus `• Ran` action bullets and the dot-spinner. The model-name status line and placeholder prompt are now correctly treated as IDLE.

Tests: `codex-activity-signal.test.ts` (10) — idle pane false, working pane true, `• Ran` bullet, bare esc-to-interrupt, model-name-alone false, placeholder-alone false, spinner, + Claude regression guard.

---

### Codex-only enforcement guard (absolute requirement)

A codex-only agent (enabledFrameworks without 'claude-code') must NEVER invoke Claude — not the main session, not internal LLM calls (gates, sentinels, summaries, relationship intelligence). instar's main provider was already framework-aware, but several fallback paths construct a Claude provider directly when the Codex provider can't be built. On a machine where the `claude` binary is installed, those fallbacks SILENTLY use Claude — an invisible violation.

New structural guard (`claudeForbiddenGuard`): when the agent is codex-only, `setClaudeForbidden()` is called once at server boot. `ClaudeCliIntelligenceProvider`'s constructor then throws `ClaudeForbiddenError` — any path that reaches for Claude surfaces loudly at the call site instead of silently degrading to Claude. The relationship-intelligence and topic-summary fallbacks now skip Claude when forbidden (those features run without LLM rather than on Claude). PipeSessionSpawner was already framework-aware.

Tests: `claude-forbidden-guard.test.ts` (10) — isCodexOnly detection, flag lifecycle, assert throws with context, and the core enforcement (ClaudeCliIntelligenceProvider construction throws when forbidden). 65 existing provider/framework tests still pass.

---

### Codex session default → gpt-5.5 + reasoning-effort findings

Per Justin (2026-05-23): the Codex session default moves from gpt-5.3-codex (coding-specialist) to **gpt-5.5** (newest generalist + Codex CLI's own default, confirmed working on the ChatGPT subscription). Changed in three places: `TIER_TO_MODEL.balanced`, `resolveModelForFramework` (balanced/sonnet → gpt-5.5), and both codex launch-builder `?? gpt-5.3-codex` fallbacks. The `fast` tier stays gpt-5.2 (cheap internal calls). gpt-5.3-codex remains available via a raw per-call model name. `/sessions/create` model allowlist gains gpt-5.5.

Reasoning-effort research (Justin asked about token savings): levels are low|medium|high|xhigh ('minimal' is GPT-5-only — errors on gpt-5.5). Empirically, on a trivial prompt the levels barely differ (low=7.4k, medium=8.9k, high=7.4k tokens) because the cost is dominated by Codex CLI's fixed per-invocation overhead (openai/codex#19996), not reasoning — the delta only shows on complex tasks. codey's config.toml sets medium (OpenAI's recommended default). The real cheap-call quota win is the fast tier (gpt-5.2, ~103 tokens vs 7k+), already in place.

Tests: 50 framework tests updated + pass (balanced default assertions → gpt-5.5).

---

### PresenceProxy Codex-blindness (the other half of the stuck-session bug)

The Codex activity-signal fix above corrected the StallTriageNurse / silence sentinel. But PresenceProxy has its OWN detection, and it was blind on Codex in two places:

1. **Finished-detection (standby flood).** The "agent finished → stop heartbeats" early-exit used `detectSessionIdle`, whose patterns are Claude-shaped (`❯`, `>`, `$`, "bypass permissions"). A Codex idle pane (the `gpt-5.3-codex medium · <dir>` status line + `›` composer) matches none of them, so the finished-check never fired on Codex — "still working" heartbeats kept flooding after the agent was done.
2. **Stall-assessment fallback (silent stuck session).** When the tier-3 LLM call failed or returned an unparseable class, the assessment defaulted to `'working'`. A stuck Codex session whose pane the LLM couldn't read was assumed active forever and never escalated to the user.

Fix: two framework-aware pure functions threaded with the agent's resolved default framework (`agentFramework` on `PresenceProxyConfig`, wired from `_defaultFramework` at server boot):
- **`detectSessionFinished(snapshot, framework)`** — for `codex-cli`, "finished" means `!looksActivelyWorking` (the `›` composer renders in BOTH idle and working panes, so prompt-presence is not a valid discriminator). `claude-code` and absent-framework keep `detectSessionIdle` (back-compat).
- **`deterministicStallAssessment(snapshot, framework)`** — when the LLM is unavailable/unparseable, fall back to the deterministic active-work signal (`looksActivelyWorking`) instead of blindly assuming "working". No active-work signal → `'stalled'` so it surfaces. This also hardens the Claude path: the old "default to working forever" was itself the silently-stopped failure mode.

Tests: `presence-proxy-codex-blindness.test.ts` (10) — codex idle reads finished (and locks that `detectSessionIdle` alone missed it), codex working not-finished, claude back-compat, absent-framework default, codex stuck/idle/null → stalled, codex/claude working → working. 86 existing presence-proxy tests still pass.

---

### SemanticMemory vec0 false-corruption loop (rebuild-on-every-boot)

`SemanticMemory.open()` runs a secondary "probe read" after `integrity_check` to catch torn interior pages that the schema walk misses — it did `SELECT * FROM <table> LIMIT 100` over every non-fts/non-sqlite table. That set included the `entity_embeddings` **vec0 virtual table**. But the probe runs *before* `initVectorSearch()` loads the sqlite-vec extension, so the SELECT threw `no such module: vec0`. That error was misclassified as disk corruption → the DB was quarantined (`semantic.db.corrupt.<ts>`) and rebuilt from JSONL on **every boot**.

Net effect: a rebuild-on-every-boot loop (codey accumulated 6 `.corrupt.<ts>` files + recovery markers in hours), wasteful churn, and — because the rebuild re-created the vec0 table during the same `open()` — semantic recall never stabilized. This silently defeated the FTS5-only graceful-degradation path the class promises, and it bites any agent (Codex or Claude) whose semantic DB has a vec0 table, whether or not sqlite-vec is actually loadable.

Fix (`SemanticMemory.open()` probe loop):
1. **Exclude virtual tables from the probe** (`sql NOT LIKE 'CREATE VIRTUAL TABLE%'`). A virtual table is not storage — its real data lives in shadow tables (`entity_embeddings_chunks`, `_rowids`, `_vector_chunks00`, …) which remain plain tables in the probe set, so vector-data corruption is still caught.
2. **Classify any `no such module` probe error as a missing loadable extension, never corruption** (per-table catch: skip + warn once, keep probing the rest). Belt-and-suspenders for any module-backed object.
3. Reading `sqlite_master` itself failing is still treated as genuine corruption.

Tests: `semantic-memory-vec0-probe.test.ts` (2) — a DB carrying a populated vec0 table opens without quarantine and preserves entities + the vec0 table (extension not loaded at probe); a genuinely torn storage page still quarantines (probe behaviour preserved). 73 existing semantic-memory tests still pass.

Empirical (codey, live): reproduced the exact stderr (`Database corrupt (probe read failed: no such module: vec0) — quarantining`) and 6 quarantine files. After deploying the fix and restarting twice, zero new quarantine files appeared and the `entity_embeddings` vec0 table now persists across boots with entities intact — vector recall restored, churn gone.

## Rollback (vec0 probe)

Revert the `SemanticMemory.open()` probe-loop change (restore the single `try` over all tables including virtual ones). The false-corruption quarantine loop returns on any DB with a vec0 table.
