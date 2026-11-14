---
title: "Resource-aware placement: weigh each machine's size with its load, and keep heavy work off small machines"
slug: "resource-aware-placement"
author: "echo"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
eli16-overview: "resource-aware-placement.eli16.md"
status: "approved"
approved: true
approved-by: "Echo, under its standing spec-approval grant (only constitution changes need Justin; this spec changes no constitution text). Reason: it implements Justin's direction in topic 134088 on 2026-11-06 — 17:40 \"Why is the studio getting overloaded? Don't we have ample additional machines? Part of the point of a multi machine mesh is to spread the workload\" and 18:30 \"Heavy Work should not go on the mini. Let's be intelligent about what machines we use based on the machine resource profile and it's current load. That should always be the default behavior for any multi machine, Instar agent\" — and the convergence report shows no remaining safety, security or data-loss finding beyond the recorded accepted risk."
approved-at: "2026-11-07T03:00:00.000Z"
review-convergence: "2026-11-07T02:58:26.876Z"
review-iterations: 6
review-completed-at: "2026-11-07T02:58:26.876Z"
review-report: "docs/specs/reports/resource-aware-placement-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Resource-aware placement

## Problem statement

On 2026-11-06 the Mac Studio ran at load 11–19 (16 cores). Echo's server stalled and was
restarted repeatedly, which killed Local Verify runs and held every merge for about two hours.
The load came from Echo's in-session helper subagents (Xcode builds, four simulators, vitest)
and the verify queue, all on the Studio, while other machines had room.

The operator's direction (Justin, topic 134088, 2026-11-06):

- 17:40 — "Why is the studio getting overloaded? Don't we have ample additional machines? Part
  of the point of a multi machine mesh is to spread the workload"
- 18:30 — "Heavy Work should not go on the mini. Let's be intelligent about what machines we use
  based on the machine resource profile and it's current load. That should always be the default
  behavior for any multi machine, Instar agent"

## What exists today (inventory, main at 49207b9594)

| Placement surface | Where | Resource profile? | Current load? |
|---|---|---|---|
| New topic/conversation placement | `src/core/PlacementExecutor.ts` `decide()` (L184–330), called by `SessionRouter` (L407, L439) and wired in `src/commands/server.ts` L28914 | **No.** `score()` (L166–172) adds the RAW 1-minute load average: a 10-core Mini at load 15 scores the same as a 16-core Studio at load 15. `requiredCapabilities` exists but nothing populates `gpu`/`fast-cpu` (`detectCapabilities()` in `MachineIdentity.ts` L106 returns `['sessions','jobs','telegram','tunnel']` for every machine). | Yes: raw load avg, session ratio, mem pressure; quota gate (L205), signed-out skip (via `quotaState.reason`), overload admission `isRefusingWork` (L142, L215), evidence-tier ranking `loadEvidenceTier` (L149) only when admission is enforced. |
| Overload admission | `src/core/workAdmission.ts`, verdict from `src/core/machineLoadReport.ts` (`deriveLoadVerdict` L121, thresholds L79: `saturatedLoadPerCore: 1.5`) | Per-core thresholds, so implicitly size-aware for a machine judging itself. | Yes, but ships dry-run: on Echo today `admissionEnforced: false` on every row, so placement never skips an overloaded machine and evidence ranking is off. |
| Overload shed / rebalance | `src/core/OverloadShedPlanner.ts`, `src/core/RebalancePlanner.ts` L104 | Inherits `PlacementExecutor` scoring (raw load). | Yes. |
| Scheduled jobs | `src/scheduler/JobScheduler.ts`: `isJobScopedToThisMachine` (L1383, the `machines` field), `takeClaim` (L1327, first-come journal/bus claim), `canRunJob` gate (quota/memory) | **No.** No notion of job size. | Only this machine's own session count, quota and memory gates. In the one-awake posture only the lease holder runs jobs. |
| Local Verify peer dispatch | `src/localVerify/LocalVerifyService.ts` `dispatchOnce` (L1733–1800), peers from `monitoring.localVerify.peers` (`configuredPeers` L1503) | **No.** Echo's config lists the **Mac Mini** as a verify peer, so full test suites go to the 16 GB Mini. | Only the peer's own idle/busy status, in config order. |
| Helpers / subagents | Claude Code's in-session Agent tool | **Cannot be placed**: a subagent runs inside the parent's process on the parent's machine. Instar has a remote start for a new topic session (`POST /sessions/create` with `machine`, `src/core/dashboardMachineChoice.ts`), but nothing chooses that machine by weight and nothing tells an agent to use it for heavy work. | — |
| "Work weight" (heavy vs light) | — | **Does not exist anywhere** in `src/`. | — |

Live fleet (`GET /pool`, 2026-11-07T02:32Z), cores / memory from each machine's own load report:
Mac Studio 16 / 64 GB (load average 21.8 on its capacity row; its own load report, sampled at a
different moment, said 1.50 per core), Mac M5 Pro 18 / 48 GB (0.71 per core),
Laptop 16 / 128 GB (6.77 per core), Mac Mini 10 / 16 GB (1.55 per core), Mama PC 10 / 12 GB, WSL.
Only the Studio's row carries `hardware`; for peers the load report is the only size evidence.

## Proposed design

### 1. One pure module: `src/core/machineResourceProfile.ts`

```ts
export type WorkWeight = 'light' | 'standard' | 'heavy';
export const HEAVY_WORK_FLOOR = { minCores: 12, minMemGiB: 32, maxLoadPerCore: 1.0 } as const;
export const LOAD_REFERENCE_CORES = 8;
export function profileOf(m): MachineResourceProfile;      // size + override + heavyCapable
export function freshLoadPerCore(m): number | null;        // fresh evidence only
export function placementLoad(m): number | null;           // the score's load term
export function heavyHeadroom(m, pending?): 'headroom' | 'busy' | 'load-unknown';
export function heavyFit(m, pending?): MachineFit;          // eligible + reason
export function inferWorkWeight(command): { weight, matched } // SIGNAL only
```

**Size** (static, so it may come from a stale report): `hardware.cpuCores` / `totalMemBytes`, else
the load report's `cores` / `totalMemBytes`. Cores are `os.cpus().length`, logical cores including
efficiency cores, as the load report already counts them. No size evidence → `size-unknown`. After a
server restart a peer has no report until its first beat (about 15 s), so for that window it is
`size-unknown`; this is an explicit tested case.

**heavyCapable**: the machine's own override `allow` → true, `deny` → false; otherwise
`cores >= 12 AND memory >= 32 GiB`; `size-unknown` → false. Today: Studio, M5 Pro and Laptop are
capable; Mini (10 / 16 GB) and Mama PC (10 / 12 GB, WSL, its own pool row) are not.

**Fresh per-core load** (the dynamic input, never taken from stale evidence): the load report's
`loadPerCore` when the report is fresh (age ≤ 60 s, `LOAD_REPORT_MAX_AGE_MS`); else
`loadAvg / cores` only when the row is `online`, `loadAvg` is a finite number ≥ 0, cores are
known, AND the beat that carried `loadAvg` was received within the same 60 s (`routerReceivedAt`
is that observation's receipt time; a coarse beat replaces the observation and drops `loadAvg`,
and `online` alone only proves the failover window); else null. A peer's raw `loadAvg` is not range-checked on receive today, so a negative or
non-finite value is rejected here rather than read as idle.

**Placement load term** (`placementLoad`): fresh per-core load × `LOAD_REFERENCE_CORES` (8), so
the term stays on today's scale (it equals the raw load average of an 8-core machine) and the
session-ratio and memory weights keep today's relative influence. Without cores, a raw `loadAvg`
that passes the same checks (finite, ≥ 0, online row, received within 60 s) is used as-is
(today's value). Otherwise null = unmeasured.

**Headroom** for heavy work: `busy` when the fresh verdict is `saturated`/`impaired`, or fresh
per-core load plus pending heavy work exceeds 1.0; `load-unknown` when there is no fresh per-core
load; else `headroom`. 1.0 per core is deliberately below the 1.5 "saturated" line: heavy work
should land where it will not itself push the machine over.

**Pending heavy work** (burst damping): each machine counts the heavy helper spawns it ACCEPTED
in the last 3 minutes and advertises the count in its own load report (`heavyPending`). A
deciding machine also reserves a slot on the target BEFORE it sends the spawn (released only on a
definite refusal, kept until expiry on an unconfirmed outcome), to cover the gap until the
target's next beat. The effective pending count is the larger of the two. Each pending item adds
0.5 to the machine's per-core load for headroom and ranking, so a burst of heavy helpers does not
all land on one machine before its load report catches up. This is approximate damping, not exact
accounting: reservations are kept to their 3-minute expiry (never released because the target's
count "took over"), `max` can undercount work from two different deciders, and an older target
that does not advertise a count leaves only the decider's reservation. Exactness is not needed:
the target's own load average catches up within minutes, and heavy headroom then reads it.

**inferWorkWeight**: linear patterns over the first 2,000 characters for build/test/simulator
commands (`xcodebuild`, `simctl`, a whole-suite `vitest`, `npm|pnpm|yarn test`, `npm run build`,
`pnpm build`, `tsc --build`, `cargo build`, `gradle`). It returns only `{ weight, matched }` (the
pattern label, never the input) and is never logged. It labels the preview; nothing refuses, moves
or skips work because of it.

### 2. Placement weighs size with load (`PlacementExecutor`)

- `score()` uses `placementLoad(m)` for its load term. Weights and policy keys are unchanged; the
  field comment on `weights.loadAvg` says it now multiplies the per-core load expressed at 8
  cores. A fixture or peer with a valid, fresh raw load and no size evidence scores exactly as
  today; the intended changes are that a machine with no fresh load no longer wins by scoring 0,
  and machines whose size is known are compared by per-core load.
- **Measured first**: the least-loaded and fallback steps, and the `best` comparison inside the
  sticky step, rank only machines with a non-null `placementLoad` when at least one exists; unmeasured machines are used only when no candidate is
  measured (today a missing `loadAvg` scores 0, the best possible; reviewers showed a coarse beat
  can leave it missing). Sticky, pins and every gate are unchanged.
- **Rebalance and shed**: `RebalancePlanner` only considers sources above 0.85 session ratio and
  `OverloadShed` only machines whose admission has stayed closed, neither keyed on the load term.
  For those sources the new term can change the decision — including choosing another machine
  where the source used to win, which is a move that would not have happened before. That is the
  intended effect (a big machine with room now wins over a small busy one), bounded by the
  planners' existing caps (one move per source per cycle, cool-down, pins and critical sessions
  never moved). Conversations on machines below those triggers are not moved by this change.
- `PlacementRequest.workWeight?: WorkWeight` (absent = `standard` = today's eligibility). `light`
  and `standard` add no filter. `heavy`, after the quota, admission and channel gates: keep only
  machines whose `heavyFit` is eligible (heavy-capable AND `headroom`). None capable →
  `queued`, `no-heavy-capable-machine`; capable but none with headroom → `queued`,
  `heavy-capable-machines-busy`; every candidate quota-blocked → `queued`,
  `all-machines-quota-blocked` (the conversation path's "place on a blocked machine anyway"
  fallback does not apply to a headless helper, which would fail silently there). `load-unknown` machines are not eligible (the same conservative
  stance as unknown size). Then least-loaded. Soft preference and sticky do not apply. A hard pin
  is honoured only when the pinned machine is in the eligible set; otherwise `queued`,
  `hard-pin-not-heavy-capable`.
- Seam: `pendingHeavy?: (machineId) => number` (the decider's reservations), defaulting to 0; the
  target's advertised `heavyPending` is read from its row.

### 3. Per-machine operator override, advertised by the machine itself

- Config on each machine: `multiMachine.placement.heavyWork: 'auto' | 'allow' | 'deny'` (absent =
  `auto`), read live at every load-report read.
- `MachineLoadReport.heavyWork?: 'allow' | 'deny'` (omitted for `auto`), set by the sampler from a
  live config read; `clampLoadReport` keeps only those two values. The same report gains
  `heavyPending?: number` (§1), clamped to 0–1000. It rides the existing
  authenticated heartbeat pull, so every deciding machine sees it within one beat. Older peers omit
  it (= `auto`).
- `allow` overrides only the size floor; a busy machine is still skipped for heavy work.
- The agent sets it on the machine it describes when the operator asks; `GET /pool` rows show it
  inside `loadReport`.

### 4. Local Verify peers respect size and load

- `LocalVerifyService` gains an optional seam `peerFit(machineId) → { eligible, reason, score }`.
  `dispatchOnce` skips ineligible peers and tries the rest in ascending `score`. Seam absent →
  today's behaviour. An audit event `peer-skipped-resource` is written at most once per peer per
  10 minutes per reason, so a peer hovering at the line cannot flood the audit log.
- Server wiring (a full verify is heavy work by definition): the peer's pool row is found by
  `machineId` (the same id `monitoring.localVerify.peers` already uses). No pool registry at all
  (pool dark) → today's behaviour, no filter. A pool without a row for that peer →
  ineligible, `not-in-pool` (consistent with "never send heavy work to a machine we cannot size");
  otherwise `heavyFit` decides (`machine-too-small`, `machine-busy`, `load-unknown`), and the score
  is the fresh per-core load.
- Effect on Echo today: the Mac Mini stops receiving full verifies; the M5 Pro keeps them while it
  has headroom.
- Takes effect once the coordinator (the lease holder) runs the new code; a coordinator on older
  code keeps today's peer order.
- Which verifies the coordinator runs in its own slot is unchanged here; a small coordinator
  running full suites itself is filed as instar feedback fb-f291c30d-bbe.

### 5. Jobs can declare weight

- `JobDefinition.workWeight?: WorkWeight`. In `triggerJob`, after the machine-scope check, a
  `heavy` job on a machine whose own profile is not heavy-capable is skipped with the new skip
  reason `machine-too-small` (skip ledger + `job_skipped` event naming the machine and size),
  unless the job's `machines` list explicitly names this machine (the author's explicit placement
  wins). The gate applies only while the pool knows at least one OTHER online, heavy-capable
  machine; an agent running alone, or whose only machines are small, runs the job as today
  (constitution: single-machine survivability — an agent must operate as is on any single machine
  it is installed on). Added at build time; it only narrows the gate.
- Honest limit: in the one-awake posture only the lease holder runs jobs, so while a small machine
  holds the lease a heavy job does not run; the skip ledger shows it each time, and after three
  such skips the scheduler's existing job-silence alert (already raised for repeated
  `machine-scope` skips, deduplicated to once a day, closed by the next success) names the job and
  says in plain words why it did not run and the two ways to make it run. Naming a larger
  machine in `machines` does not dispatch the job there (a read-only standby refuses jobs before
  the scope check); the job runs on the larger machine only once that machine holds the lease.
  Naming the small machine itself lifts the size check and runs it there, by the author's explicit
  choice. No built-in job declares `heavy` in this change, so nothing that runs today stops.
  Inference is never applied to jobs.

### 6. Sending heavy helper work to another machine

An in-session subagent cannot be moved. The agent gets two routes instead:

- `GET /pool/placement/preview?workWeight=heavy|standard|light[&command=...]` — a read-only dry
  run of `PlacementExecutor.decide()` on this machine's live pool view. Returns `answeredBy` (this
  machine's nickname), the decision (`chosenMachine`, nickname, `outcome`, `reason`), and one row
  per machine: nickname, cores, memory, size source, override, `heavyCapable`, fresh per-core
  load, load evidence age, verdict, headroom, pending heavy count, eligible and why not. With
  `command` (≤ 2,000 characters, else 400), it adds `inferWorkWeight`'s `{ weight, matched }`. It
  writes nothing and claims nothing. Bearer auth like every pool route; 503 without a pool.
- `POST /pool/heavy-work/spawn { name, prompt, workWeight?: 'heavy' (default) | 'standard', framework?, model? }`
  (there is no machine override: every request goes through the placement decision for its
  weight — `heavy` uses the heavy rules and takes a reservation; `standard` uses ordinary
  least-loaded placement and takes none)
  — places and starts a **headless** helper session (no Telegram topic, so no operator-visible
  noise and no Telegram requirement). Requires the `X-Instar-Request: 1` intent header and sits
  behind the same `spawnLimiter` as `/sessions/spawn`. Before deciding it applies `/sessions/spawn`'s
  own request checks (`SESSION_NAME_RE`, prompt ≤ 500 KB, the topic-binding rule from
  `resolveSessionSpawnTopicBinding` — a name that would need a topic is refused here — and the
  framework/model allowlist), so a request cannot pass locally and fail remotely. It then runs the
  heavy decision and sends `{ name, prompt, framework, model, workWeight }` to the chosen machine's
  `POST /sessions/spawn` — **every** target, this machine included (over loopback), so the target's
  own validation, rate limit, spawn caps and (where enforced) admission always apply. A self-targeted
  spawn passes the rate limiter twice (outer route, then loopback), so this machine's own helper
  rate is effectively halved; that errs toward fewer local heavy spawns, the intended direction. One URL per target (the first
  entry `resolvePeerUrls` gives, or loopback for self), never a fallback to a second path for a
  POST. Outcomes:
  - **started** (201) → `{ outcome: 'started', machine, nickname, sessionName, decision }`; the
    reservation is kept until its 3-minute expiry;
  - **refused** (the target answered 4xx: validation 400, rate limit 429, or the new 409s below)
    → `502 target-refused` with the target's answer; the reservation is released. Today
    `/sessions/spawn` turns every thrown error into a 500, including admission and spawn-cap
    refusals and a live duplicate name, so this change makes it answer those definite refusals as
    `409` with the errors' existing codes: `admission-refused` (`AdmissionRefusedError`),
    `session-capacity-refused` (`SessionCapacityRefusedError`), `session-exists` (the duplicate tmux name). An older target
    answers 500 with only the error message, so the forwarder also reads these exact message
    formats as refused: `admission-refused (…): …`, `Max sessions (N) reached with M running`,
    `tmux session "…" already exists`;
  - **unconfirmed** (timeout after 15 s, a dropped connection, or any other 5xx — a launch can
    fail after its tmux session started) → `504 target-unconfirmed` naming the machine and the session name;
    the reservation is kept. **An unconfirmed spawn is never retried.** The agent learns the
    outcome by reading that machine's sessions, finished ones included
    (`GET /sessions?scope=pool&include=all`): present → that is the helper; a failed read of that
    machine → still unknown, keep waiting. Only when that machine's own listing reads back
    successfully without the session after the 3-minute reservation has expired, AND the work's
    shared results and side effects show it did not run, may the agent start it again, as a new
    request with a new name through the normal decision. (A
    resend with the same name to the same machine would also be refused while the first copy is
    live, because the target refuses a duplicate tmux name — a backstop, not the mechanism.)
  - **queued** (no machine fits) → `409 heavy-work-no-machine` with the decision and per-machine
    rows; nothing is sent.
  On the target, `/sessions/spawn` with `workWeight: 'heavy'` records the accepted spawn in its own
  pending count (§1) after the session starts.
- **What a helper can do there**: the route carries only the prompt. The helper runs in that
  machine's own agent home, so its inputs must come from a shared source (a pushed git ref it
  checks out into a fresh worktree on that machine, a URL) and its results must go back through a
  shared channel (a pushed branch or PR, or a message to the parent session). The agent-awareness
  line says this; work that needs files only the parent machine has is not a fit for the route.
  The agent reads the helper's progress with the pool session views (`GET /sessions?scope=pool`).
- What the agent does on `409`: wait and retry (the reason names whether nothing is big enough or
  everything big enough is busy), or run the work locally only when this machine itself has heavy
  headroom per the preview. It never silently falls back to an in-process subagent on a busy
  machine.
- Agent awareness: one line in the CLAUDE.md template's multi-machine section, plus a
  `PostUpdateMigrator` migration guarded by the unique marker `Resource-aware placement (heavy work`
  (deliberately not containing `/pool/placement`, which an older migration uses as its own marker).
  The layout splitter files it with the machines reference like the neighbouring pool lines.

## Decision points touched

| Decision point | Classification | Why |
|---|---|---|
| Heavy-capable size floor (12 cores, 32 GiB) | `invariant` | Enumerable hardware facts plus an operator override per machine; unknown size → not capable. It never blocks a conversation; for heavy work it only narrows where. |
| Heavy headroom (fresh verdict saturated/impaired, or fresh per-core + pending > 1.0) | `invariant` (1.0 is a tuning constant on a measured input) | Reads the machine's own two-of-three quorum verdict and one fresh measured number; stale or missing → `load-unknown`, never idle. The action space is "another capable machine, or queued". |
| Placement load term (per-core × 8, measured-first) | `invariant` (tuning, documented) | A deterministic normalisation of an existing input, kept on today's scale. It changes ranking, and therefore which target a rebalance or shed picks (including new moves) inside the unchanged source triggers. |
| `inferWorkWeight` command classifier | `invariant` (signal-only detector; holds no authority) | Brittle by nature, so it holds no authority: it labels the preview only. |
| Verify peer eligibility | `invariant` | Same floor and headroom; the local slot is untouched, so a skipped peer only means the entry waits. |
| Heavy job on a small machine | `invariant` | Declared by the job's author; recorded as a skip; the author's `machines` list overrides it. |
| Heavy-work spawn forwarding | `invariant` | Executes the decision above; three explicit outcomes (started / refused / unconfirmed) each with the agent's next step in §6, sorted by the target's status codes (with the new 409 codes on `/sessions/spawn`); the target's own admission still decides whether it starts. |


## Signal vs. authority

No LLM arbiter is added; whether work is heavy is declared by whoever starts it. The placement
decision remains the single deterministic placement authority (`PlacementExecutor`), and every
heavy decision carries its evidence (the per-machine rows) in the preview and in the `409`.

The only brittle detector (`inferWorkWeight`) is signal-only. Every authority here acts on declared
intent (`workWeight`, the per-machine `heavyWork`) or measured, freshness-checked state. Placement
refusals mean "wait", each with a named reason (`queued`, `409`); the one refusal that is not a
wait, a heavy job skipped on a small lease holder, is recorded on every skip and documented as a
limit in §5.

## Multi-machine posture

- **Resource profile, headroom, placement load**: `proxied-on-read` — derived from each machine's
  own heartbeat on whichever machine decides; no new store. Evidence is held per observer, so two
  machines can briefly see different ages; the preview therefore names `answeredBy` and each row's
  evidence age.
- **Per-machine override `multiMachine.placement.heavyWork`**: a setting on the machine it
  describes, advertised in its load report so every decider reads the same value.
  machine-local-justification: hardware-bound-resource
  (it states that one machine's physical capacity for heavy work, and reaches every other machine
  through the authenticated heartbeat).
- **Accepted heavy spawns (`heavyPending`)**: counted by the machine that runs them and advertised
  in its own load report, so every decider reads the same value — the same advertised posture as
  the load report itself. machine-local-justification: hardware-bound-resource
  (it measures that machine's own committed capacity, like its load average).
- **Decider-side reservation**: an in-flight hold on requests this machine sent, in memory, capped
  (200 entries), living at most 3 minutes. machine-local-justification: hardware-bound-resource
  (an estimate, made on the deciding machine, of the target machine's committed capacity — not
  hardware state itself; it is made redundant by that
  machine's own load report within minutes; replicating it would outlive the reading it bridges).
- **Preview route and heavy-work spawn**: answer from this machine's pool view; the spawn reaches
  the chosen machine over the existing authenticated peer channel.
- **Verify peer fit**: computed on the coordinator from pool rows.
- **Job weight**: part of the job definition (jobs already sync); the skip is recorded in the
  existing skip ledger of the machine that skipped, like every other skip reason.
- No user-facing notices are added and no URLs are generated.

## Frontloaded Decisions

1. **Floor values**: 12 cores, 32 GiB, 1.0 per core for headroom — code constants. They split
   today's fleet as the operator described; the per-machine override is the lever.
2. **Unknown size or unknown fresh load**: not eligible for heavy work.
3. **Conversations stay `standard`**: small machines still take conversations; the operator's words
   name heavy work, and a conversation's heavy helpers are what this change moves.
4. **Override location**: the machine's own config, advertised in its heartbeat (the machine
   registry's cross-machine sync is not reliable on Echo today: peers' `hardware` is missing from
   the Studio's pool view).
5. **Verify peer with no pool row**: ineligible.
6. **Helper spawn is headless** (no Telegram topic), forwarded to the target's existing
   `/sessions/spawn`.
7. **Ships live by default** on every multi-machine agent (operator, 18:30: "That should always be
   the default behavior"). Paths that change at once on update: new-conversation placement
   (per-core scoring, measured-first), rebalance/shed target choice inside their unchanged
   triggers, and Local Verify peer hand-off (the Mini stops receiving full verifies). Rollback is a
   revert; the per-machine `heavyWork: allow` only relaxes the size floor for that machine and does
   not undo per-core scoring or the freshness and headroom rules.
8. **Unconfirmed helper spawns are not retried automatically** (§6): the outcome is read from that
   machine's session list instead, because no target-side request record exists to make a retry
   idempotent.

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** unit, integration and e2e tiers below, plus a read-only preview against the
  live fleet (heavy and light) from Echo's server, quoted in the PR.
- **dev-agent-live:** live on Echo from the release that carries it. For one week read the
  Local Verify audit for `peer-skipped-resource`, the preview for each machine's fit, and
  `POST /pool/heavy-work/spawn` outcomes in the server log.
- **fleet:** the same release, default-on (operator, topic 134088, 2026-11-06 18:30: "That should
  always be the default behavior for any multi machine, Instar agent"). The per-machine
  `multiMachine.placement.heavyWork` setting is the operator's override.
- **graduation criterion:** over the Echo week, no full verify handed to a machine below the floor
  (zero hand-offs to the Mac Mini in the Local Verify audit), at least one `peer-skipped-resource`
  row (a zero means nothing was exercised), and every heavy-work spawn outcome in the log is one
  of started / refused / unconfirmed / queued.
- **dark-window:** none. The change narrows where heavy work goes; holding it dark keeps the
  overload it exists to stop.
- **ladder:** not applicable: ships default-on by operator direction (topic 134088, 2026-11-06 18:30), the switch is a per-machine operator override

## Left behind (accepted risks)

- **A helper that started but was never recorded.** If the target delivers the prompt into tmux,
  then fails to persist the session record, and the spawn response is also lost, the target's
  session list can read back without the helper, and a later new request could start the same
  work a second time. One target crash can cause both failures. Because a helper's prompt can do
  anything, a second copy can repeat effects that are not safe to repeat (a push, a message, a
  change to shared state), not only duplicate computation. Mitigations: a same-name resend is
  refused while the first copy is live, and the agent-awareness line requires checking the work's
  shared results and side effects (the branch, the PR, the shared state it would change) before
  starting it again; an absent session is never enough on its own to repeat work with external
  effects. Durable target-side request records would close it and are not built here.
- **Self-spawn uses two rate-limit tokens** (outer route plus loopback), halving this machine's own
  helper rate; the safe direction.
- **Session names share tmux's 60-character cut**, so two long names with the same first 60
  characters collide; the second is refused as a duplicate (safe direction).

## Testing

- Unit: `machineResourceProfile` (size sources, override, floor edges, unknown, headroom, per-core
  normalisation, inference positives/negatives); `PlacementExecutor` heavy path (no capable,
  all busy, load-unknown fallback, hard pin in/out of heavy set, standard unchanged on
  size-less fixtures, per-core ordering Studio-vs-M5 shape); `clampLoadReport` `heavyWork`;
  scheduler `machine-too-small` skip and the `machines` override; Local Verify peer filter and
  ordering with the seam, and unchanged without it.
- Integration: `GET /pool/placement/preview` over HTTP (heavy picks the capable idle machine, light
  may pick a small one, 400 on a bad weight or an over-long command, 503 without a pool);
  `POST /pool/heavy-work/spawn` → `409 heavy-work-no-machine` when nothing fits, `403` without the
  intent header, local spawn when this machine is chosen, forward to a stub peer otherwise.
- E2E: the preview route alive through the real `AgentServer` with a real `MachinePoolRegistry`.
- Live: a read-only preview on Echo's real fleet for `heavy` and `light`, quoted in the PR.

## Rollback

Revert the PR. Per machine, `heavyWork: allow` lifts the size floor for that machine at once (a busy
machine is still skipped). No data or state migration: the load-report field is optional and older
peers ignore it; after a revert a leftover `multiMachine.placement.heavyWork` config key is inert.
