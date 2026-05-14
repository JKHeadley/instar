# Side-Effects Review — Tier-2 DegradationReporter live-mode wire-up

**Version / slug:** `tier2-degradation-reporter-live-wire`
**Date:** `2026-05-13`
**Author:** `echo`
**Second-pass reviewer:** `not required (gated behind opt-in config flag default-false; legacy alert path + in-line healers remain the safety net)`

## Summary of the change

Adds `src/remediation/RemediatorBootstrap.ts` — a single async entry point `bootstrapRemediator({ stateDir, machineId, ... })` that constructs the full Tier-2 dispatch graph: F-1 `RemediationKeyVault` (4-backend probe), F-4 `MachineLock` + `IntentJournal` + `AuditWriter`, F-5 `TrustElevationSource` (with Telegram + CLI approval channels), and the F-8 `Remediator` orchestrator. Registers the runbooks that exist on main today (W-1 `nodeAbiMismatchRunbook`, W-3 `messagingDeliveryFailedRunbook`); logs and skips W-2 supervisor-preflight and W-4 db-corruption wrappers that haven't merged yet. Returns `{disabled: true, reason: 'no-secret-backend'}` if the vault probe finds no backend.

Modifies `src/commands/server.ts` to call `bootstrapRemediator()` IFF `config.remediator?.enabled === true` (defaults FALSE). On success, wires the Remediator into the existing `DegradationReporter` singleton via `setRemediator()`. On failure or disabled, logs a clear line and continues with the legacy alert path.

Files touched:
- `src/remediation/RemediatorBootstrap.ts` (new, 290 LOC)
- `src/commands/server.ts` (boot-path wire-in, ~50 LOC inserted after `connectDownstream`)
- `src/monitoring/DegradationReporter.ts` (1-line type widening: `RemediatorLike.dispatch` returns `Promise<unknown>` instead of `Promise<void>` so the real Remediator's `Promise<DispatchOutcome>` typechecks)
- `tests/unit/RemediatorBootstrap.test.ts` (new, 12 tests)
- `tests/integration/remediator-live-mode.test.ts` (new, 4 tests)
- `upgrades/NEXT.md` (release note entry)

Decision points the change interacts with:
- `DegradationReporter.setRemediator()` — the F-3 hook designed for exactly this wire-in.
- `Remediator.dispatch()` — authority for orchestrating remediation attempts. Not modified.
- `Remediator.registerRunbook()` — registry-load-time validator (§A6 / §A36). Not modified; surfaced via bootstrap.

## Decision-point inventory

- `config.remediator.enabled` — **add** — structural opt-in flag (boolean) controlling whether the bootstrap runs at all. Operator authority, not a runtime judgment.
- `DegradationReporter.setRemediator()` registration — **modify** — the F-3 hook was previously unused; this PR is its first real consumer. The setter itself is unchanged.
- `Remediator` lifecycle (construction + supervisor registration) — **pass-through** — bootstrap composes existing primitives without altering their decision surfaces.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. The bootstrap is dependency injection. The only branch decisions it makes are:

1. "Does the vault probe find a backend?" — if no, return `{disabled, reason: 'no-secret-backend'}`. This is the spec's prescribed fail-soft per §A62 (operating-state matrix → "OS Keychain Unavailable → try fallback"). Default behavior unchanged for the agent.
2. "Did the operator opt in via `remediator.enabled`?" — if no, skip bootstrap entirely. This is the staged-rollout default per §A57.

Neither branch rejects a legitimate degradation event. The legacy alert path remains the catch-all when the Remediator isn't wired.

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable in the sense of the principle. However, two structural under-block scenarios are intentional carve-outs:

- **Operator-enabled live mode but vault throws on construction (not `no-backend-available`)**: the bootstrap re-throws, the server boot path's outer try/catch catches it and logs a red error line; legacy alert path stays active. The agent does NOT crash. This is intentional — silently downgrading the operator's explicit opt-in to legacy mode would mask a real configuration error.
- **Runbook registry validation fails (W-1 ever ships a misshapen prefilter)**: bootstrap rethrows. The server boot path catches and logs. Legacy path remains active. The operator sees the failure on every restart until the wrapper PR is fixed.

The legacy alert path + in-line healers (`NativeModuleHealer.openWithHeal`, `ServerSupervisor.preflightSelfHeal`) catch every degradation flow regardless of Remediator state.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

The bootstrap is dependency injection — its level is "the seam between server boot and remediation tree." It does NOT belong inside the Remediator (whose job is dispatch decisions), inside `DegradationReporter` (whose job is event normalization + alert routing), or inside any single F-* module (each owns one primitive). It lives at `src/remediation/RemediatorBootstrap.ts` precisely because it composes across all those modules and the lifeline. The location matches how the spec describes the wire-in (§A33 + §A57).

The optional-runbook stubs (W-2/W-3/W-4) live inline as `tryLoadOptionalRunbook()` for now — when each wrapper PR lands, the stub gains a real import; the surrounding loop is identical. This is a transition-period pattern; once Tier-2 runbooks are all merged, the stubs collapse to direct imports.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface.

The bootstrap injects dependencies into existing authorities (Remediator dispatches; TrustElevationSource decides transitions; AuditWriter verifies tokens). It does not add a new decision point.

The `remediator.enabled` flag is operator authority via configuration — explicit human intent, expressed in `config.json`, not a runtime detector judging events. It is structurally identical to "should this server enable feature X" toggles already in `ProjectConfig` (e.g., `externalOperations`, `responseReview`, `inputGuard`).

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** The `RemediatorLike.dispatch` widening in `DegradationReporter.ts` (`Promise<void>` → `Promise<unknown>`) is the only modification to existing decision surface. Behavior is identical — the reporter never inspected the dispatch result; the audit log is the canonical record. Widening the type surface does not change runtime semantics. Confirmed via re-run of all 24 `degradation-reporter.test.ts` cases.
- **Double-fire:** When `remediator.enabled: true` AND a structured event arrives, the Remediator dispatches AND the legacy `reportEvent()` (feedback + Telegram alert) is skipped per existing F-3 contract — see DegradationReporter.report() L317-326. So no double-alert. The in-line healers in surfaces (NativeModuleHealer.openWithHeal etc.) are separate code paths that operate independently of the reporter and are unaffected.
- **Races:** The bootstrap runs during server start, AFTER `degradationReporter.connectDownstream()`. By the time the first `report()` could fire from any subsystem, the Remediator is either wired or the flag is off. The only race is during the `await bootstrapRemediator()` window — if a feature starts and reports a degradation in those ~hundreds of milliseconds, the event flows through the legacy path. This is acceptable: the legacy path is the safety net.
- **Feedback loops:** None. The Remediator's audit log is write-only from the reporter's POV; nothing routes audit entries back into `DegradationReporter.report()`.
- **Lifeline coexistence:** `ServerSupervisor` lives in the lifeline process (TelegramLifeline.ts), not the server. The bootstrap accepts `serverSupervisor` as optional and leaves it unwired in the server-side bootstrap. F-6's handshake remains intact: the supervisor's `registerRemediator` handshake fires only when a Remediator is constructed inside the same process. A future PR can hoist Remediator construction into the lifeline if cross-process supervision is needed.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine?** No.
- **Other users of the install base?** No behavioral change unless `remediator.enabled: true` is explicitly set in `config.json`. Default OFF = identical behavior to today.
- **External systems (Telegram, Slack, GitHub, Cloudflare, etc.)?** The Remediator's `requestPlannedRestart` would talk to a supervisor, but no `requestPlannedRestart` call is made by W-1 today (it only rebuilds better-sqlite3 in-process). No external API change.
- **Persistent state (databases, ledgers, memory files)?** When opted in, the bootstrap writes:
  - `<stateDir>/machine-locks/in-flight/*` (existing F-4 directory; no schema change)
  - `<stateDir>/remediation/intent-journal-<machineId>.jsonl` (existing F-4 file)
  - `<stateDir>/remediation/audit-projection-<machineId>.jsonl` (existing F-4 file)
  - `<stateDir>/remediation-keys.age` or keychain entries (existing F-1 store)
  - All paths are in the F-7 gitignore allow-list (`REMEDIATION_GITIGNORE_ENTRIES`), so multi-machine sync won't carry them.
- **Timing or runtime conditions we don't fully control?** The vault probe may hit OS keychain APIs (timing varies by host). Bootstrap is async and runs once at server start; failures don't crash the server.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** Revert the three-file change (Bootstrap module, server.ts insert, DegradationReporter type widening). Ship as next patch.
- **Data migration:** None. Even if Remediator-written state exists on disk (audit-projection JSONL, etc.), those files are inert — nothing else in the agent reads them, and they're in the F-7 gitignore allow-list. Operator can `rm -rf .instar/remediation/` post-revert if desired.
- **Agent state repair:** None. The `remediator.enabled` config field, if set, becomes a no-op after revert (unused config fields are ignored).
- **User visibility:** Zero during rollback window. Default OFF means almost no installed agent is exposed to the bootstrap path today. The handful of operators who opted in see the legacy alert path return (which is what the rest of the install base sees).

Rollback cost: very low.

---

## Conclusion

This is the canonical Tier-2 live-mode flip PR per §A57. The structural opt-in (`remediator.enabled` default-false) means no agent's behavior changes on day one. Operators who explicitly opt in get the full F-1..F-8 dispatch graph wired into the existing F-3 reporter pipeline. The legacy alert path and in-line healers remain the safety net regardless of Remediator state.

No new decision authority is added; no brittle blockers are introduced; the change is dependency injection at the seam between server boot and the remediation tree. Rollback is a three-file revert with no migration cost.

---

## Second-pass review

Not required. The change introduces zero new block/allow decision logic — every check it touches is in pre-existing modules (Remediator, TrustElevationSource, AuditWriter) whose authority surfaces have already shipped through their own side-effects reviews. The only structural change is operator-authority opt-in flag default-false; that is configuration, not runtime judgment.

---

## Evidence pointers

- Unit tests: `tests/unit/RemediatorBootstrap.test.ts` (12/12 passing).
- Integration test: `tests/integration/remediator-live-mode.test.ts` (4/4 passing).
- Regression: re-ran 97 tests across `Remediator`, `Remediator-enforcement`, `degradation-reporter`, `RemediationKeyVault`, `TrustElevationSource`, `MachineLock`, `AuditWriter`, `IntentJournal` — all green.
- TypeScript: `tsc --noEmit` clean across the worktree.
