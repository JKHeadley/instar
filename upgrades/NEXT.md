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
