# Side-Effects Review — Window 32 expiry and close freeze

**Version / slug:** `window-32-expiry-freeze`
**Date:** `2026-09-05`
**Author:** `Echo / W32 Lane C`
**Second-pass reviewer:** `/root/w32_admission/instar_dev_review`

## Summary of the change

This change joins the existing WindowLifecycle ledger to the existing server-owned run-liveness authority at W32's two terminal boundaries. At the 24-hour ceiling it first revokes the liveness projection, then persists `closed_failed` and a frozen recurrence census. At successful close it first verifies every duty other than the necessarily-circular freeze duty, freezes liveness, derives that final duty from the server-owned final snapshot and census, and persists clean closure without a soak. Terminal liveness notification delivery is at-least-once: a durable intent and deterministic history marker suppress ordinary restart duplicates, while a successful send whose history row is not yet queryable may still be repeated.

## Decision-point inventory

- W32 ceiling classification in `src/server/routes.ts` — add — only the exact W32 catalog with a matching enabled, non-dry-run authority may terminally expire.
- W32 final-close preflight in `src/server/routes.ts` — add — any unresolved non-freeze duty refuses closure before active is revoked.
- Liveness terminalization in `src/core/WindowRunLivenessAuthority.ts` — modify — `freeze` can close cleanly or fail at ceiling and cannot recreate the same terminal run/lifecycle binding.
- Terminal window tombstones in `WindowRunLivenessStore` — add — a terminal `windowId` cannot be reopened by changing both run identities, while a genuinely new window may register.
- Terminal notification retry in `WindowRunLivenessAuthority.tick()` — modify — failed/stalled state retries the direct adapter until `notificationDeliveredAt` is durable.
- Lifecycle mutation guards — modify — `closed_failed` cannot be re-admitted, transitioned, or cadence-materialized.
- Integration-base commit-gate hygiene — repair — touched atomic-cleanup callsites now use `SafeFsExecutor`; the W32 capability readout uses the canonical dev-gate resolver; the already fleet-dark Codex continuation default is explicitly classified as cost-bearing and its hand-authored attribution test is synchronized.

## 1. Over-block

A legitimate attempt to reuse the same autonomous-run or lifecycle identity after terminalization is rejected. Recovery requires a genuinely new lifecycle/run identity; reusing a terminal identity would destroy the meaning of the frozen snapshot. A W32 close request with any unresolved duty other than `w32.close.expiry-freeze` is also refused before freeze. That is the approved charter boundary, not an accidental restriction.

Legacy W28/W31 ledgers, disabled liveness, and dry-run liveness are explicitly excluded from the new ceiling terminalization. They retain their prior behavior.

## 2. Under-block

If projection revocation itself cannot write any compatibility surface, closure is refused and the ledger stays nonterminal; the existing periodic retry continues. This can temporarily leave a genuinely stale legacy active marker until its writer becomes available, but the change does not lie by persisting terminal lifecycle success first. The production projection writer already attempts an inactive rollback on partial failure.

The lifecycle and liveness stores remain machine-local. A separate active authority on another machine is outside this ledger's authority; the observer-owner machine must remain the single writer for this W32 run.

## 3. Level-of-abstraction fit

The run-liveness authority remains the sole owner of active projection, terminal snapshot, audit chain, and failure notification receipt. The lifecycle layer owns source identity, duty census, ceiling, and phase state. The new code composes those authorities at the terminal boundary rather than independently guessing executor health or editing active files from lifecycle code.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — the logic is an authority enforcing enumerable invariants from server-owned state.

This is a blocking decision, but not a brittle text or conversational heuristic. Exact catalog identity, enabled/enforcing mode, immutable run/lifecycle binding, monotonic clock ceiling, authority-minted final snapshot, projection receipt, and duty census are protocol invariants. The liveness authority supplies the runtime judgment; lifecycle only consumes its durable verdict.

## 4b. Judgment-point check

No static heuristic arbitrates competing live signals. The five live predicates and recovery state are already reconciled by `WindowRunLivenessAuthority`. Lane C checks hard state-machine invariants: identity, authority mode, terminal state, timestamp boundary, census bounds, and presence of a projection receipt.

## 5. Interactions

- **Shadowing:** ceiling reconciliation runs before ordinary source/evidence evaluation, but only for exact enforcing W32. Once the hard ceiling is reached, no later evidence may reopen the failed window.
- **Double-fire:** lifecycle and liveness both tick each minute. `freeze` is snapshot-idempotent, terminal ticks do not sample or project again, and `notificationDeliveredAt` prevents duplicates after its receipt is durable. Before sending, the authority persists a deterministic notification intent; after restart it requeries live topic history for that marker. The external send and local receipt are not transactional, so an unavailable or not-yet-consistent history query can still produce a duplicate. The contract is honestly at-least-once, not exactly-once.
- **Races:** liveness revocation occurs before ledger terminal persistence. A projection throw leaves the ledger unchanged; a later tick retries. Store mutation locks serialize liveness tick/register/work/freeze operations.
- **Feedback loops:** the final-close freeze would invalidate current-active evidence if ordinary evaluation ran afterward. The W32 handshake instead preflights all other evidence while active, mints the freeze duty from the immutable terminal snapshot, and persists final closure atomically from the lifecycle side.

## 6. External surfaces

The existing lifecycle GET can now report `closed_failed`, and terminal mutation routes return `409` instead of reopening it. At ceiling failure, the existing Telegram adapter receives an at-least-once direct server-owned notice after a terminal liveness tick; its intent and successful delivery time survive restart. No topic is created, no URL is generated, and no new operator action is introduced.

Persistent version-1 ledger documents may now contain `state: closed_failed`. Existing liveness documents use their existing `failed`, `finalSnapshot`, `legacyProjection`, and `notificationDeliveredAt` fields, plus an optional durable `notificationIntent`. Hashed per-window tombstone files are stored beside liveness state.

## 6b. Operator-surface quality

No dashboard renderer, approval page, or operator form is changed. The only operator-visible output is a concise existing-channel failure notice; no action is required to acknowledge it.

## 7. Multi-machine posture

Machine-local by design: lifecycle and run-liveness truth describe one bound Echo observer/executor authority and its local compatibility projections. The terminal state and notification receipt live in the existing machine-local stores. The failure notice uses the same owning observer's direct Telegram adapter; a second machine must not independently own the same W32 lifecycle/run binding. No URLs are generated. Topic transfer would require a new authority binding rather than copying and reopening the frozen identity.

## 8. Rollback cost

Rollback is a code revert and patch release. `closed_failed` records should be retained as audit evidence; old code will parse the JSON but does not understand that state in its typed runtime paths, so a rollback while such a record exists should leave lifecycle enforcement disabled until the fixed version returns. No remote cleanup is needed. A delivered failure notice cannot and should not be retracted.

## Conclusion

The review narrowed terminal expiry to the exact W32 enforcing profile, reversed unsafe persistence ordering, resolved the freeze-evidence circularity with a source-bound final-close handshake, and added durable at-least-once notification retry. Unit, integration, and production-path E2E coverage exercises positive, negative, error, repeated-tick, and restart paths.

## Second-pass review

**Reviewer:** `/root/w32_admission/instar_dev_review`
**Independent read of the artifact:** Initial review found four gaps: failed snapshots could be relabeled clean, changed run IDs could bypass a terminal binding, generic terminal composition was not W32-scoped, and the notification wording overstated dedupe. The final change requires an actual `closed` snapshot for clean proof, persists per-window tombstones, gates every lifecycle/liveness terminal composition to exact enforcing W32, and documents plus tests durable-intent/history-marker at-least-once delivery. After correcting one remaining release-note overstatement, the reviewer concurred that all four code corrections and the honest delivery contract are complete.

## Evidence pointers

- `tests/unit/window-lifecycle-obligation-ledger.test.ts`
- `tests/unit/window-run-liveness-authority.test.ts`
- `tests/integration/window-lifecycle-expiry-freeze.test.ts`
- `tests/e2e/window-lifecycle-expiry-freeze-production.test.ts`
- `tests/e2e/window-run-liveness-production-wiring.test.ts`
- `tests/unit/lint-dev-agent-dark-gate.test.ts`
- `tests/unit/capabilities-discoverability.test.ts`

## Class-Closure Declaration

No agent-authored-artifact defect is involved. For the `unbounded-self-action` class, the existing lifecycle/liveness timers are modified at their terminal state boundary; convergence is guarded by immutable terminal states, idempotent freeze, per-window terminal tombstones, one persisted notification intent, live-history reconciliation, and a durable delivery receipt. Sustained ticks settle without sampling, projecting, recovering, materializing, or resending after that receipt.
