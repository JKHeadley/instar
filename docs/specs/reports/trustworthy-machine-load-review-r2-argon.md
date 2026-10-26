# Review round 2 — Gemini 4 Argon, 2026-10-25

### 1. Verdict: Ready with changes

The revised spec resolves every round-1 finding cleanly and splits the rollout into well-bounded phases. One new architectural contradiction in P3 (how overload moves feed `OwnershipReconciler` without corrupting pins or invoking dead code) must be resolved before building Part D.

---

### 2. Round-1 Point Resolution

**GPT-6 Astra (Round 1)**
- **D2 dormant `RebalancePlanner` / missing channel scope (`CMT-1568`):** Resolved (§6 D1 fixes `CMT-1568` first and routes moves through `OwnershipReconciler`).
- **A1 changing `online` alters placement routing:** Resolved (§3 A2 preserves `online` and placement semantics in P1; P2 transitions explicitly).
- **A3 `ws44PoolCache` is not a background poller:** Resolved (§3 A4 piggybacks `peerSightings` on `PeerPresencePuller` `session-status`).
- **B1 available memory vs. native pressure + RSS fallback:** Resolved (§4 B1 separates both signals, removes the RSS fallback, and uses `null`).
- **Heartbeat plumbing (`SESSION_STATUS_ADVERT_FIELDS`) & coarse beat overwrite:** Resolved (§4 B1 adds explicit allowlist forwarding and a dedicated receipt-stamped slot).
- **Unsupported "starved server" certainty:** Resolved (§1 frames the incident as impaired reachability with multiple possible causes).
- **Manufactured evidence freshness:** Resolved (§3 A1–A2 use three distinct slots and preserve original observation age).
- **Reserved floor is not a hard resource guarantee:** Resolved (§5 frames C1–C2 as best-effort headroom with a host-wide `~/.instar/` lock file and `maxSessions: 1` handling).
- **Contradictory verdict rules / missing single-signal emergencies:** Resolved (§4 B2 defines a single decision table with an `impaired` single-signal emergency row and a 2-minute boot/wake grace).
- **Automatic movement safety contract:** Partially resolved (§6 D2–D4 add reservations, breakers, and deadlines, but see the new blocker below on `OwnershipReconciler` vs. `TransferOrchestrator`).
- **Unknown-load exclusion stranding the fleet:** Resolved (§5 C5 defines fallback ranking and router self-placement).
- **Oversized v1 (warden session + model adjudication):** Resolved (warden cut; model assessment deferred to P4 advisory shadow mode).

**Gemini 4 Argon (Round 1)**
- **`RebalancePlanner` dead code + `CMT-1568`:** Resolved (§6 D1).
- **Why peer `hardware` is null:** Resolved (§4 B1 sends `hardware` on every `session-status` report).
- **Coarse git heartbeats wiping out `loadAvg` / `LoadReport`:** Resolved (§4 B1 dedicated receipt-stamped slot).
- **`ws44PoolCache` vs. `PeerPresencePuller`:** Resolved (§3 A4).
- **`MachineLoadBroker` scope misdescription:** Resolved (§8 removed from spec).
- **`spawnSync('vm_stat')` event-loop lag on heartbeat path:** Resolved (§4 B1 moves to an async `execFile` 15 s cached sampler off the heartbeat path).
- **Cold-boot placement deadlock when all peers are `unknown`:** Resolved (§4 B1 samples at boot; §5 C5 ranks `live + unknown` above `stale` and never blocks placement).

---

### 3. New Blocking Issues

1. **P3 conflates two incompatible move engines (`OwnershipReconciler` vs. `TransferOrchestrator`) and leaves the proposal seam undefined (§6 D1, D4):**
   - **Pin pollution:** `OwnershipReconciler` (`src/core/OwnershipReconciler.ts:323, 412`) is strictly a *pin-convergence* loop: it only iterates `effectivePins()` where `pin.pinned && pin.preferredMachine`. Feeding unpinned overload-shed proposals into it via `pinStore` or `advisoryPins` will permanently pin shed topics to the target machine, violating user pin semantics and triggering `u41:pin-diverged` / `u41:pin-pending-aged` attention alarms if deferred.
   - **Dead `TransferOrchestrator` reference in D4:** §6 D4 specifies adding rollback logic to `TransferOrchestrator` (`:115`, `:125`). However, `TransferOrchestrator` is **never instantiated anywhere in `src/`** (only in unit tests). `OwnershipReconciler` does not call `TransferOrchestrator`; it performs direct local `ownership.cas({ type: 'transfer', to })` and already implements its own timeout recovery (`abort-transfer` after `transferDeadlineMs` at `OwnershipReconciler.ts:440–452`).
   - **Required fix:** Specify in §6 D1/D4 that `OwnershipReconciler` gets a dedicated transient `overloadProposals` input (separate from `effectivePins()`, so shedding never writes a durable pin) and that D4's stage deadlines and capacity-reservation release hook into `OwnershipReconciler`'s existing `abort-transfer` / `SessionDrainRunner` flow rather than the unused `TransferOrchestrator`.
