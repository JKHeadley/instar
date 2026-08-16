# Side-Effects Review — In-Line Native-Module Self-Heal (PROP-399)

**Version / slug:** `prop-399-native-module-healer`
**Date:** `2026-05-11`
**Author:** `echo` (rebased from Dawn's original branch authored 2026-05-10)
**Second-pass reviewer:** `required — wraps every SQLite open() path; touches three memory subsystems on hot init paths`

## Summary of the change

Closes the chronic NODE_MODULE_VERSION mismatch failure mode (1254 field reports, cluster `cluster-degradation-semanticmemory-semanticmemory-init-failed-the-m`). When better-sqlite3 is compiled against one Node major and the running Node has a newer major (Homebrew bumps, asdf shims pointing at a moved binary, etc.), every SQLite-backed memory subsystem throws on first open and falls back to a degraded path. Today the only fix is for the user to run `npm rebuild better-sqlite3` by hand.

This adds a shared `NativeModuleHealer` helper (`src/memory/NativeModuleHealer.ts`) that wraps the better-sqlite3 import in each `open()` path. On `NODE_MODULE_VERSION` error during `await import('better-sqlite3')`:

1. Locate the install prefix via `require.resolve('better-sqlite3')`.
2. Locate `npm` on PATH.
3. Run `npm rebuild better-sqlite3 --prefix <prefix>` synchronously (~30s).
4. Clear better-sqlite3 from `require.cache` so the fresh binding loads on retry.
5. Retry the import + construct exactly once. On second failure, surface the post-rebuild error directly.

Heal attempts are persisted as JSONL at `<stateDir>/native-module-heals.jsonl` for observability and downstream consumption by `DegradationReporter` / health probes.

Wired into:
- `src/memory/SemanticMemory.ts::open()` — wraps the import; main's corruption-recovery branch is unchanged and runs after the healer returns the constructor.
- `src/memory/TopicMemory.ts::open()` — wraps the import + construct.
- `src/memory/MemoryIndex.ts::open()` — wraps the import + construct.

**Once-per-process guard.** The rebuild is expensive and shouldn't loop. The healer enforces single-attempt semantics: a second open() in the same process that hits the same error gets the original error with `(heal previously attempted)` appended, no rebuild re-run.

**This is the same change as the original PROP-399 commit (`e080ec64`, authored by Dawn on `fix/prop-399-native-module-healer`).** This rebase brings it forward onto current main (97 commits behind, two conflict files). No behavior was added or removed during the rebase; the conflicts were both about coexistence with features that landed in parallel:

- **`site/src/content/docs/reference/configuration.md`** — PROP-399 added a `defaultMaxDurationMinutes` doc entry that main subsequently added on its own (PR #125). The PROP-399 docs change was dropped during rebase because it was already applied — net diff is zero.
- **`src/memory/SemanticMemory.ts`** — main added corruption auto-detection + JSONL-rebuild + quarantine handling to `open()` after PROP-399 forked. PROP-399 replaced the same `open()` body with the healer wrap. Resolved by extracting the better-sqlite3 constructor inside `openWithHeal('SemanticMemory', …)`, then running main's corruption-recovery and pragma setup on the constructed db unchanged. Both features now compose: ABI-mismatch heals first (import-time), corruption-quarantine + JSONL-rebuild heals second (post-open).

## Decision-point inventory

- `src/memory/SemanticMemory.ts::open()` (line 147) — **modify** — replaces the inline `await import('better-sqlite3')` block with `NativeModuleHealer.openWithHeal('SemanticMemory', …)` that returns the constructor. The rest of `open()` (corruption recovery, integrity probe, JSONL rebuild) is unchanged.
- `src/memory/TopicMemory.ts::open()` (line 149) — **modify** — wraps import + construct in `openWithHeal('TopicMemory', …)`. No corruption-recovery branch in TopicMemory; the wrap is end-to-end for open().
- `src/memory/MemoryIndex.ts::open()` (line 120) — **modify** — wraps import + construct in `openWithHeal('MemoryIndex', …)`. No corruption-recovery branch.
- `src/memory/NativeModuleHealer.ts` — **add** — new file. Process-singleton class; exposes `openWithHeal`, `isNodeModuleVersionError`, `healBetterSqlite3`, `getLastResult`, `configure({ stateDir })`. No exports from `index.ts` — memory modules import directly.

No new gates, no new filters, no new authorities — `NativeModuleHealer` produces a signal (heal-event JSONL) that the existing `DegradationReporter` consumes; the healer itself never decides whether the user should be alerted. The signal-vs-authority boundary is preserved.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — this is a heal-and-retry wrapper. The original error is re-thrown on second failure with full context.

The inverse risk exists: could the healer mask a real configuration error?

- **better-sqlite3 not installed.** The opener catches the non-`NODE_MODULE_VERSION` `import` failure and re-throws the original user-facing "Run: npm install better-sqlite3" message. `openWithHeal` then checks `isNodeModuleVersionError` and short-circuits — non-mismatch errors propagate immediately, no rebuild is attempted.
- **`npm` missing on PATH.** Heal returns false, writes a `HealEvent` with `errorTail: 'npm not found on PATH'`, original error is re-thrown wrapped with `(in-line heal failed — see native-module-heals.jsonl)`. No silent swallow.
- **Rebuild succeeds but Node still incompatible** (e.g., Node major above what better-sqlite3 supports). Retry fails, the new error is surfaced directly — caller sees the post-rebuild failure mode, not the pre-rebuild one. Heal event is logged with `success: true` (rebuild ran) but the retry exception bubbles unchanged.

---

## 2. Under-block

**What failure modes does this still miss?**

- **Other native modules.** Only better-sqlite3 is healed. The same ABI mismatch class hits `sqlite-vec` (vector search), `keytar`, and any future native dep. Out of scope for PROP-399; the helper is generic enough (`openWithHeal<T>`) that future modules can adopt it.
- **Heal failures during the supervisor preflight path.** `ServerSupervisor.preflightSelfHeal` (PR #111) heals the server-spawn case before the server forks; the in-line healer here covers CLI commands and direct instantiation paths that bypass the supervisor. Both paths log to `native-module-heals.jsonl`, but they don't share state — a heal in the supervisor doesn't suppress a heal in the server. With the once-per-process guard each side caps its own retries; no double-rebuild within a single process is possible.
- **Heals during a degraded `Node-not-asdf` install.** If `npm` shells out to a Node that's different from `process.execPath`, the rebuild can target the wrong ABI. The healer pins `process.execPath` as the node binary for the spawned `npm` (`spawnSync(process.execPath, [npmPath, 'rebuild', ...])`), which closes this.

---

## 3. Level-of-abstraction fit

**Is this happening at the right layer?**

The healer sits at the `open()` boundary inside each memory subsystem — the *first* user-visible interaction with the native module. That is the right layer for an inline heal: it catches both supervised (server-spawned) and direct (CLI command) callers, doesn't require new infrastructure, and surfaces the heal event through the existing degradation-event pipeline.

A pure boot-time preflight (already exists in `ServerSupervisor.preflightSelfHeal`) cannot cover the CLI-command and direct-instantiation cases — the field reports show the gap is real.

A higher-level remediator (the `Remediator` described in `docs/specs/SELF-HEALING-REMEDIATOR-SPEC.md`) would orchestrate this from outside; that spec is the broader plan. Until the orchestrator exists, this in-line healer is the load-bearing piece. When the remediator lands, it consumes `native-module-heals.jsonl` as the "first runbook" without needing to re-implement the rebuild logic.

---

## 4. Signal-vs-authority compliance

**Does this respect the project principle that low-context filters emit signals while only a high-context gate has blocking authority?**

Yes. The healer is a signal producer:

- It detects a narrow, structurally observable failure (`NODE_MODULE_VERSION` substring in `err.message`).
- It writes a structured event (`HealEvent`) to JSONL.
- It surfaces the rebuild attempt through stdout/console logging.

The authority decisions — does this become a degradation event? does the user get alerted? — are owned by `DegradationReporter` and its downstream consumers (tone-gate authority, attention channel). The healer never directly emits a degradation or sends a user alert.

The `isNodeModuleVersionError` matcher is a regex on free-form Node error text, which is the kind of brittle filter the project principle warns about. It's safe here because:

1. The matcher's job is to *decide whether to retry an open*, not to authorize a privileged action.
2. The retry is bounded (once per process).
3. A false positive (substring match on legitimate non-mismatch error) causes one unnecessary rebuild — slow, not unsafe — and the post-rebuild retry then surfaces the original error to the caller.
4. A false negative (real mismatch that the matcher misses) is identical to the current behavior: throw and degrade. No regression.

---

## 5. Interactions with adjacent systems

- **`ServerSupervisor.preflightSelfHeal` (PR #111).** Coexists. Supervisor heals at fork time; this heals at first-open time. Each has its own `healAttempted` guard within its own process. No state shared, no coordination needed. If the supervisor heals first, the spawned server's in-line healer sees a working binding and never trips.
- **Main's `SemanticMemory.open()` corruption recovery (PRs #ea099453, #28e54f82, #6bfef745, #7c4463ef).** Coexists by ordering. The healer runs first (import-time, ABI mismatch). After it returns a working constructor, main's corruption-detection / quarantine / JSONL-rebuild runs unchanged on the constructed db. Verified by the 12 corruption-recovery tests + 12 NativeModuleHealer tests all passing together (`tests/unit/semantic-memory-corruption-recovery.test.ts` + `tests/unit/NativeModuleHealer.test.ts`, 24 tests pass clean).
- **Main's WikiClaim Phase 1/5 work on `SemanticMemory.ts` (PRs #137, #141).** No interaction. Those changes touched the entity/evidence schema and query paths; this change touches `open()`. The added import (`EvidenceRenderer`) is preserved.
- **`DegradationReporter`.** Consumes `native-module-heals.jsonl` as part of its event sources (existing wiring on Dawn's original branch). The reporter remains authority-of-record for whether a heal-failure becomes an attention-channel alert.
- **Messaging Layer 3 `DeliveryFailureSentinel` (PR #103).** No interaction. Different failure class (network/delivery), different subsystem.

---

## 6. Rollback cost

- **Forward.** Merge to main, cut a release. Agents on the new version are auto-healed on next session. Agents on older versions degrade exactly as they do today — no change.
- **Backward.** Revert is a single-commit rollback (one feature commit). No DB migrations, no on-disk schema changes. The `native-module-heals.jsonl` log file is append-only and is safe to leave behind on rollback; the next start without the healer simply doesn't write to it.
- **Skew safety.** Two agents on different versions in the same repo do not share state — heals are per-agent, per-process. A mid-release-window mix is harmless.

---

## 7. Convergence-history reference

The broader design this PR slots into went through 5 rounds of convergent review in April:

- 4 rounds of Claude-family reviewers in parallel (security / scalability / adversarial / integration). Internal convergence at iter 4.
- 1 final cross-model round (GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast via `/crossreview`). Surfaced 11 additional findings the Claude-family reviewers missed (alert-policy contradiction, wall-clock-vs-monotonic-time gap, blastRadius:"external" contradiction, machine-lock reclaim predicate too strict).

96 material findings addressed across all rounds. Spec: `docs/specs/SELF-HEALING-REMEDIATOR-SPEC.md` (status `converged-pending-approval`). Convergence report: `docs/specs/reports/self-healing-remediator-convergence.md`.

**This PR ships the narrowest slice of that design** — the one in-line runbook (better-sqlite3 ABI mismatch) — without the surrounding Remediator orchestrator. The orchestrator is the next phase and will be re-spec'd against current reality (incorporating the lifeline-preflight, probe framework, tone-gate, and Layer-3 sentinel pieces that landed in parallel during April–May 2026).
