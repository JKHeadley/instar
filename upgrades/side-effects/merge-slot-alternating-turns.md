# Side-Effects Review — Bounded full-suite slot turns

**Version / slug:** `merge-slot-alternating-turns`  
**Date:** `2026-10-31`  
**Author:** Echo  
**Second-pass reviewer:** GPT-6 Astra reviewed the implementation and its fixes; full-suite gate recorded with the PR.

## Summary of the change

An optional `off|observe|enforce` policy lets a waiting merge verifier take the next free host full-suite slot ahead of an aged ordinary full-suite waiter for a bounded 12-second handoff. It never preempts a holder or raises the suite cap. The mode ships `off`. Spec: `docs/specs/merge-slot-alternating-turns.md`.

## Decision-point inventory

- `src/core/hostTestRunnerSemaphore.ts`: **add** next-slot turn decision at cap 1, only when a live merge claim and an aged ordinary waiter coexist. It checks holder identity, claim freshness, atomic turn state and a proof sidecar before any wait. Invalid or stale evidence returns to the existing policy.
- `src/server/routes.ts`: **observe** current mode and evidence on the existing authenticated limiter read route. It cannot change mode.
- `src/scaffold/templates.ts` and `PostUpdateMigrator`: **teach** new and installed agents how to read the feature; neither controls admission.
- Host tuning file: **operator opt-in** to `observe` or `enforce`; default `off`, independently scoped to each host.

## 1. Over-block

At enforce mode, an ordinary full-suite waiter can wait up to 12 extra seconds for a live merge verifier. Expiry, missing holder proof, changing PID, or a failed write ends the handoff and lets the old admission rule run. An already admitted suite is never stopped. The one-host cap remains 1.

## 2. Under-block

If the claim or proof is unreadable, the ordinary waiter may take the next slot before a merge check. That costs queue time but cannot weaken the test verdict or permit an untested merge. The status and event ledger expose the fallback so observation can distinguish a real turn from a claimed one.

## 3. Level-of-abstraction fit

The decision lives in the host semaphore where every guarded Vitest suite requests its slot, including serverless worktrees. A server-side scheduler alone cannot control unrelated ordinary suites. The server route is read-only.

## 4. Signal vs authority compliance

**Reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md). The optional enforce mode has admission timing authority only. Its deterministic checks bound a reversible wait to 12 seconds. Observe mode records the counterfactual without blocking. No signal or prose label can turn a failed suite green; Local Verify's full-suite record remains merge authority.

## 4b. Judgment-point check

No LLM judgment is used at the slot boundary. Live PID/holder/claim/age checks and an atomic state transition decide the turn; uncertainty follows the existing admission policy.

## 5. Interactions

The existing suite cap, targeted-lane cap, TTL reclamation, merge priority claim and nested Vitest ownership remain in force. A cap above 1 disables turns, avoiding a false single-slot contest. The turn metadata is host-local and cannot be imported as a peer verify result.

## 6. External surfaces

The existing authenticated `/test-runner-limiter` route adds mode/evidence. There is no new network write, message, or GitHub status from this policy.

## 6b. Operator-surface quality

Status says whether mode is off, observing, or enforcing and gives the last turn reason. A user can be told that a suite is waiting for the slot rather than that it is hung.

## 7. Multi-machine posture

The suite slot and its turn file are local to the physical host whose CPU and processes they govern (`hardware-bound-resource`). A verifier on Mini or M5 uses that host's own setting and ledger; Studio's turn file cannot control it. The Local Verify coordinator still owns merge authority under the parent capacity spec.

## 8. Rollback cost

Set `alternatingSuiteTurns: off` on the host. A current bounded offer expires within 12 seconds; active tests continue. Rollout uses 48 hours dark, isolated-agent rehearsal, then Echo observe and enforce windows before per-host fleet opt-in.

## Conclusion

The only new blocking side effect is a bounded extra wait for one ordinary suite in opt-in enforce mode. The failure direction leaves the existing slot policy in place and never changes a verification result.

## Evidence pointers

- `tests/unit/host-test-runner-semaphore.test.ts`
- `tests/integration/test-runner-limiter-route.test.ts`
- `tests/e2e/test-runner-limiter-lifecycle.test.ts`
- `docs/measurements/2026-10-31-verification-throughput-baseline.md`
