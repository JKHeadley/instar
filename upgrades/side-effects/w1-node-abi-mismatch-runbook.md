# Side-Effects Review — W-1: node-abi-mismatch runbook + NativeModuleHealer.invokeFromRemediator

**Version / slug:** `w1-node-abi-mismatch-runbook`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Ships the FINAL Tier-1 PR of the Self-Healing Remediator v2 build (per `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A6, §A9, §A28, §A36, §A45, §A55, §A57). Adds the first `ApprovedRunbook` the F-8 Remediator can dispatch — `node-abi-mismatch` — and the matching `NativeModuleHealer.invokeFromRemediator(ctx)` surface entry-point.

Two new modules:

- `src/remediation/runbooks/node-abi-mismatch.ts` — the runbook. Matches structured-provenance NATIVE_MODULE_ABI_MISMATCH events (per §A6: `provenance ∈ {native-binding, subsystem-explicit}`, NOT `free-text`). surfaceCallable delegates to `NativeModuleHealer.invokeFromRemediator`. verify() opens a sqlite handle and runs `PRAGMA integrity_check`; returns the §A21 verified-healthy / verify-failed / verify-inconclusive taxonomy. Marked `essential: true` with `blastRadius: 'machine'` (§A36 validator accepts this combination).
- `src/memory/NativeModuleHealer.ts` (extended) — adds `invokeFromRemediator(ctx)` as a parallel entry point. The existing `openWithHeal` in-line path remains the CLI-direct safety net, unchanged. The new method:
  - Honours `ctx.abortSignal` (returns failure if already aborted; passes the signal to spawnSync).
  - Respects `ctx.monotonicDeadline` to compute remaining ns budget for npm rebuild.
  - Invokes `npm rebuild --ignore-scripts --build-from-source better-sqlite3 --prefix <installPrefix>` — never bare `npm rebuild` (§A28); always `--build-from-source` (§A45).
  - Performs a best-effort `package-lock.json` integrity read pre-rebuild and records it in `details.packageLockIntegrity` (§A55 first step; the signed `dist/native-prebuilds.lock.json` from full A55 lands later).
  - Computes sha256 of the rebuilt `.node` binary post-rebuild and emits `details.rebuiltBinarySha256` (§A28 binary-divergence detection).

Tier-1 IS COMPLETE after this PR: F-1, F-2, F-3, F-4, F-8 subset, and W-1 are all on main. The Remediator is dispatchable end-to-end via test fixtures. NO production wiring yet — `DegradationReporter.setRemediator()` is still uncalled, which is Tier-2 work.

Files touched:
- `src/remediation/runbooks/node-abi-mismatch.ts` (new)
- `src/memory/NativeModuleHealer.ts` (extended — `invokeFromRemediator` + helpers)
- `tests/unit/runbooks/node-abi-mismatch.test.ts` (new — 12 cases)
- `tests/unit/NativeModuleHealer-invokeFromRemediator.test.ts` (new — 12 cases)
- `upgrades/NEXT.md` (preserves F-1..F-4 + F-8 + Phase 4/5 + ELI16 + API-safety entries; W-1 added in three sections)

## Decision-point inventory

- `nodeAbiMismatchRunbook.match(event)` — **add** — narrow filter: returns true only when the event is about better-sqlite3 (subsystem='better-sqlite3' OR subsystem='memory' + reason text mentions better-sqlite3). Pure structural code; no LLM, no regex over arbitrary fields.
- `nodeAbiMismatchRunbook.preconditions(event)` — **add** — `require.resolve('better-sqlite3')` succeeds. Refuses to fire when the package isn't installed at all.
- `nodeAbiMismatchRunbook.verify(ctx)` — **add** — opens an in-memory sqlite handle and runs `PRAGMA integrity_check`. Returns one of three §A21 outcomes; in particular probe error → verify-inconclusive (never verify-failed).
- `NativeModuleHealer.invokeFromRemediator(ctx)` — **add** — Remediator-orchestrated parallel entry point. Once-per-process guard preserved from `healBetterSqlite3`.

The legacy `openWithHeal` entry point is **pass-through** (unchanged). The once-per-process guard `healAttempted` is shared between the two paths so a rebuild from either route counts against the other — they cannot both spawn a rebuild within one process lifetime, which is the desired §A2 invariant.

No new HTTP routes. No new persistent files beyond what F-4 already creates. The runbook is constructible but is NOT registered into a live Remediator from production code in this PR — registration into a live dispatcher happens in Tier-2 alongside the `DegradationReporter.setRemediator()` wiring.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **Free-text-provenance NODE_MODULE_VERSION events** are NOT matched by this runbook. This is by design (§A6). The legacy `.report(...)` callers that normalize to `provenance: 'free-text'` (per F-3 shim) cannot trigger the rebuild — they route to `no-matching-runbook` and feed NovelFailureReviewer's clustering pipeline. Operators who hit ABI mismatch via the in-line path STILL get healed because `openWithHeal` remains untouched. The structural defense costs no functionality.
- **Events about native modules other than better-sqlite3** are rejected by `match()`. Intended — the runbook's surface (`NativeModuleHealer`) only knows how to rebuild better-sqlite3. A different native module mismatch routes to `no-matching-runbook` correctly; SystemReviewer can cluster and propose a new runbook.
- **Events with `subsystem !== 'better-sqlite3'` AND no `better-sqlite3` mention in `reason`** are rejected. The `match()` callback falls back to inspecting `reason.full ?? reason.redacted`; if neither mentions better-sqlite3 we conservatively decline. False-negative risk exists for legacy emit sites with surprising subsystem names, but the in-line `openWithHeal` path still catches them.

No legitimate input is rejected that should have been accepted.

---

## 2. Under-block

**What failure modes does this still miss?**

- **No cross-process binary-divergence enforcement yet.** The sha256 is recorded in `details.rebuiltBinarySha256` and visible in the audit projection, but no consumer compares this against a pinned-sha256 lockfile. §A55's signed `dist/native-prebuilds.lock.json` is the closing piece; this PR records the data point.
- **Package-lock integrity check is observational, not enforcing.** §A45 says pre-rebuild integrity check; this PR reads `package-lock.json` and records the result in `details.packageLockIntegrity` but does NOT abort on mismatch. Tightening to fail-closed will be part of the A55 follow-up that adds the signed lockfile — without a signed source of truth, refusing on mismatch would over-block on benign npm-version drift.
- **No deadline enforcement on `verify()` separately.** The Remediator's §A4 AbortController fires around the whole `surfaceCallable + verify` chain, so a hung verify is caught. But `verify()` doesn't have a per-step budget. The integrity_check pragma on an in-memory db is fast (~microseconds in practice), so this is not a likely DoS surface.
- **The runbook trusts `match()` callback authorship.** If the runbook author writes `match: () => true`, the prefilter would still firewall by errorCode + provenance, but match() is unscrutinized. In W-1 the match logic is structural code shipped in-repo with the runbook; review-time the diff covers it.
- **The once-per-process guard `healAttempted` is shared between `openWithHeal` and `invokeFromRemediator`.** If the in-line path attempts and fails, the Remediator path will short-circuit with the failed result rather than re-trying. Intended — npm rebuild is expensive and we don't want two attempts per process. Cross-process retry is what the A7 cross-process ledger gates.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. Each piece sits where the spec mandates:

- **Runbook (`src/remediation/runbooks/node-abi-mismatch.ts`)** is the policy layer — declares the match contract, the verify semantics, the blast-radius, and the surfaceCallable wiring. Pure data plus a thin verify wrapper; no orchestration, no key material, no audit-write concerns.
- **`NativeModuleHealer.invokeFromRemediator`** is the surface layer — owns the rebuild step plus the §A28/§A45 supply-chain invariants. No knowledge of the Remediator's lock / intent / audit primitives; it accepts a context, does the work, returns an `ExecutionResult`. The dispatcher (F-8) owns everything else.
- **Verify helper (`verifyBetterSqlite3Ok`)** is the durability probe — owns the §A9 "assert durable, not just live" rule. Cleanly separated from the heal step so verify can run after either entry point.

No higher-level smart gate is shadowed. The Remediator's `registerRunbook()` validator (§A6, §A36) is the gate that accepts/rejects this runbook at boot; the runbook itself doesn't contain blocking authority over content beyond the structural match contract.

The signal-vs-authority principle (`docs/signal-vs-authority.md`) is honoured: the match is precise structural code (errorCode equality + provenance enum membership + subsystem string equality OR a narrow regex on REASON text limited to the literal `better-sqlite3`), not a heuristic content classifier. The authority to "rebuild a native module" lives at the surface layer (`NativeModuleHealer`), gated by the §A28/§A45 invariants.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no brittle-logic blocking authority. Match is precise structural code over enum-typed fields; verify is a deterministic pragma check; the only block surface (§A36 essential-on-machine) is enforced by the F-8 dispatcher's validator, not by this runbook.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic — STOP.

The runbook's structural decisions:
- §A6 prefilter (errorCode + provenance enum equality) — precise.
- §A36 essential+machine — enforced at registry-load by F-8's validator.
- §A28 supply-chain (`--ignore-scripts --build-from-source <single-package>`) — hard-coded; no input plumbing.
- §A45 package-lock integrity read — observational only.
- §A21 verify taxonomy — derived from PRAGMA integrity_check result type-by-type.

There is one regex in `match()`: `/better-sqlite3/i` against the reason text. This is a **subsystem-name match** (a literal package name in a structured-provenance event), not a content classifier — there is no LLM call, no token-class matching, no synonym handling. The smart gate (operator approval, /instar-dev review-time discipline) holds policy authority over which runbooks exist; this runbook's job is to be a precise structural detector for one specific failure mode.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The legacy `openWithHeal` path and the new `invokeFromRemediator` path share the `healAttempted` once-per-process flag. If both fire in the same process (e.g., CLI invocation triggers in-line heal, then a Remediator-orchestrated invocation arrives later from a different code path), the second one short-circuits with the previous outcome. **Intended.** §A2 lock-bound co-existence requires exactly this: the MachineLock prevents two simultaneous rebuilds; the once-per-process flag prevents redundant retry. Cross-process retry is the A7 ledger's concern.
- **Double-fire:** `Remediator.dispatch()` for the same NATIVE_MODULE_ABI_MISMATCH event called twice concurrently → second call observes the first's in-flight MachineLock with the same tupleHash and returns `covered-by-inline`. Audit projection records both attempts (one `started + verified-healthy`, one `covered-by-inline`).
- **Race with adjacent cleanup:** None new. The dispatcher's `finally` block already releases the lock; the runbook adds no shared mutable state beyond `healAttempted` (which is process-local).
- **Feedback loops:** The runbook's surfaceCallable returns `outcome: success` based on whether `npm rebuild` exited 0, not on whether the resulting binding actually works. The verify() step is what closes the loop — if rebuild "succeeded" but `PRAGMA integrity_check` doesn't return 'ok', the Remediator records `verify-failed` and the churn counter ticks. After ≥5 verify-fails in 7 days (§A8 essential-runbook threshold) the runbook auto-quarantines. This is the correct shape.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Spawned subprocess.** `npm rebuild --ignore-scripts --build-from-source better-sqlite3` is invoked by `invokeFromRemediator`. The new flags vs the legacy path's `npm rebuild better-sqlite3` (no flags): `--ignore-scripts` (skips ALL deps' install scripts, not just better-sqlite3's) and `--build-from-source` (forces compilation rather than prebuild fetch). Net effect:
  - **`--ignore-scripts`:** the legacy in-line path runs the package's install script (which `prebuild-install` uses to fetch a prebuilt .node binary from GitHub). The new flag suppresses this — the build must happen via node-gyp. On systems without a working node-gyp toolchain, this rebuild will fail where the legacy one might have succeeded by fetching a prebuilt. Acceptable: the legacy path remains as the fallback when invokeFromRemediator returns failure, AND §A45 explicitly accepts this trade-off ("build-from-source preferred"). §A55's pinned-prebuild lockfile (future PR) restores the prebuild path with sha256 enforcement.
  - **`--build-from-source`:** parallel concern — `prebuild-install` honours this flag in better-sqlite3's install script (but `--ignore-scripts` already blocks that script). Including both is defense-in-depth in case `--ignore-scripts` doesn't honour every codepath in older npm versions.
- **No HTTP routes, no Telegram surfaces, no dashboard tabs, no config flags.**
- **No new file types on disk.** The healer's `native-module-heals.jsonl` log gains entries from `invokeFromRemediator` callers tagged `component='Remediator:node-abi-mismatch'`. Existing log readers see the entries with a new component string; no schema break.
- **No external API surface changes** — `RemediatorInvocationContext` and `RemediatorExecutionResult` are new public exports, but they are structurally compatible with F-8's `RemediationContext` and `ExecutionResult` types. The Remediator's `surfaceCallable: (ctx: RemediationContext) => Promise<ExecutionResult>` contract is satisfied because RemediationContext is a structural superset of RemediatorInvocationContext (it has all the latter's fields).

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Low. The new code paths have ZERO production callers in this PR — `DegradationReporter.setRemediator()` is still uncalled, so the dispatcher never fires, so the runbook's `surfaceCallable` is never invoked. Revert path:

1. `git revert <pr-sha>` removes both new source files and the test files.
2. The `invokeFromRemediator` method goes with the revert; `openWithHeal` remains untouched. Existing CLI consumers see no change.
3. No state migration. No on-disk format change. No HTTP route change. No new gitignore entries. No config-flip whitelist additions.

Once a future Tier-2 PR wires `DegradationReporter.setRemediator(remediator)` AND `remediator.registerRunbook(nodeAbiMismatchRunbook)` together, the rollback shape becomes "revert the wiring PR" — leaving this PR's primitives intact. The Tier-2 wiring is where the live consumer arrives; this PR is foundation.

If a bug surfaces in the rebuild flag set (e.g., `--build-from-source` breaks on a deployment target without node-gyp), the fix is to:
- Either drop `--build-from-source` from the rebuild command (and rely on §A55's signed prebuild lockfile to close the supply-chain gap once that lands), or
- Add a runtime check for node-gyp availability and fail-closed with `precondition-failed` outcome before spawnSync.

Either is a one-line change in `healBetterSqlite3FromRemediator`.

---

## Reviewer concurrence (Phase 5)

Not required. This PR has zero live block/allow surface, zero session lifecycle interaction, zero sentinel/gate/watchdog authority. It is foundation infrastructure that becomes load-bearing only when Tier-2 PRs wire the dispatcher into the DegradationReporter pipeline. At that point the wiring PR carries its own side-effects review.

The §A6, §A9, §A21, §A28, §A36, §A45, §A55 invariants are all structurally enforced by the existing F-8 validator + the runbook's hardcoded flag set. No reviewer subagent finding could change the shape of the invariants without changing the spec — and the spec is converged and approved.
