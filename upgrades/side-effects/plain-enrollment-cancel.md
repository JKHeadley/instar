# Side-Effects Review — Plain enrollment cancellation

**Version / slug:** `plain-enrollment-cancel`
**Date:** `2026-07-10`
**Author:** `instar-codey`
**Second-pass reviewer:** `framework_guard_review`

## Summary of the change

The subscription enrollment API gains a target-local cancel route backed by the same shared lifecycle core as follow-me cancellation. It validates before lookup/target derivation, preserves terminal records, stands aside from completion, abandons durable state before best-effort raw tmux teardown, and logs honest outcomes. Capability discovery, installed briefings, and integration tests are updated.

## Decision-point inventory

- Enrollment cancellation — add — authoritatively transitions pending/expired records to abandoned.
- Terminal-state preservation — shared/modify — completed and abandoned records return idempotently without teardown.
- Completion/cancellation exclusion — add — cancellation returns 409 during same-id completion.
- Follow-me cancellation — refactor — behavior passes through the shared core unchanged.

## 1. Over-block

Cancellation is briefly rejected while the same login is completing. This is intentional: killing the pane in that critical section could strand partial credential state. Structurally valid lowercase alphanumeric/hyphen IDs are accepted; other shapes are rejected consistently with the store invariant.

## 2. Under-block

Best-effort tmux teardown may fail after abandonment, leaving a stale pane until the next enrollment pre-clean. The outcome log records `paneKilled=false`; authoritative state does not revert. Cross-process completion is not coordinated because the enrollment store and its pane are machine-local.

## 3. Level-of-abstraction fit

The shared helper is the correct route layer: it composes the existing store authority with the raw tmux primitive used by enrollment panes. Durable terminal guards remain enforced in `PendingLoginStore`; route-specific gates and in-flight registries remain outside the helper. Extraction avoids two kill paths drifting.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No semantic detector is given blocking authority; these are hard lifecycle and structural invariants.

ID-shape validation is boundary validation, and terminal/in-flight checks are enumerable state-machine mechanics. No conversational meaning or brittle intent inference is involved.

## 5. Interactions

- **Shadowing:** terminal inspection precedes the in-flight check, so an already-terminal record stays a calm read.
- **Double-fire:** state transitions are terminal-guarded; repeated cancel never repeats teardown.
- **Races:** same-process completion exposes a per-id lock. State is abandoned before pane teardown, so a crash cannot leave a reusable record after a kill.
- **Feedback loops:** no retry or notification loop is added.

## 6. External surfaces

The new authenticated HTTP endpoint and capability/briefing entries are visible to agents and API clients. It mutates the existing pending-login store and controls only the enrollment's raw tmux session. No secrets, URLs, external services, or new operator notification are involved. The dashboard cancel button is owned by GitHub issue #1203's parallel dashboard track. <!-- tracked: GitHub issue #1203 -->

## 6b. Operator-surface quality

No dashboard or form renderer changes; not applicable.

## 7. Multi-machine posture

**Machine-local by design:** pending-login records, framework config homes, and raw enrollment tmux panes belong to the machine conducting the login. The existing pool/follow-me routing selects the owning machine before target-local action. This endpoint emits no user-facing notices, creates no new durable state, generates no URLs, and does not alter topic transfer.

## 8. Rollback cost

Revert the route/helper, awareness entries, and tests, then ship a patch. Existing abandoned records remain valid terminal records under the prior schema. No migration, agent reset, or persistent-state repair is required.

## Conclusion

The change completes the ordinary enrollment API lifecycle while preserving the hardened follow-me behavior through one shared core. The ordering is fail-safe, terminal outcomes are idempotent, and rollback is code-only. Clear to ship after independent lifecycle review and CI.

## Second-pass review

**Reviewer:** `framework_guard_review`
**Independent read of the artifact:** concur

Concur with the review. The shared cancel core preserves the required order—shape validation and lookup before any pane derivation, terminal idempotence before in-flight handling, durable abandon before best-effort raw tmux teardown—and both plain and follow-me callers retain their own gates and per-id registries. Malformed/unknown ids produce no tmux call; completed records are byte-preserved; abandoned ids cannot be completed; expired records remain cancellable. The plain completion lock is installed synchronously before its only await and removed in finally, so cancel observes 409 during the bounded 10 ms critical section; that delay is small, deterministic in purpose, and does not expose partial state. Signal-vs-authority treatment is correct for structural lifecycle invariants. Focused plain/follow-me integration suites are green (22/22), including follow-me regression coverage.

## Evidence pointers

- `tests/integration/subscription-enrollment-routes.test.ts`
- `tests/integration/account-follow-me-cancel-route.test.ts`
