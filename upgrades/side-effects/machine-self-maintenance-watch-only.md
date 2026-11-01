# Side-Effects Review — Machine self-maintenance, watch-only core

**Version / slug:** `machine-self-maintenance-watch-only`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `see the section at the end`

## Summary of the change

Increment 1 of docs/specs/machine-self-maintenance.md. A dev-gated `DrainRehearsal` runs every night on paper against a real T-0: planner, host drain record, a declared work yield table, delay and safety hold readings, audit log, status route, one console line, awareness section. Tier 2, operator accepted the spec at the round cap (topic 134088, message 135179), with round 9's fixes unread. Size: 5 new source modules, about 1,000 lines, plus small wiring. Proportion: the spec took 9 rounds against a cap of 6; the source took one design pass.

## Decision-point inventory

- Rehearsal verdict (`would-restart`, `would-roll`, `would-hold`) — add — recorded evidence only. Nothing reads it to decide anything.
- Evidence gate (`evidence.met`) — add — reported only. No code flips on it.
- No admission, block, kill or message decision is added, modified or consulted.

---

## 1. Over-block

No block/allow surface. It refuses nothing. The one refusal is internal: a delay id outside the closed list is dropped from the paper arithmetic and logged.

---

## 2. Under-block

No block/allow surface. As evidence it has known gaps, each visible in the output: D4 to D7 report `active: null`; D1 counts Instar's own driven input as a person, so it can overstate presence and roll paper nights; a laptop asleep through the window records no night, and a server up after T-20 skips one; session boundaries are read from a pane tail, so they can be wrong for a framework whose prompt differs (Codex panes are not tuned here), though two reads in a row are required; a Slack session has no recorded identity on the session row, so it reads as D2, a false delay on paper that also holds the evidence gate until CMT-1199 gives it one. Evidence is kept honest in the safe direction: a session already at rest is counted and not sampled, a session that vanishes counts as over the limit, a late phase measures nothing, and only whole nights count. The test-run census sees only limiter holders.

---

## 3. Level-of-abstraction fit

A detector that feeds evidence to a later human-visible gate. It sits beside `WorkAdmission`, and deliberately reuses the host-file lock helpers rather than a new lock. The planner is pure so the real drain can reuse it unchanged.

---

## 4. Signal vs authority compliance

Signal only. It holds no authority of any kind, and this is enforced by `tests/unit/machine-maintenance-watch-only.test.ts`, which reads the source: no restart command words, no way to signal a process, exec only through one allowlisted runner, no callable yield in the table, no import of the session manager, scheduler, Local Verify or resume queue, and no admission path that reads this feature. Reference: docs/signal-vs-authority.md.

---

## 5. Interactions

Writes `~/.instar/host-maintenance/plan.json` and `acks/`, which nothing but this feature reads. `watchOnly` is forced true in the store. A later real build must not treat a leftover rehearsal record as a live drain; the flag exists for that. Reads session panes once a minute from T-20 to T-0, asynchronously through `captureOutputAsync` (made public for this), one session at a time; the rest of the day reads no pane. The host lock is synchronous with a 200 ms bound, so a stuck holder costs at most that per tick. Other reads run every 15 minutes outside the window. `JobScheduler` gains one read accessor. No shadowing or double-firing.

---

## 6. External surfaces

One new authed read route. One extra line on the console Machines page. One host-level directory visible to every agent on the login. On the fleet the route answers 503 and nothing runs. No LLM, no spend, no message. The console fetches `/machine-maintenance` on each Machines render; 503 hides the line.

---

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes, unchanged: the page keeps its machine cards first, and this adds one read-only line above them with no action to take.
2. **Zero raw internals as primary content?** Yes. The line reads "Restart care is watching only, nothing restarts. · Up 3.2 days · No practice run yet". No id, flag or enum is shown; `machineCareLine` maps each outcome to words.
3. **Destructive actions de-emphasized?** Yes. It adds no action of any kind.
4. **Plain language + phone width?** Yes on language. It uses the page's existing `note` element, which wraps. It was checked by unit test on the text and was not driven in a phone-width browser.

---

## 7. Multi-machine posture

Machine-local by design: a nightly rehearsal describes one physical machine, and the host record is per host. No replication and no proxied read in this increment; `?scope=pool` is CMT-1199. Each machine runs its own night. No notice, so one-voice does not arise. Nothing strands on a topic transfer.

machine-local-justification: hardware-bound-resource

---

## 8. Rollback cost

`machineMaintenance.enabled: false` stops it at the next tick, read live. A revert leaves an inert host record, an audit log and two state files. No migration or data repair.

---

## Class-Closure Declaration

`unbounded-self-action`, closure `n/a`: this change adds no self-triggered action. It reads the machine and writes its own records. `tests/unit/machine-maintenance-watch-only.test.ts` fails the build if an action appears. The registration in `selfActionRegistry.ts` arrives with the real restart (CMT-1199).

---

## Second-pass review

Independent reviewer, reading the code with no conclusion supplied. Raised a concern: no path to action, but evidence that could read better than the truth, and lint holes. All resolved before commit except the Slack identity false alarm, stated in section 2: idle sessions no longer sampled; a vanished session is not a yield, and one prompt read is not enough; late phases measure nothing; only whole nights count, deduped by episode; unreadable tmux reads as not read; stale acks ignored; slowest samples kept; `holds` written to the record; lock wait bounded and sleeping; boundary reads stop at T-0, read the tail and run async; commands reduced to a named table with exact arguments; lint changed from a denylist to an import allowlist. The fixes themselves were not re-read by the reviewer.
