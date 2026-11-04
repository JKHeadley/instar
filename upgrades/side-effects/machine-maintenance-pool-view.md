# Side-Effects Review — Machine maintenance pool view (CMT-1199)

**Version / slug:** `machine-maintenance-pool-view`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `not required (read-only view; no gate, guard, lifecycle or messaging decision)`

## Summary of the change

Adds `?scope=pool` to `GET /machine-maintenance` and `GET /machine-maintenance/lock-state`. A new module, `src/server/machineMaintenancePool.ts`, asks every peer from `resolvePeerUrls()` for its PLAIN route (no recursion) through `poolPeerFetch` (rope-health recording), behind `isPeerUrlAllowedForCredentials`, through the shared `PoolPollCache` when it is wired, with a 2.5 s timeout, a 1 MiB body cap, at most 16 peers in batches of 4, and a 5 s per-part result cache in the route. It merges this machine's answer with the peers', tags each with `machineId` and a verified `machineNickname`, and lists unreadable machines in `pool.failed` with a closed reason set (`offline`, `url-rejected`, `not-enabled`, `route-missing`, `unauthorized`, `http-error`, `too-large`, `invalid-body`, `read-failed`, `peer-unreachable`). The plain routes are unchanged. The console Machines page reads the pool view and shows each machine's care line on its own card. CLAUDE.md awareness section + idempotent migration (sniff `/machine-maintenance?scope=pool`), CapabilityIndex description, release note.

Tier 1 (read-only, reversible by revert). Size: 1 new module (~210 lines), route wiring (~50), console model + page (~50), awareness section + migration (~25), 2 new test files + 1 extended. Effort: no spec rounds; one commit attempt planned.

## Decision-point inventory

- None added or modified. The failure-reason classification is a label on a read, consumed by nobody as an input to any decision.

---

## 1. Over-block

No block/allow surface. The plain routes keep their 503-when-dark behavior; the pool scope always answers 200.

---

## 2. Under-block

Not a gate. Known gaps in the view itself, all visible: a peer whose route answers 2xx with a non-maintenance JSON object is shown as its state (the body is data, not validated against the schema); a machine missing from `resolvePeerUrls()` (no known URL) does not appear at all, the same boundary as the other pool views that use this resolver.

---

## 3. Level-of-abstraction fit

Same layer and pattern as `/jobs/triage?scope=pool` (`createJobTriagePoolFetcher`: URL guard, `poolPeerFetch`, normalized reasons) and `/jobs?scope=pool` (`PoolPollCache`). The merge is a pure function so it is unit-tested without HTTP.

---

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

It is a read. The response says so explicitly (`authority: "none"`, `readOnly: true`, `canRestart: false`, `canStopWork: false`). A peer's own `canRestart` claim is carried as data inside `state` and never lifted to the view.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The status→reason map is a label, not a decision.

---

## 5. Interactions

- **Shadowing:** the new branch runs only when `scope=pool`; the plain route path is byte-identical.
- **Double-fire:** none; no side effects.
- **Races:** the per-part cache is per route-module instance; concurrent cold reads may both fan out (bounded, read-only).
- **Feedback loops:** peers are asked for the plain route, so a pool read never triggers another pool read. `PoolPollCache` keys include the route path, so a status read and a lock read do not share a cache entry.
- Rope health: peer dials record rope outcomes through `poolPeerFetch`, like every other pool read.

---

## 6. External surfaces

- Other machines of the same agent receive at most one plain GET per part per 5 s per reader (or per poll-cache interval when the shared cache is on).
- No persistent state, no external service, no messages.
- Operator surface: the console Machines page (read-only); no operator action added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** The page is a status page; the machine cards stay first, each now carrying its own "Restart care: …" line. No action is added.
2. **Zero raw internals as primary content?** Yes. Lines read "Up 9 days · practice run: would have waited a night"; failures read "Mama PC: can't tell, on an older version". Machine ids and reason codes are not shown; a machine with no verified name shows "a machine with no name yet".
3. **Destructive actions de-emphasized?** None exist on this surface.
4. **Plain language + phone width?** Lines reuse the existing `mc-evidence` card style (wraps, no table, no horizontal scroll); the summary uses the existing `note` block.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**proxied-on-read** — the maintenance state is machine-local by design (each machine's uptime, holds and lock are physical facts of that machine); the pool question is now answered by `?scope=pool`. No notices, no durable state, no generated URLs.

---

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state. The CLAUDE.md section left on updated agents would describe a scope the server then ignores (an older-style answer); harmless, and the console already treats an answer without `machines` as this machine only.

---

## Conclusion

A read-only, machine-tagged pool view built from the existing fan-out pieces. Clear to ship.

---

## Second-pass review (if required)

Not required: no gate, sentinel, watchdog, lifecycle, messaging or trust decision is touched.

---

## Evidence pointers

- `tests/unit/machine-maintenance-pool.test.ts`
- `tests/integration/machine-maintenance-pool-route.test.ts`
- `tests/unit/console-machines.test.ts` (machineCarePool)
