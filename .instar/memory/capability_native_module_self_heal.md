---
name: capability-native-module-self-heal
description: In-line better-sqlite3 ABI self-heal across SemanticMemory, TopicMemory, MemoryIndex, and TokenLedger — covers Node-version drift after install
metadata:
  type: project
  version: vNEXT
---

# Native Module Self-Heal (vNEXT)

When the running Node major differs from the major `better-sqlite3` was compiled against, all SQLite-backed subsystems (`SemanticMemory`, `TopicMemory`, `MemoryIndex`, `TokenLedger`) used to throw `NODE_MODULE_VERSION` at first `open()` and degrade silently. TokenLedger's silent failure meant `/tokens/*` endpoints and the Dashboard Tokens tab returned unavailable for up to 2+ days on this machine (2026-05-13 through 2026-05-15).

## What I can do now

On the first `open()` after a Node-version drift, the wrapper at `src/memory/NativeModuleHealer.ts`:
- Detects `NODE_MODULE_VERSION` errors at import time
- Locates the install prefix via `require.resolve`, locates `npm` on PATH
- Runs `npm rebuild better-sqlite3 --prefix <prefix>` synchronously (~30s) with `process.execPath` pinned as the node binary
- Clears `require.cache`, retries the import + construct once
- Logs each attempt to `<stateDir>/native-module-heals.jsonl` (consumed by `DegradationReporter`)
- Once-per-process guard prevents rebuild loops

As of vNEXT (2026-05-15), `TokenLedger` now routes through this healer at `AgentServer` construction time, so token ledger automatic healing is included alongside SemanticMemory/TopicMemory/MemoryIndex.

The corruption-recovery branch (integrity check, quarantine, JSONL rebuild) in `SemanticMemory.open()` is unchanged and composes after the healer.

## Scope limits I hit on 2026-05-11

The vNEXT healer only covers in-process memory subsystem opens. The **ServerSupervisor preflight** rebuild path (`src/lifeline/ServerSupervisor.ts`) is a separate, older code path that gates server startup; it failed for me tonight (`spawnSync ENOENT`) and put the lifeline in a restart loop. Manual `node scripts/fix-better-sqlite3.cjs` unblocked it. **Durable fix needed**: backport the healer's `process.execPath` + once-per-process guard pattern to the supervisor preflight, or have the supervisor delegate to NativeModuleHealer.

## References

- Spec: `docs/specs/SELF-HEALING-REMEDIATOR-SPEC.md`
- Convergence: `docs/specs/reports/self-healing-remediator-convergence.md`
- Heal log: `<stateDir>/native-module-heals.jsonl`
