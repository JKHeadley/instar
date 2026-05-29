# Session-Pool Build — Decision Log

Running log of judgment calls I (Echo) made autonomously during the build, per Justin's
"if any questions come up, make the call yourself and note them so you can let me know later"
(topic 13481, 2026-05-28). Each entry: the call, why, and how to reverse it if Justin disagrees.

---

### D1 — Open Design Decision #5 confirmed: ≤10-machine single-router v0.1
- **Call:** Took Justin's "go!" (without widening the envelope) as confirmation of the spec's recommended scope — v0.1 ships a single fenced router (RouterShardKey always shard 0), supported envelope ≤ `routerPoolMaxMachines` (10) machines / ≤ `routerMaxThroughputMsgPerSec` (500). Stamped `approved: true` + `approver-signoff: signed` on the spec.
- **Why:** It's the recommended default in the spec; it covers the real near-term target (laptop + mini + phone); multi-shard scaling is pre-specified on the `RouterShardKey` seam so it's not retrofit debt. Justin's "go!" was explicit approval and he delegated remaining calls to me.
- **Reverse:** widen `routerPoolMaxMachines` in config (envelope is a knob); multi-shard is its own future spec.

### D2 — Machine-nickname + Machines-tab requirement folded in WITHOUT full re-convergence
- **Call:** Justin added (topic 13481): a Machines dashboard tab (all machines + hardware props), auto-assigned + user-editable nicknames, and transfer-by-nickname ("move this to <nickname>"), with the nickname-driven mid-conversation swap as the headline test-as-self proof. I amended the approved spec in place (L2 registry gets `hardware` + `nickname` + a Machines tab; L4 command grammar resolves nickname→machineId and adds `move this to <nickname>`; Tier-3 + test-as-self gate updated; build plan: Track B builds registry+nicknames+tab, Tracks E/F the resolution+transfer, Track H the proof). I did NOT re-run the full 8-reviewer /spec-converge for this amendment.
- **Why:** The addition is additive and fully consistent with the already-converged L2/L4/dashboard design — no architectural change, no invariant change. Re-running the entire convergence for a well-scoped additive feature would burn hours against Justin's "complete it" directive. Instead I run a FOCUSED lessons-aware + Dashboard-Standard review when Track B (the dashboard tab) is built — that's where the real review risk is (the tab must follow THE Dashboard Standard).
- **Reverse / flag:** If Justin wants the full convergence re-run on the amendment, it's cheap to launch. Flagged in the spec header as a "Post-approval amendment".

### D3 — Track A core change: monotonic-local self-fence for the router lease
- **Call:** The existing `LeaseCoordinator` judges the holder's self-expiry/self-suspend on the WALL clock (`Date.now()` via `now()`), which an NTP step / VM-pause / sleep / CPU-starvation clock jump can fool (the exact SleepWakeDetector failure class). Track A adds a `monotonicNow()` seam (default `performance.now()`) and moves the holder's self-fence (the "have I confirmed a renewal within TTL?" decision in `renew()` and `holdsLease()`) onto the monotonic clock. Wall-clock stays ONLY for the human-readable `acquiredAt`/`expiresAt` display fields. Authority remains the epoch + push-rejection CAS (unchanged — already correct).
- **Why:** Directly implements spec §L−1 ("a holder's own expiry is judged on its monotonic-local clock, never wall-clock") + the LEASE-SUBSTRATE-ROBUSTNESS fold-in + review issue #2. Defense-in-depth: both the wall-clock expiry check and the monotonic self-fence must pass to hold; either can fence (conservative).
- **Reverse:** the monotonic seam is injectable; tests pin both clocks independently.
