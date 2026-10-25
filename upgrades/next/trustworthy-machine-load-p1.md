---
# user_announcement — SILENT BY DEFAULT (mature-update-announcements spec).
user_announcement:
  - audience: agent-only   # flip to "user" to announce to the user
    maturity: preview      # reporting only; the thresholds are being calibrated from shadow logs
    headline: "Machine status now says what is actually known: live, unreachable, stale or unknown, with how old the evidence is"
    body: "HUMAN-REQUIRED: one or two plain sentences for the user, matching the maturity above"
---

## What Changed

**Trustworthy machine load, phase 1 — honest evidence + a real load report** (spec: `docs/specs/trustworthy-machine-load-and-mesh-floor.md`, Part A + B1–B2; incident: `docs/issues/stale-machine-claims-and-overload.md`).

- Every machine in `GET /pool` now carries `liveness` (`live` / `unreachable` with a shape — `struggling`, `refusing`, `silent` / `stale` / `unknown`), the age and source of that evidence, a ready-made `livenessLine` (`<liveness>, last evidence <age> ago from <source>`), and the freshest sighting by another machine ("Mac Mini reached it 3 min ago"). The three kinds of evidence (a direct check from this machine, a relayed git heartbeat, a saved record) are kept apart and a relayed or saved record keeps its ORIGINAL age — re-reading it never makes it younger.
- The last direct contact with each peer (and the load it carried) is saved to disk (`state/machine-direct-evidence.json`), so a server restart renders `stale, last evidence 20 min ago` instead of "offline".
- A multi-signal load report rides every heartbeat: cores, load per core, CPU idle (measured from CPU-time deltas), available memory, the OS's own memory-pressure level, the agent server's event-loop lag, sessions in use, and whether the LLM-spawn and test-runner caps are saturated. A simple table turns it into `loadVerdict` = `ok` / `elevated` / `saturated` / `impaired` / `unknown` (2 of the last 3 samples, top-down precedence, 2-minute boot/wake grace). A missing measurement is `null`, never a substitute; a report older than 60 s reads `unknown`; a peer on older code reads `unknown`, never `ok`. Sampling is asynchronous and off the heartbeat path (the old synchronous `vm_stat` read would have inflated the very lag it sits next to). The never-populated `activeSessionCount` / `maxSessions` fields are now filled.
- One wording template everywhere — the pool view, the sessions-view machine rows, the dashboard Machines tab (status word + an Evidence row + a Load row), and the rope-health digest — and **no renderer says "offline" without positive evidence** (a unit test pins it). The CLAUDE.md template gains the rule; existing agents receive it through the update migration.
- Reporting only: the `online` flag, placement, ownership and the reaper keep their existing behaviour in this phase. Admission (P2), movement (P3) and model assessment (P4) are separate, dry-run-first changes per the spec.

## What to Tell Your User

When you ask about one of my machines, I now say what I actually know and how old it is — "live", "unreachable (struggling), last reached 40 min ago", "not checked since this server started", or "unknown" — instead of calling a machine "offline" just because it was slow or I had restarted. Each machine also reports its own load from several measurements (CPU, memory, how slow its own server is, sessions in use), so a busy machine, an overloaded one and a dead one no longer look alike. This phase only reports; it does not move work or block anything yet.

## Summary of New Capabilities

- `GET /pool` → per machine: `liveness`, `livenessLine`, `lastDirectLoadAvg`, `lastPullRttMs`, `loadReport`, `loadReportAgeMs`, `loadVerdict`.
- `GET /sessions?scope=pool` → `pool.machines[].emptyState.kind` gains `stale` and `unknown` with the same honest wording.
- Dashboard Machines tab → per-machine status word from the evidence, an **Evidence** row and a **Load** row ("overloaded — 96% CPU busy, 22% memory free, server lag 410 ms (as of 12 s ago)").
- Mesh `session-status` reply → `peerSightings` + `loadReport` (ignored by older peers).
- New durable, machine-local store: `state/machine-direct-evidence.json` (90-day retention, bounded by pool size).

## Evidence

- Observed before (2026-10-25, Mac Studio, live): after a 13:38 PDT server restart `GET /pool` showed the Mama PC as `online:false` with no timestamp and the rope-health summary said "offline — expected", while the Mac Mini had reached the same machine at 13:35 PDT with a load average of 11.5 — the machine was running and overloaded, and the "offline since Oct 23" wording came from a relayed registry record. Load fields were blank for every machine because `activeSessionCount` / `memPressure` / `maxSessions` were never filled.
- Reproduced in tests through production wiring: `tests/integration/machine-liveness-pool.test.ts` drives the REAL `PeerPresencePuller` → `MachinePoolRegistry` → `GET /pool` path against a real refused socket (renders `unreachable (refusing)` with another machine's sighting, never "offline") and simulates the restart (a fresh registry + evidence store on the same state dir renders `stale, last evidence 20 min ago from a saved record of a direct check` with the saved load 11.5). `tests/e2e/machine-load-report-lifecycle.test.ts` boots a real `AgentServer` after production-shaped init with the REAL OS readers (`vm_stat`/`sysctl`) and asserts `GET /pool` carries a report with identity, a sample age and filled session fields.
- After (expected on deploy, to be confirmed live on the Studio/Mini pair): the same restart now reads `stale, last evidence <age> ago from a saved record of a direct check`, and the Mama PC's own report arrives with `loadVerdict` as soon as it runs this version.
