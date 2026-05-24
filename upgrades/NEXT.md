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

---

### Codex model tier mapping → light/medium/heavy (subscription-aware)

Per Justin (2026-05-23, after deep research into how the ChatGPT subscription meters usage): the Codex tier→model map now reads **light=`gpt-5.2` · medium=`gpt-5.4-mini` · heavy=`gpt-5.5`** in both resolution surfaces (`TIER_TO_MODEL` in `openai-codex/models.ts` and `resolveModelForFramework` in `frameworkSessionLaunch.ts`). Was `balanced`=gpt-5.5 / `capable`=gpt-5.4.

Why this mapping despite the names: the subscription meters by **token-weighted credits** (rolling 5h + weekly window), so token-burn is the real cost metric, not just an API dollar-proxy. `gpt-5.2` is **non-reasoning** (≈0 thinking tokens on trivial calls) → genuinely the lightest, correct for high-frequency internal checks. `gpt-5.4-mini`, despite "mini," is a small **reasoning** model (emits reasoning tokens even on trivial prompts) → the cheapest *reasoning* option, right for medium work, wrong for the light tier. `gpt-5.5` is the frontier reasoning model → heavy. Use base `gpt-5.2`, **not** `gpt-5.2-codex` (the latter is a reasoning model).

The user's main interactive session is unaffected — it resolves via the `?? 'gpt-5.5'` literal (not a tier lookup) and stays on gpt-5.5 (verified live against the deployed dist). Internal tier callers shift sensibly: `balanced` consumers (drift check, upgrade-notify chain, stall diagnosis) drop to the cheaper medium reasoning model; `capable` consumers (reflection, security evaluation, conflict resolution) move up to gpt-5.5. `/sessions/create` allowlist gains `gpt-5.4-mini`.

Tests: `frameworkSessionLaunch.test.ts` + `StallTriageNurse.test.ts` updated (104 pass); 127 codex adapter/canary tests pass. Also corrected a stale StallTriageNurse fixture that fed a fabricated Codex hint (`press Ctrl+C to cancel`) — Codex's real interrupt hint is `esc to interrupt`.

## Rollback (tier mapping)

Revert the two map entries in both files (`balanced`→gpt-5.5, `capable`→gpt-5.4) and drop `gpt-5.4-mini` from the `/sessions/create` allowlist. No data/schema/migration involved.

---

### Secret Drop now reaches Codex agents (capability-awareness parity)

Live codey test (2026-05-24) caught a real gap: when offered an API key over Telegram, codey correctly refused to take it in chat — but instead of using the built-in **Secret Drop** one-time link, it improvised a plaintext `.instar/secrets/openai.env` file and asked the user to open the dashboard and edit it by hand. Weaker (plaintext at rest) and a direct violation of "never ask the user to edit files."

Root cause was a two-part awareness gap, not a missing feature (Secret Drop has always been wired):
1. `migrateClaudeMd` only patched an *existing* Secret Drop section's retrieve line — it never *added* the section to a stale CLAUDE.md that predated it. Agents (Claude and Codex alike) that updated in place never learned the capability.
2. `migrateFrameworkShadowCapabilities` — which mirrors CLAUDE.md capability sections into Codex's `AGENTS.md` (its session-start briefing) — had `**Secret Drop**` missing from its marker allowlist, and its slice boundary stopped only at headings, so a bold-marker section wedged between two others (Secret Drop sits between Private Viewing and Cloudflare Tunnel) was never propagated and would have over-grabbed its neighbors if naively added.

Fixes: the CLAUDE.md template's Secret Drop section now carries an explicit proactive trigger (the moment a user offers a credential → one-time link, NEVER chat-paste, NEVER a local file to edit); `migrateClaudeMd` injects the full section when absent; `migrateFrameworkShadowCapabilities` adds `**Secret Drop**` to its markers and bounds each slice at the next marker (so Codex agents get it without duplicating neighbors). This is an Agent Awareness + Migration Parity fix for the Codex framework, which the standards previously enforced only for Claude.

## What to Tell Your User

I looked at instar under a microscope on the OpenAI-engine side this session and fixed a batch of things that quietly affected reliability — most of them turned out to help every agent, not just the Codex one:

- Your agent's memory no longer throws itself away and rebuilds on every restart (this was happening silently for a long time).
- The OpenAI-engine "gears" are set correctly now (a light, a medium, and a heavy model picked for cost and speed).
- Stuck-session detection and the standby heartbeat work correctly on the OpenAI engine instead of mis-firing.
- And the new one: when you offer your agent a secret like an API key, it now hands you a secure one-time link instead of making a file for you to edit. That fix reaches OpenAI-engine agents too, which previously never learned about the secure drop-box at all.

Nothing here requires anything from you — it lands on your next update.

## Summary of New Capabilities

- ABI-aware Node selection — ends the recurring "SQLite broke after a brew upgrade" degradation.
- Codex activity-signal + PresenceProxy correction — accurate stuck-session detection on the OpenAI engine.
- Codex model tier mapping (light=gpt-5.2 / medium=gpt-5.4-mini / heavy=gpt-5.5), subscription-aware; main chat stays on gpt-5.5.
- SemanticMemory vec0 false-corruption fix — vector recall persists across restarts (all frameworks).
- Secret Drop capability-awareness parity for Codex — agents on the OpenAI engine now use the secure one-time link instead of improvising a plaintext file.

---

### Commitments & Follow-Through now agent-facing (Codex + all frameworks)

Second capability of the awareness-parity pass (after Secret Drop). Live on codey: asked to "report back in 3 minutes," codey improvised a raw shell `sleep` timer — which silently dies when the session ends. The durable mechanism (the commitment-tracker + promise-beacon) had always been wired, but it was only ever documented in the developer/architecture notes, never in the agent's own "here's what you can do" briefing — on any engine. So no agent knew to use it. The OpenAI engine made it visible because it has no startup hook to compensate.

Fix (same recipe as Secret Drop): a new agent-facing **Commitments & Follow-Through** section in the briefing with a clear trigger (when you promise a follow-up, register a commitment; never improvise a timer), injected into existing agents' CLAUDE.md on update, and propagated to the OpenAI-engine briefing (AGENTS.md) via the shadow-capability mirror. Verified live: codey now registers a real commitment (CMT-014) and the follow-through survives restarts. 65 affected tests green.

---

### Awareness-parity guard + Publishing/Attention Queue (close the class)

After fixing Secret Drop and Commitments one at a time, added the durable class-fix: a build guard that **fails CI if any agent-facing capability is missing from the OpenAI-engine/Gemini briefing** (the shadow-capability markers). This turns "keep the two briefings in sync" from a hope into a guarantee — the exact Structure-over-Willpower move. Completing the guard surfaced two more capabilities the briefing had been silently dropping — public Publishing (Telegraph) and the Attention Queue — both now added and propagated. Verified on codey: the migration mirrored both into its OpenAI-engine briefing with no duplication. 70 affected tests green.

---

### Token ledger now sees Codex usage (observability — all frameworks)

The usage tracker only ever read Claude Code's transcripts, so agents on the OpenAI/Codex engine were invisible to it — their token usage went uncounted and the dashboard showed nothing for them (worse, stale Claude data could masquerade as theirs). This is the "ledger blind to Codex" gap found during the codey live test.

Fix: a new reader for Codex's persisted session "rollout" files (`$CODEX_HOME/sessions/.../rollout-*.jsonl`), which carry a cumulative per-session token total plus the account's real subscription usage percentages. Codex sessions land in a **separate** `codex_token_sessions` table — deliberately NOT the Claude `token_events` table — so the BurnDetector (which reads `summary()`/`byAttributionKey()`) is provably unaffected; this change is observability-only. The poller scans them each tick, attributed to the agent by working directory. `GET /tokens/summary` now returns a `codex` rollup alongside the Claude summary, and a new `GET /tokens/codex-sessions` lists per-session Codex rows.

Verified live on codey: 473 real Codex sessions / 50.5M tokens surfaced, with real subscription usage (primary 11% / secondary 2%), all correctly attributed to the codey project; the Claude total stays separate. 27 tests across tiers (pure parser, ledger ingest + two BurnDetector-isolation tests, poller wiring + filesystem walk, HTTP routes).

Note: surfacing Codex's native rate-limit percentages *as the budget-alarm signal* (to replace the token-projection heuristic that fired a false "100% of budget" alarm on stale data) is a deliberate follow-up — it changes alerting behavior across burn-detection, so it's gated on an explicit decision + side-effects review. The data is captured and visible; the behavior change is not yet wired. <!-- tracked: ACT-150 -->
