# Side-Effects Review — restart record and post-restart proof (CMT-1199, first slice)

**Version / slug:** `machine-restart-proof`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Machine self-maintenance Part D, the first slice of CMT-1199. Nothing here restarts a machine. (1) `HostMaintenanceStore` gains the host restart ledger `~/.instar/host-maintenance/restarts.jsonl` with `observeBoot()`: one `boot-observed` row per OS boot, written once under the host lock by the host maintainer, `first-seen` for the first boot ever recorded, else `unattributed` (attribution to an episode arrives with the actuator). (2) New `PostRestartProof` (`src/monitoring/machineMaintenance/PostRestartProof.ts`): every gated agent keeps a baseline of what worked (desktop ready, screen permission, signed-out login count, tunnel, relay, healthy co-resident agents), refreshed every 30 minutes once its boot is proven; after a new OS boot it proves server health, a verified lifeline proof since boot, relay, tunnel fetched through the tunnel, desktop against the baseline, logins no worse than before, and co-resident agents back, five attempts two minutes apart; an unread row never counts as a pass. Results: `state/machine-maintenance/restart-proof.json`, `logs/machine-maintenance.jsonl`, and `restartProof` in `GET /machine-maintenance` (and `?scope=pool`). `routes.ts` records the time of each verified `/internal/lifeline-proof`. Wired in `server.ts` inside the existing dev-gated, throwaway-excluded machine-maintenance block.

## Decision-point inventory

- Proof verdict per check — add — deterministic comparison with the pre-restart baseline; reported only.
- Boot attribution — add — `first-seen` / `unattributed`; reported only.

---

## 1. Over-block

No block/allow surface. A proof may read `failed` for something unrelated to the restart that broke in the window between the last baseline (at most 30 minutes old) and the reboot; the record names the check, and nothing acts on it.

---

## 2. Under-block

The sessions row (resumed conversations) is not proven in this slice; it needs planned-restart resume entries. A check that passes on the fifth attempt after something else repaired it reads `passed`. A hand reboot before this build is deployed has no baseline and reads `no-baseline` (`first-seen`) on its first boot.

---

## 3. Level-of-abstraction fit

Observability, at the layer the spec puts it. It reads existing state through the agent's own HTTP routes and in-process objects (subscription pool, quota poller); no reimplementation of health, tunnel or desktop logic.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The proof is a record and a status field. The spec's later use (the `proof-failed` latch on automatic restarts) belongs to the actuator slice.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point: each row is an enumerable comparison (was it working before, is it working now).

---

## 5. Interactions

- **Shadowing / double-fire:** none; the proof's 60-second tick only reads. Co-resident agents each prove themselves; only the host maintainer (the wedge maintainer heartbeat) writes the ledger, under the existing host lock, and a same-boot second write is refused by the jitter check.
- **Races:** the ledger append and the plan writes share one lock. A server restart on the same boot reads the saved proof file and starts nothing new.
- **Feedback loops:** none. The proof's own reads (local `/health`, `/threadline/health`, `/tunnel`, `/desktop/diagnostics`, co-resident `/health`, one fetch through the tunnel) are a few requests per minute during the ten-minute proof and every 30 minutes for the baseline.

---

## 6. External surfaces

- Other agents on the machine: their public `/health` is fetched; nothing written to them. The host ledger is readable by every agent on the login.
- External systems: one GET of `<tunnel>/health` through Cloudflare during a proof and per baseline.
- Persistent state: the host ledger (append-only, one row per boot), two per-agent JSON files.
- Operator surface: no operator-facing actions; the status is readable on the existing Machine care status route.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** (`hardware-bound-resource`): a machine's boot history and whether its own parts came back are that machine's truth. Pool-wide it is **proxied-on-read**: `restartProof` rides `GET /machine-maintenance?scope=pool`, so a dark machine shows as a failed row there, never a guessed proof. No notices in this slice (one-voice notices come with the actuator). No URLs generated.

---

## 8. Rollback cost

Revert and ship a patch. Left behind: an inert `restarts.jsonl` and two small JSON files no code reads after the revert. No user-visible regression.

---

## Conclusion

A restart can now be checked after the fact, whoever caused it, against what worked before it. That is the evidence the later actuator needs, and it measures the Studio's hand restart today once deployed before it (if not, the first boot after deploy records the baseline and the next restart is proven). Clear to ship.

---

## Evidence pointers

- Unit: `tests/unit/machine-restart-proof.test.ts` (ledger rows and jitter; each row against the baseline both ways; lifeline before boot; five-attempt bound; non-maintainer writes no ledger; disabled reads nothing).

---

## Class-Closure Declaration (display-only mirror)

The proof's 60-second tick is a read-only loop with no action verb; no self-action declared.
