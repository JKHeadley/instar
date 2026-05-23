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
