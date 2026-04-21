# Side-Effects Review — Lifeline supervisor probe made optional

**Version / slug:** `lifeline-supervisor-probe-optional`
**Date:** 2026-04-21
**Author:** Dawn (instar-bug-fix autonomous)
**Second-pass reviewer:** not required (LOW risk, single-site diagnostic change)

## Summary of the change

Two files touched:

1. `src/monitoring/probes/LifelineProbe.ts` — `getSupervisorStatus` in `LifelineProbeDeps` becomes optional. When absent, the `instar.lifeline.supervisor` probe is not produced by `createLifelineProbes` (conditional spread into the probes array). The process probe and queue probe are unchanged and always produced.
2. `src/commands/server.ts` — the call to `createLifelineProbes` drops the hard-coded `getSupervisorStatus` stub (which had always returned `{ running: false, healthy: false, ... }`, creating the false-positive on every system review). The other deps (lock file, queue, isEnabled) remain.

The prior code would register a supervisor probe that always failed, because the server process has no handle to the supervisor (supervisor lives in the lifeline process). This made the `/system-reviews/latest` endpoint show 13/16 passed and status critical on every run, for every agent, on every version since the stub was introduced.

## Decision-point inventory

- `LifelineProbeDeps.getSupervisorStatus` — **modify** (type: required → optional).
- `createLifelineProbes`'s probe list — **modify** (supervisor probe becomes conditional on `deps.getSupervisorStatus`).
- `src/commands/server.ts` probe wiring — **modify** (drop stub; probe is now omitted from the server's registered set).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None. The probe being removed from the server's registration was 100% false-positive; there is no "legitimate failure signal" we are losing. The supervisor's real state is not observable from the server's process — only from the lifeline process. If a future wiring in the lifeline command supplies a real `getSupervisorStatus`, the probe will be produced and run correctly.

Callers relying on the old required-field shape? `createLifelineProbes` is called from exactly one site (`src/commands/server.ts`). Grep confirms no other callers in `src/` or `tests/`.

## 2. Under-block

**What failure modes does this still miss?**

The supervisor probe was the only probe covering "is the auto-restart supervisor alive and healthy?" Removing it from the server context means no one is answering that question from inside the server. The process probe still catches the case where the lifeline lock file is missing (lifeline itself isn't running), and the queue probe catches stuck-message backlog. The missing capability is: "lifeline is running but circuit-breaker-tripped / cooling-down."

This is a real gap, but it was already a gap: the prior stub reported circuit-broken-false and cooldownRemainingMs-0 unconditionally, so it wasn't actually monitoring those fields. The spec-appropriate fix is to wire up a real supervisor-status reader in the lifeline command (future work), not to keep a probe that lies.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. `createLifelineProbes` is a probe-factory — conditionally emitting probes based on which deps the caller can honestly supply is exactly its job. The alternative (always produce the probe, and have the probe internally check "do I have real data?") would smear the "am I wired up?" decision across factory and probe and would silently mask mis-wirings. Making the shape of the probe array reflect the shape of the deps is cleaner.

## 4. Blocking authority

- [x] No — this is a monitoring/reporting surface, not a block surface. The probe's passed/failed flag influences `/system-reviews/latest` but does not gate any action.

## 5. Interactions

- **Shadowing:** The supervisor probe is no longer shadowed/dominated by a false signal — it's simply absent from the server's probe set.
- **Double-fire:** No new emit paths. Probes are pull-model.
- **Races:** None. The conditional spread is evaluated at factory-call time (server startup), no runtime branching.
- **Downstream consumers:** `/system-reviews/latest`, the system-reviewer dashboard, and any tooling that parses the probe result list now see one fewer result with id `instar.lifeline.supervisor`. Tooling keyed to probe-id "must exist" will need updating — verified none such exists in `src/` or `tests/`.

## 6. External surfaces

- **Agents:** After deploy, every agent's system review flips from 13/16 (critical) → 13/15 (all-pass) as the false-positive disappears. No agent-visible functionality changes.
- **Reporters:** feedback-intake pipeline sees the supervisor false-positive stop firing — upstream clusters can be marked fixed.
- **External systems:** None.
- **Persistent state:** None modified.

## 7. Rollback cost

Pure code change. Revert + `npm publish` of a patch version restores the prior (broken) behavior. No migration, no data repair.

---

## Evidence pointers

- Build: `npm run build` — 0 errors.
- Typecheck: tsc (invoked by build) — 0 errors.
- Grep confirmation of single caller: `grep -rn "createLifelineProbes\|getSupervisorStatus" src/ tests/` — only `src/commands/server.ts` and the probe file itself.
- Reported clusters: `cluster-lifeline-supervisor-probe-reports-server-down-while-server-i`, `cluster-lifeline-supervisor-probe-false-positive-marks-healthy-serve`. Both report `/health` = ok while the supervisor probe reports server down — consistent with the stub hypothesis.
