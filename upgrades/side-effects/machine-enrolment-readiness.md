# Side-Effects Review — enrolment readiness and refusals (CMT-1200, first slice)

**Version / slug:** `machine-enrolment-readiness`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `not required (read-only)`

## Summary of the change

Machine self-maintenance Part C, read-only. New `src/monitoring/machineMaintenance/enrolmentReadiness.ts`: `readReadiness()` decides `unattended` vs `attended` from bounded reads (macOS: `fdesetup status`, `defaults read` of `autoLoginUser`, and `plutil` of each agent's `ai.instar.<agent>.plist` RunAtLoad; Linux: root's `lsblk` ancestry for `crypt`, `loginctl` Linger, `systemctl --user is-enabled` of each unit; WSL attended only), with `ownerStep()` giving the card one plain step for the first missing setting. `enrolmentRefusal()` is the spec's refusal table (throwaway or test process; do-not-maintain marker, `shared` ownership or a container; another person logged in). `readEnrolment()` reads the host record (absent: not enrolled). `EnrolmentStatusReader` caches the reading for 10 minutes and `GET /machine-maintenance` (and `?scope=pool`) carries it as `enrolment`. Wired in `server.ts` inside the existing dev-gated, throwaway-excluded block. Nothing writes the enrolment record, installs a rule or restarts anything. Awareness entry `machine-enrolment-readiness`.

## Decision-point inventory

- Readiness verdict — add — invariant from the spec ("unknown means attended").
- Refusal table — add — invariant from the spec; read only, no tap exists yet.

---

## 1. Over-block

No block surface yet. A machine with any unread setting reads `attended`, which is the spec's safe side.

---

## 2. Under-block

The other-person check reads `who` only; the spec's second signal (processes under another uid with a tty) arrives with the tap slice and is re-read at actuation by safety hold S3.

---

## 3. Level-of-abstraction fit

A reading for the card and the later tap, at the layer the spec puts it; reuses the host registry census.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point; both are the spec's `invariant` rows.

---

## 5. Interactions

A status read may trigger at most one probe set per 10 minutes (cached, single-flight), each read bounded to 3 s. No timers.

---

## 6. External surfaces

`GET /machine-maintenance` gains `enrolment`. No operator action added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** (`hardware-bound-resource`), **proxied-on-read** pool-wide through `?scope=pool`; an unreachable machine is a failed row, never a guessed readiness.

---

## 8. Rollback cost

Revert and ship a patch. No state written.

---

## Conclusion

The card's facts, read honestly. Verified live on the Mac Studio on 2026-11-16: FileVault off, auto-login as the agent's user, all three co-resident agents set to start at login, no other person logged in, so it reads `unattended`. Clear to ship.

---

## Evidence pointers

- Unit: `tests/unit/machine-enrolment-readiness.test.ts`. Integration: `tests/integration/machine-maintenance-route.test.ts` (enrolment block).

---

## Class-Closure Declaration (display-only mirror)

No defect fixed and no self-triggered loop added.
