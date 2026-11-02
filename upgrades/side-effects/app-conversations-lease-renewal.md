# App conversations keep the serving lease renewed

## Summary

Tier 1, 4 source files (about 40 lines) plus tests. The server enrolls the existing holder-only lease renewal timer for native app conversations, as it already did for the Telegram origin writer. New `src/server/leaseRenewalDependencies.ts` names which surfaces need it; `MultiMachineCoordinator.enrollLeaseRenewalDependency(name)` generalizes `enrollOriginWriterLeaseRenewal()` (which now calls it). One review round, first commit attempt.

Root cause, measured with the real coordinator, FencedLease, LeaseCoordinator, LocalLeaseStore and HttpLeaseTransport (no peers), non-development config, flag omitted, no enrollment: the lease is held for one TTL, then lapses until the next 2-minute heartbeat tick re-acquires it at epoch+1 (60 s TTL: held 0-55 s, lapsed 60-115 s, epoch 2 at 120 s, and so on). Production TTL is 90 s, so about 30 s of every 2 minutes. `POST /mobile/chat/app/:key` admits only while `holdsLease()` is true, so app messages in the gap got `503 owner-unavailable`.

## Tests

Unit: tests/unit/lease-renewal-app-dependency.test.ts. Integration: tests/integration/mobile-native-conversations.test.ts (app message after the TTL: 200 with the dependency, 503 without). E2E: tests/e2e/app-conversations-lease-renewal.test.ts (real timers, the boot dependency decision, lease held past the window at epoch 1).

## Over-block

None added. The change removes refusals; it never adds one.

## Under-block

Agents with neither Telegram nor the app keep the standalone development-agent gate (unchanged). Other lease-gated surfaces on a Telegram-free, app-free agent (none known that a user reaches) are not covered.

## Level of abstraction

The same dependency-enrollment point the Telegram origin writer already uses, in server boot before `initializeLease()`.

## Signal versus authority

No new authority. Renewal only refreshes a lease this machine already holds at the same epoch; acquisition, the monotonic self-fence, higher-epoch supersession and observe-only refusal are unchanged and tested.

## Interactions

Development agents already ran this timer (dev gate). Telegram agents already ran it (origin enrollment). The new population is non-development agents with the app explicitly on and no Telegram. Explicit `resilientRenew.enabled: false` still wins.

## 6b. Operator-surface quality

The agent awareness paragraph "Origin lease renewal dependency" gains one sentence; existing agents get it through an in-place refresh in `migrateClaudeMd` and the shadow mirror.

## External surfaces

None. Lease broadcasts already happen on renewal; with no peers they go nowhere.

## Multi-machine posture

Holder-only on each machine. A higher-epoch holder elsewhere still wins (unit test).

## Rollback cost

Revert; no state, no migration to undo (the refreshed awareness sentence is prose).

## Class-Closure Declaration

`defectClass: missing-dependency-wiring`, `closure: fix`, `guardEvidence: { enforcementType: unit-test, citation: tests/unit/lease-renewal-app-dependency.test.ts, howCaught: a helper drove a Telegram-free throwaway agent from origin/main and every app message got 503 owner-unavailable until resilientRenew was turned on }`.
