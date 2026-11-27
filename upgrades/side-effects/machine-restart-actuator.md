# Side-Effects Review — restart actuator, episode ledger and brakes (CMT-1199, second slice)

**Version / slug:** `machine-restart-actuator`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `not required (no caller: inert in this build)`

## Summary of the change

Machine self-maintenance Part C/D/E. Adds the pieces every future restart path must go through, with no caller yet. `HostMaintenanceStore` gains restart episodes in the host ledger `restarts.jsonl`: `reserveEpisode()` (the first write of every episode; checks the brakes; an operator request takes over an open episode with a new generation), `claimRung()` (under the host lock: episode open, generation current, plan unexpired, reserved on this boot, rung unclaimed, then a fresh check of the off switch and safety holds S1/S2; writes the attempt as `dispatched/unknown` and starts the command inside the lock), `recordDispatch()`, `transitionEpisode()` (refused for a stale generation), and boot attribution (the next boot after a dispatched episode is that episode's restart and closes it `restarted`). The ledger is fsynced after each append. Pure `checkBrakes()` holds the spec's brakes as constants: 6 h since boot (operator only with an explicit override), wedge 2/24 h and 3/7 d, scheduled 1/5 d, 3 aborted or refused in 7 d, proof-failed latch, any `outcome-unknown`, any open episode; an unreadable ledger refuses automatic restarts and lets an operator set it aside. New `RestartActuator` is the only file that holds the restart command lines (macOS `sudo -n /sbin/shutdown -r now` / `/sbin/reboot -q`, Linux systemctl, WSL `shutdown.exe`); a unit test fails the build if any other src file names one. It refuses outright in a test process (VITEST, CI) or a throwaway agent, and maps outcomes exactly as the spec says: never started is `refused`, exit 0 `accepted`, a nonzero sudo exit `refused` only when `sudo -n -l` no longer lists the exact line, everything else `unknown`.

## Decision-point inventory

- Brakes on restart episodes — add — deterministic invariants from the spec's table; no caller yet.
- claimRung admission — add — invariant checks plus the off switch and S1/S2 through an injected fresh check.
- Dispatch outcome — add — the spec's three-way mapping.

---

## 1. Over-block

No caller, so nothing is blocked in this build. By design an automatic restart is refused while any episode is open or `outcome-unknown`, and under 6 h of uptime; those are the spec's floors.

---

## 2. Under-block

The fresh check is injected: this slice proves the store calls it inside the lock and acts on its answer, not that the S1/S2 readings are correct (proven per OS in the spec's L7). A process frozen between claim and spawn past the lock's staleness bound is the spec's stated residual (one extra counted restart).

---

## 3. Level-of-abstraction fit

The single funnel the spec asks for: one store transaction family, one actuator, one source-pinned file for the commands. Callers (Restart now, scheduled drain, wedge rung 4, lifeline) come later and must go through it.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

In this build nothing calls it. When callers arrive, the brakes are invariant safety guards on an irreversible action (deterministic by design, per the spec's decision table), not judgment.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The brakes and claim checks are the spec's `invariant` rows (restart count brakes, proof-failed latch, is the reboot off); the judgment point (is this machine wedged) stays with `machineWedgeJudge`.

---

## 5. Interactions

- Shares the host lock with the drain record and the boot ledger, so reservation, claim, takeover and boot attribution serialize.
- The boot row written by `observeBoot` (PR 3249) now attributes a boot to a dispatched episode; with no episodes it behaves exactly as before.
- No timers, no loops, no routes.

---

## 6. External surfaces

None in this build: no route, no notice, no caller. Persistent state: episode rows join the existing host ledger file.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** (`hardware-bound-resource`): a physical machine's restart history and the privilege to restart it. Pool coordination (the `maintenance-claim`) is a later slice and is per-pool by the spec.

---

## 8. Rollback cost

Revert and ship a patch. Episode rows left in `restarts.jsonl` are ignored by the older reader (it keeps only boot rows).

---

## Conclusion

The safe core every restart path needs, inert until a caller exists. Clear to ship.

---

## Evidence pointers

- Unit: `tests/unit/machine-restart-actuator.test.ts` (brakes on both sides of each limit; claim refusals; fresh-check abort vs outcome-unknown; takeover and stale generation; boot attribution; unreadable ledger; outcome mapping; test-process and throwaway refusal; source pin).

---

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `guard` — `machine-restart` modelled in `src/testing/selfActionRegistry.ts` with the REAL `checkBrakes` on a durable ledger, an Eternal Sentinel proven by `tests/unit/self-action-convergence.test.ts` (enforcement: ratchet).
- **How caught:** under a wedge that never clears, sampled every 10 minutes for 7 days, the brakes allow 3 restarts a week, never closer than 6 hours (6 at twice the horizon).
