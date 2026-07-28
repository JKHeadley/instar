# Side-Effects Review — WS5.2 Step 10: livetest battery orchestration (dry-run→live promotion gate)

**Version / slug:** `ws52-step10-livetest`
**Date:** 2026-06-13
**Author:** echo
**Second-pass reviewer:** not required (no runtime gate/sentinel/session-lifecycle/messaging-block surface; the module is unwired-by-design tooling, run only at enablement)

## Summary of the change

Adds `src/core/CredentialRepointingLivetest.ts` — the §5 livetest battery expressed as testable orchestration — plus its fake-deps unit test. The harness drives the automatable battery items (a) enrolled-home swap round-trip and (b) default-home slot round-trip against INJECTED `swap` + `resolveIdentity` deps (wired to the real CredentialSwapExecutor + identity oracle only at enablement), verifying each swap by oracle identity (exchange-then-restore) and ALWAYS restoring the original layout. The inherently manual/destructive items — (c) post-swap refresher correctness and (d) the §0.c at-expiry residual via a disposable grant — are surfaced as required operator steps, never auto-passed. The module is **not wired into any runtime path**: it is the dry-run→live PROMOTION gate, which by the spec is NOT part of merge CI and runs only when the operator arms it at enablement.

## Decision-point inventory

- `CredentialRepointingLivetest.run()` — add — a guard (`armed`) and a verdict computation. It is NOT a runtime decision point in any live path: nothing in `server.ts` constructs or calls it. It only ever runs from a unit test (fakes) or, at enablement, an operator-armed entrypoint. The only authority it holds is over its own report (`promotable`), which is advisory input to the operator's enable decision — never an automated action.

---

## 1. Over-block
No block/allow surface — over-block not applicable. (The `armed` guard refuses to RUN the test battery when unarmed; it gates a test harness, not any user/agent action.)

## 2. Under-block
No block/allow surface — under-block not applicable. Worth noting the deliberate under-claim: `promotable` is `false` while any manual step remains outstanding, so the harness can never green-light promotion on automated checks alone.

## 3. Level-of-abstraction fit
Correct layer. This is test/validation tooling at the same abstraction as the executor it exercises, expressed over injected deps so the orchestration is unit-testable without IO (the established CredentialSwapExecutor fake-deps pattern). The real keychain/oracle wiring is deferred to the enablement entrypoint, keeping this module pure and verifiable.

## 4. Signal vs authority compliance
- [x] No — this change has no block/allow surface in any live path.

The `promotable` verdict is a signal to the operator's enable decision, not an authority that performs any action. (Ref: docs/signal-vs-authority.md.)

## 5. Interactions
- **Shadowing / double-fire / race:** none — the module is unwired; nothing else constructs or calls it. The `armed` default (`false`) guarantees that importing it (e.g. a future index re-export, or a test) performs zero swaps.
- **Executor interaction (at enablement only):** the harness calls the real `swap` exactly twice per round-trip (forward + restore) and verifies via the oracle between/after; it relies on the executor's own §2.3 safety (staging, verify, quarantine) — it does not re-implement any of it.

## 6. External surfaces
- No runtime/API/agent-facing surface today (unwired). At enablement the armed entrypoint performs REAL credential swaps on the operator's REAL accounts — which is exactly why it is gated behind an explicit operator arm + the feature's own enable check, runs WITH the operator, and always restores. This module itself ships inert.

## 7. Multi-machine posture (Cross-Machine Coherence)
- **Machine-local BY DESIGN.** The battery validates THIS machine's keychain + slots before promoting THIS machine's feature to live. Credentials and the identity oracle answers are per-machine; there is no cross-machine surface. Running it on one machine makes no claim about another (each machine is promoted on its own battery).

## 8. Rollback cost
Trivial. Revert the commit — the module is unwired, so removing it changes no runtime behavior. No state, no migration, no credential touch (the unit test uses fakes only). Any real swap the armed harness ever performs is itself the reversible, oracle-verified, always-restored round-trip from Step 5.
