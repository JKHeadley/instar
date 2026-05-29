# Side-Effects Review — Shared prior-heal retry (NativeModuleHealer)

**Version / slug:** `heal-shared-rebuild-retry`
**Date:** `2026-05-29`
**Author:** Echo (instar developer agent)
**Spec:** `docs/specs/token-ledger-native-heal.md` (2026-05-29 amendment — in-scope, finishes AC#7)
**Second-pass reviewer:** required (touches the fleet-wide native-module heal authority)

## Summary of the change

`NativeModuleHealer`'s once-per-process heal guard (`healAttempted`) was too coarse: after the FIRST sqlite subsystem to open heals successfully (rebuilding the better-sqlite3 binding on disk), any LATER subsystem that hits `NODE_MODULE_VERSION` is short-circuited with `throw "(heal previously attempted)"` — even though the binding is already fixed and a cheap re-require would succeed. Observed live on the Codey agent (Telegram topic 13435): `/memory/search` (SemanticMemory) returned 200 while `/tokens/summary` (TokenLedger) returned 503, binding on disk already ABI-correct, heal log empty.

The fix branches the `healAttempted` block on the prior outcome: prior heal **succeeded** → `clearBetterSqlite3Cache()` + retry the open once (no second rebuild); prior heal **failed** → throw with the existing failure context (unchanged). Applied identically to both `openWithHeal` (async) and `openWithHealSync` (sync).

Files touched:
- `src/memory/NativeModuleHealer.ts` — the two `if (this.healAttempted)` blocks in `openWithHeal` and `openWithHealSync`. Additive branch; no other surface changes.
- `tests/unit/NativeModuleHealer.test.ts` — adds a `shared prior heal — multi-subsystem recovery` describe block (4 tests: sync prior-success retry, async prior-success retry, prior-failure still throws, persistent post-retry failure surfaces).

Decision point interacted with: exactly one — `NativeModuleHealer` (the authority over native-module rebuilds). The change does NOT alter who rebuilds or when a rebuild runs (still at most once per process); it only stops the guard from spuriously blocking a *cheap re-open* after a *successful* rebuild.

## Decision-point inventory

- `NativeModuleHealer.openWithHeal` / `openWithHealSync` (deterministic authority over native-module rebuild) — **modify (narrow)** — the `healAttempted` branch now distinguishes prior-success (retry) from prior-failure (throw). The rebuild gate itself is untouched.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

It removes an over-block. Before: a legitimate later open (binding already fixed) was rejected with "(heal previously attempted)". After: that legitimate open succeeds via cache-clear + retry. The prior-failure path is unchanged, so nothing newly legitimate is rejected. No allow/deny surface is added.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Genuinely-broken binding after a successful prior heal.** If `lastResult.success` is true but THIS subsystem's open still fails (e.g. a different native dep, or a partial rebuild), the retry runs once and the real error surfaces directly (test A4). It is not retried indefinitely and is not swallowed.
- **First-heal-fails-then-binding-fixed-externally.** If the first heal FAILED, later callers still throw without retry (by design — `success === false`). If an operator manually rebuilds afterward, a process restart is still required. This matches the documented "rebuild fails → visible in heal log + restart" behavior of the original spec; out of scope to auto-detect external repair mid-process.
- **Non-better-sqlite3 native modules.** Unchanged — the healer only knows better-sqlite3.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The bug is in the healer's process-global guard, so the fix belongs in the healer — fixing it once benefits every sqlite consumer (TokenLedger, TopicMemory, MemoryIndex, SemanticMemory) rather than patching each call site. No call site changes.

---

## 4. Signal vs authority compliance

The `NativeModuleHealer` remains the sole authority over native-module rebuilds. This change does not move authority and does not add an LLM-backed decision — it is a deterministic refinement of an existing deterministic guard. The expensive action (rebuild) is still gated to once-per-process; only the cheap action (re-require + open) is now permitted after a confirmed-good rebuild. Compliant with `docs/signal-vs-authority.md`.

---

## 5. Interactions

- **SemanticMemory / TopicMemory / MemoryIndex** (existing async callers): unaffected on the happy path and on the first-heal path. They gain the same prior-success retry behavior if they happen to open after another subsystem healed — strictly an improvement.
- **ServerSupervisor.preflightSelfHeal** (supervisor-spawn rebuild): independent path; not touched. If preflight already rebuilt the binding, in-process opens never hit the mismatch at all.
- **Remediator path (`invokeFromRemediator`, F-8/W-1)**: untouched. It sets `healAttempted`/`lastResult` via its own surface; a subsequent legacy `openWithHeal` after a successful remediator heal now correctly retries instead of throwing — consistent with the fix's intent.
- **Heal log / `NativeHealDegradationBridge`**: no new event types emitted by the retry path; the prior successful heal event is already logged. Bridge behavior unchanged.

---

## 6. External surfaces

No API contract change. No config. No migration. No agent-installed-file change (ships with the npm package, not via `init`/`PostUpdateMigrator`). The observable external effect is positive: on a node-upgraded agent, `/tokens/*` (and any other sqlite-backed endpoint that previously 503'd after another subsystem healed) returns live data once the agent runs the new code.

---

## 7. Rollback cost

Revert the two `if (this.healAttempted)` blocks to their unconditional-throw form (one file). No persistent state, no migration, no contract. The reverted-to state is the pre-amendment behavior (later sqlite subsystems dark after the first heals) — exactly the bug being fixed, never a worse state. ~5 minutes detection-to-revert.

---

## Second-pass review

**Reviewer concern surfaced:** Could the prior-success retry mask a real ABI problem by retrying into a still-bad binding? No — the retry runs exactly once and any persistent failure is thrown directly (test A4 pins this). The guard against repeated *rebuilds* is preserved, so the pathological-loop protection the original spec relied on is intact.

**Concurrence:** The change is mechanically narrow (one branch in two sibling methods), the test matrix covers both sides of the new decision boundary (prior-success → retry; prior-failure → throw) plus the persistent-failure escape, and the rollback is a single-file revert to a strictly-not-worse state. Concurred.
