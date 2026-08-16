# Side-Effects Review — Token Ledger Native-Module Heal

**Version / slug:** `token-ledger-native-heal`
**Date:** `2026-05-15`
**Author:** Echo (instar developer agent)
**Second-pass reviewer:** required (touches monitoring infrastructure + healer surface)

## Summary of the change

Adds a sync surface (`openWithHealSync<T>`) to `NativeModuleHealer` and wires `TokenLedger`'s constructor to use it. Restores `/tokens/*` endpoints on every active agent on this machine. Without this fix, a Node version upgrade after instar install silently breaks the token ledger forever.

Files touched:
- `src/memory/NativeModuleHealer.ts` — adds `openWithHealSync<T>(component, opener)` and `healBetterSqlite3Sync()`. Existing async `healBetterSqlite3()` is now a thin wrapper over the sync impl. No behavior change for existing async callers.
- `src/monitoring/TokenLedger.ts` — replaces `new Database(opts.dbPath)` with `NativeModuleHealer.openWithHealSync('TokenLedger', () => new Database(opts.dbPath))`. Adds the import.
- `src/server/AgentServer.ts` — adds `NativeModuleHealer.configure({ stateDir })` before TokenLedger construction so heal events log to the agent's state directory. Adds the import.
- `tests/unit/NativeModuleHealer.test.ts` — adds 5 regression tests covering `openWithHealSync` success / non-mismatch passthrough / heal-failure / heal-then-retry / no-retry-after-prior-failure.
- `tests/unit/token-ledger.test.ts` — adds 1 regression test pinning that the TokenLedger constructor routes the DB open through the healer.

Decision points the change interacts with: only one — `NativeModuleHealer`. The fix extends its public surface with a sync variant. The healer remains the authority over native-module rebuilds; this PR just exposes that authority to sync call sites.

## Decision-point inventory

- `NativeModuleHealer.openWithHeal` (LLM-backed authority? no — deterministic authority over native-module rebuild) — **extend** — adds a sync surface variant. Decision logic identical to existing async path.
- `TokenLedger.constructor → new Database` (low-level resource acquisition) — **modify** — routes the failure path through the existing healer authority instead of bubbling unhandled.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No new block/allow surface. The change adds a heal-on-throw safety net to a code path that previously had no safety net. The only behavioral change is: where today a NODE_MODULE_VERSION mismatch produces `tokenLedger = null` forever, after this change the healer attempts a rebuild and retries the open. If the rebuild succeeds, the ledger opens normally; if it fails, the original mismatch error is rethrown with heal-context (same final state as today).

No legitimate input shapes are newly rejected.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Rebuild fails repeatedly across process restarts.** The healer's once-per-process guard means each restart gets one rebuild attempt; if the rebuild keeps failing (e.g., disabled C compiler, no node-gyp), every server restart retries and burns ~30s. This is the existing healer behavior, not a regression — and it surfaces visibly via the heal log + `lastResult`.
- **Other native modules.** The healer only knows about better-sqlite3. If a different native module (sqlite-vec, faiss-node, etc.) had a NODE_MODULE_VERSION mismatch, this PR wouldn't help. Out of scope.
- **Concurrent heal storms.** PROP-399's W-1 extension (`invokeFromRemediator`) deals with multi-process storm coalescing; this PR uses the legacy in-line path which has no storm protection. Acceptable because TokenLedger init runs once per process inside the server constructor, before any other heal-capable component has a chance to race.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The `NativeModuleHealer` is the existing canonical home for "rebuild a native module when it ABI-mismatches." Three other modules in tree already use its `openWithHeal()` async surface. Adding a sync mirror is the natural extension. The fix doesn't introduce a new layer; it consumes an existing one.

`TokenLedger`'s constructor is where the better-sqlite3 open happens; that's where the heal call belongs. Moving it to AgentServer.start() would have made the constructor async (intrusive) without benefit — heal events still need a stateDir, which AgentServer.start() doesn't have any earlier than the constructor.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.
- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic.

The new sync surface is a mechanical extension of an existing authority. It does not make any classification or judgment decisions. The healer's existing rebuild logic is the authority — sync vs async is only the consumer-side calling convention. No brittle logic, no new blocking surface.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing**: existing healer call sites (SemanticMemory/TopicMemory/MemoryIndex) still use async `openWithHeal`. The sync variant is opt-in per call site. No shadowing.
- **Double-fire**: `healAttempted` (singleton state) is shared across sync + async paths — by design, so a once-per-process rebuild stays once-per-process even if both surfaces are used in the same process. The first caller wins; subsequent callers see "heal already attempted" and rethrow with hint. Correct behavior.
- **Races**: the healer is a process singleton; all paths through it serialize on a single boolean. Node single-threaded, no race.
- **Adjacent cleanups**: `resetForTesting()` clears `healAttempted` — verified to also reset for the new sync path (no separate sync state).
- **AgentServer ordering**: `NativeModuleHealer.configure({ stateDir })` runs before `new TokenLedger(...)` in AgentServer.constructor. The configure call only sets a private field; it cannot fail.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine** — yes, in a positive way: every agent's TokenLedger init now heals through the rebuild path automatically. Visible to the operator as: `/tokens/summary` starts returning live data instead of `{"error":"token ledger unavailable"}` after the next agent upgrade.
- **Other users of the install base** — same. Every instar agent benefits from the heal once it upgrades to this version.
- **External systems** — npm gets one extra invocation (`npm rebuild better-sqlite3`) on each agent where the binding was previously mismatched. One-shot, ~30 seconds per agent, fully bounded by spawnSync timeout.
- **Persistent state** — `<stateDir>/native-module-heals.jsonl` may gain entries (existing log path from PROP-399). No new state files. No schema migration.
- **Timing / runtime conditions we don't fully control** — the rebuild requires npm + a working C compiler. On agents missing those (rare), the heal logs failure and the ledger remains null. Same final state as today.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release**: revert four files + their tests, ship a patch release. ~10 minutes once detected.
- **Data migration**: none. No persistent state introduced.
- **Agent state repair**: none. Any `native-module-heals.jsonl` entries from this PR are append-only observability, not load-bearing.
- **User visibility**: zero. Worst-case rollback returns the ledger to its current "unavailable" state, which is the baseline today.

Pure code change, no migrations, no state to roll back.

---

## Conclusion

The change is the smallest possible adapter between an existing healer authority and the TokenLedger constructor that has been bypassing it. No new decision logic, no new blocking surface, no persistent state, no API contract change for existing callers. Worst-case rollback is a four-file revert at zero migration cost. The fix unblocks the observability that was meant to detect bleeding patterns automatically — without it, the next "bleeding out" scenario will again be invisible in the agent's own data. Clear to ship pending second-pass concurrence.

---

## Second-pass review

**Reviewer:** general-purpose subagent (Echo's review subagent)
**Independent read of the artifact: concur**

The change is the minimal correct extension of the existing healer authority into the sync constructor of TokenLedger; the `healAttempted` singleton is shared across both surfaces by design (single-threaded Node + sync spawnSync means no interleave is possible), all 33 unit tests pass locally, AgentServer's outer try/catch preserves the exact same final state when the post-heal retry throws a different error (e.g., permission denied), and the only production call site of `new TokenLedger(...)` is AgentServer itself.

Minor non-blocking notes:
- `NativeModuleHealer.configure({ stateDir })` is last-write-wins; today only AgentServer calls it, so a future second caller with a different stateDir would silently redirect heal logs. Not a current bug — flag if another configure caller is ever added.
- Test-mode constructions of `TokenLedger` (7 call sites in `tests/unit/token-ledger.test.ts`) skip the configure step and would log heal events to the os-tmp fallback if a real rebuild ever fired in tests. In practice the heal is fully mocked, so this never executes — but worth noting if integration tests start exercising the rebuild path for real.
- Existing async tests spy on `healBetterSqlite3`; the sync path goes directly to `healBetterSqlite3Sync` and intentionally bypasses the wrapper. The two surfaces share state but not method identity — that's the right separation and the new test correctly mocks `healBetterSqlite3Sync` directly.

---

## Evidence pointers

- Original failure log (server.log, accumulated over 28 restarts since 2026-05-13):
  `[instar] token-ledger init failed (non-fatal): Error: The module ... was compiled against a different Node.js version using NODE_MODULE_VERSION ...`
- `/tokens/summary` baseline on Echo before fix: `{"error":"token ledger unavailable"}`
- Test verification: `npx vitest run tests/unit/NativeModuleHealer tests/unit/token-ledger.test.ts` → 49/49 passed (6 new regression tests included).
- Acceptance: post-publish + post-upgrade, `/tokens/summary` returns a live JSON payload on Echo + at least one other agent.
