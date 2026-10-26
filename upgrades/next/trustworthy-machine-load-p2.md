---
# user_announcement — SILENT BY DEFAULT (mature-update-announcements spec).
user_announcement:
  - audience: agent-only   # flip to "user" to announce to the user
    maturity: experimental # dev-gated + dry-run; refuses nothing until dryRun:false
    headline: "An overloaded machine now says it is not taking new work and keeps one slot free for you"
    body: "HUMAN-REQUIRED: one or two plain sentences for the user, matching the maturity above"
---

## What Changed

**Trustworthy machine load, phase 2 — overload admission + a reserved recovery slot** (spec: `docs/specs/trustworthy-machine-load-and-mesh-floor.md`, Part C; incident: `docs/issues/stale-machine-claims-and-overload.md`).

- **C1 — admission closes on overload.** `src/core/workAdmission.ts` is fed by the machine's own 15 s load verdict (phase 1). At `saturated` or `impaired` the machine CLOSES to new automatic work — scheduled jobs (the scheduler gate answers skip reason `overload` and retries on its bounded schedule), helper/headless spawns (`SessionManager.spawnSession` refuses with `admission-refused`), and placement of new conversations. It reopens after 5 consecutive `ok`/`elevated` samples (about 75 s); an `unknown` sample breaks the reopening streak but never closes admission. Nothing is dropped: jobs retry, inbound messages stay in the durable queue, existing conversations keep receiving messages.
- **C2 — one host-wide recovery slot.** A `HostSpawnSemaphore` of capacity 1 in `~/.instar/host-recovery-slot.json`, shared by every agent on the machine (the same mechanism as the LLM-spawn cap). While closed, a session the operator starts or asks for in Telegram may start only by taking that slot; it is released when the session ends (or reclaimed when the session is seen to be gone). A second operator session while the slot is held is refused with `recovery-slot-in-use`.
- **C4 — deterministic self-help.** After 3 consecutive overloaded samples, ONE attention item per closed episode names the top five processes by CPU and memory (agent-owned vs external, via an async `ps`). No model session is started.
- **C5 — placement never pushes work onto a refusing machine.** The load report now carries `acceptingWork` + `admissionEnforced`; `PlacementExecutor` skips a machine whose fresh (≤60 s), ENFORCED report says `acceptingWork:false` (a dry-run or stale report never counts as refusing). A hard pin to a refusing machine queues (never re-routes). If every candidate refuses, the decision is `queued` with `all-machines-refusing-work`: the message stays in the durable inbound queue, the user gets one fixed holding notice on the deterministic send path (once per topic per 30 min) and one deduped attention item is raised. When this machine enforces admission, placement ranks candidates by evidence (live `ok`/`elevated` first, then `unknown`, then `stale`, then `unreachable`) before least-loaded.
- **Posture.** Dev-gated (`monitoring.workAdmission`, omitted ⇒ live on a development agent, dark on the fleet) and **dry-run first**: the state machine, audit (`logs/work-admission.jsonl`, rotated at 2 MiB) and advert run on the real verdict feed, every refusal it WOULD make is logged and counted, but nothing is refused and peers keep placing work here until a deliberate `dryRun:false`. Status: `GET /work-admission`. The CLAUDE.md template gains the "overload admission" line; existing agents receive it through the update migration.
- **Not in this phase (by the spec's own phasing):** moving existing work off an overloaded machine is P3 (Part D); `nice +5` for spawned sessions (C3) is tracked in the spec's rollout as part of the P3 cut because it touches the shared spawn argv across three frameworks. <!-- tracked: docs/specs/trustworthy-machine-load-and-mesh-floor.md §7 (P3), topic 10000000832 -->

## What to Tell Your User

When one of my machines gets overloaded it now protects itself: it stops starting new background work until its own measurements say it has recovered, and it keeps one session slot free so you can always reach it and ask it to look at what is wrong. Other machines stop sending it new conversations until it reopens. For now this runs in "watch mode" on development agents — it writes down what it would have held back but holds back nothing — so you will not see any change in behaviour until it is switched on deliberately.

## Summary of New Capabilities

- `GET /work-admission` → `{ enabled, dryRun, enforced, acceptingWork, lastVerdict, goodStreak, overloadStreak, closedAt, recoverySlot: { cap, inUse }, counters: { closes, reopens, refused, wouldRefuse, recoverySlotGrants, recoverySlotRefused, selfHelpRuns } }` (503 when dark).
- `GET /pool` → `loadReport.acceptingWork` / `loadReport.admissionEnforced` per machine (absent from a peer on older code).
- `PlacementDecision.reason` / `escalationReason` gain `all-machines-refusing-work`; `SkipReason` gains `overload`.
- `SessionManager.setAdmissionGate()`; spawn refusals throw `AdmissionRefusedError` (`code: 'admission-refused'`, `reason: 'overloaded' | 'recovery-slot-in-use'`).
- New machine-local audit stream `logs/work-admission.jsonl` (registered: `audit-work-admission`, 2 MiB + one kept segment) and the host-wide `~/.instar/host-recovery-slot.json` holders file.

## Evidence

- Observed before (2026-10-25, live): the Laptop ran at a load average of 64–74 and the Mama PC at 11.5 while the pool kept both fully eligible for new work; `PlacementExecutor.score()` read a missing load as the best target and nothing on any machine declined new work.
- Reproduced in tests: `tests/unit/work-admission.test.ts` (close on one overloaded verdict, reopen only after 5 good samples, `unknown` breaks the streak, dry-run would-refuse vs enforced refuse, the shared recovery slot across agents, release on session end, self-help once per episode, audit rows); `tests/unit/placement-overload-admission.test.ts` (a refusing machine is skipped, all-refusing queues, a hard pin queues, dry-run/stale evidence never refuses, the evidence ranking on/off and with a broken seam); `tests/integration/work-admission-route.test.ts` (401/503/200 through the real route + auth); `tests/e2e/work-admission-lifecycle.test.ts` (a REAL sampler over the REAL OS readers feeds a REAL WorkAdmission, the self beat carries `acceptingWork` into a REAL `AgentServer`'s `GET /pool`, and `GET /work-admission` answers 200 after production-shaped init).
- After (expected on deploy, dry-run on the dev agents): `GET /work-admission` on the Studio/Mini shows `enabled:true, dryRun:true` and `counters.wouldRefuse` climbing during the next overload episode — the calibration evidence for the `dryRun:false` flip.
