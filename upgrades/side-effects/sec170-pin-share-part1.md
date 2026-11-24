# Side effects: per-machine shares of the agent's PIN guess budget (SEC-170, part 1 of 2)

In plain words: the dashboard PIN is the same on every machine of an agent, but each machine allowed unknown browsers 20 wrong guesses per 5 minutes, so N addresses gave N × 20. With `security.pinBudget.poolWide` on, each machine now allows only its fixed share of the agent's 20. The shares come from the machine's own registry and always sum to 20.

Tier 2: a security change on the public PIN routes, built from the approved spec `docs/specs/pool-wide-pin-budget.md` (converged, Justin approved 2026-11-22 14:56 PST). This is part 1 of 2; part 2 (the agreement protocol) is committed for 2026-11-24.

## What changes for running agents
- **Switch.** `security.pinBudget.poolWide`, file-only (`security` is not API-patchable), dev-gated: on for a development agent, off on the fleet. Off: every path below behaves exactly as today (cap 20, unflushed writes, no strict refusal, no new alert).
- **The share.** New `src/core/PinShare.ts`. Canonical division `floor(20 / N)` plus one for the first `20 mod N` ids in sorted order. N counts this machine and every registry entry that is not revoked (active and pending). No machine identity means the machine was never paired, so it keeps 20. The applied share is stored in `state/pin-share.json` plus `pin-share.prev.json`, each flushed (temp file, fsync, rename, folder fsync). It is lowered at once when the registry grows and never raised on its own. If both copies are unreadable, the share is 0 (reported as `PinBudget.recordsLost`). If membership can't be read, the stored share is kept. Recomputed at most every 5 seconds.
- **Consumers.** Unlock and step-up use `globalPinCap()` (`AgentServer.ts`). The email-code confirm uses `maxAttemptsLive` on `publicCapPinCheck` (`routes.ts`, `mandatePin.ts`). A cap of 0 refuses outright, both in `PinAttemptStore.blocked()` and in `createMandatePinCheck`.
- **Store.** With the switch on, `PinAttemptStore` flushes its writes. A failed write of the shared key refuses unknown browsers until a write succeeds, retried at most once a second. The flush runs only when on; the existing 4,096-row store test takes the same time as on main (about 30 seconds).
- **Alert.** With the switch on, `DashboardPin.bruteForce` also fires when the share is spent by more than one source, or in two consecutive 5-minute windows, with a 30-minute cooldown. A share spent by a few typos from one source stays quiet. The windows are wall-clock aligned, so the rule can occasionally fire early near a boundary (alert-only).
- **Advertised.** `seamlessnessFlags.pinBudgetPoolWide` and `seamlessnessFlags.pinShare` in the capacity heartbeat (display only).
- **Ladder.** New `pinBudgetPoolWide` entry. Dev-gated feature registry entry.
- **Owner's ways in** are untouched: an honored marker browser, the paired phone, local requests and approval links never touch this budget.

## Part-1 limits (closed by part 2)
- A newly paired machine takes its own equal share from its registry. While registries catch up, shares can briefly sum above 20 (spec §6's transient residual).
- A retirement raises nobody.
- If both `pin-share.json` copies are deleted (a state wipe or restore), the next first table can raise a share that had been lowered.
- There is no agent-wide alert backstop yet (20 failures across machines in an hour).

## Signal vs authority
The share is a deterministic floor (a cap), not a judgment. It can only refuse sooner, never admit more than the ratified 20 per agent.

## Second-pass review
**Reviewer:** independent Claude Sonnet subagent (fresh context, read-only, given the approved spec and the diff), 2026-11-22. First verdict: DO NOT CONCUR, with one blocking bug. A share of 0 admitted the first guess in each window, because `blocked()` only compared an existing row. Fixed in `PinAttemptStore.blocked()` and `createMandatePinCheck`, with tests. Re-review: CONCUR. It confirmed:
- All three consumers read the live share, and no consumer of the shared key stays on 20.
- The switch-off path is unchanged in enforcement.
- Restarts, corrupt files and membership failures cannot raise a share.
- Counting pending entries and treating no identity as never paired are safe.
- Every e2e assertion should pass against the real paths (tunnel host, per-IP limit, throttle coarse limit, marker cookie, local unlock).
Its non-blocking notes (release-note limits, the alert window edge, no alert unit test) are recorded above.

## Rollback
Set `security.pinBudget.poolWide` to false, or revert. `pin-share.json` can stay or be deleted.

## Tests
- `tests/unit/sec170-pin-share.test.ts` (12): division values and sums; adding a machine never raises a share (N up to 40, every position); off; never paired; first table stored in both copies; lowering; no raise on retirement or after restart; second-copy recovery and repair; both copies lost gives 0 and a report; unknown membership; registry statuses.
- `tests/unit/sec170-pin-store-strict.test.ts` (5): strict refusal until a write succeeds (on) versus unchanged behaviour (off); a cap of 0 refuses an empty store; counts survive restart; the email-code check refuses after the share and at share 0.
- `tests/e2e/sec170-pin-share-alive.test.ts`: a real server for a five-machine agent; not run by hand on this machine (standing rule), so it runs in Local Verify.
- Existing tests run here: pin-attempt-store-hardening, owner-pin-verifier, the feature-ladder and maturation tests, and lint-dev-agent-dark-gate, all passing.

## Class-Closure Declaration
- `unbounded-self-action`: closure n/a. The store's write retry is bounded to once a second, and only while a PIN check runs.
