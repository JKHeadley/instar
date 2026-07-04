---
title: External-Hog Zombie Auto-Kill Sentinel
status: draft
tag: review-convergence
parent-principle: "The Agent Is Always Reachable — A Guaranteed Reachability Floor"
parent-principle-fit: >
  The standard's traces-to-goal names this feature's exact scenario — "an agent that
  can become silently unreachable cannot be the solution to its own resource problems;
  the one actor with the tools to diagnose and free resources is locked out exactly
  when it is needed." An orphaned external process pinning the machine's cores starves
  the agent's own server (the 2026-07-03 ~24h/2.2-core incident). This sentinel is the
  machinery by which the agent DETECTS and RECLAIMS those resources itself — the
  observability floor guarantees no external hog is silently invisible, and the narrow,
  veto-bounded auto-kill reclaims the one provably-dead class — so the agent stays the
  solution to its own resource starvation instead of being locked out by it.
commitment: CMT-1901
author: echo
date: 2026-07-03
related:
  - src/monitoring/OrphanProcessReaper.ts
  - src/monitoring/McpProcessReaper.ts
  - src/monitoring/BurnDetector.ts
  - research/llm-pathway-bench/instar-bench-v2/tasks/zombie-classify.json
grounding_caveat: >
  Authored from the echo/serve-main runtime checkout (~100 patches behind
  master). Before build, re-verify against master: OrphanProcessReaper's current
  code (incl. `resolveOwningSession` / `findAllFrameworkProcesses` / the private
  `reportedExternalPids` report state), the ResourceLedger CPU-sampling API,
  SessionManager's terminate constants, the PostUpdateMigrator dev-gate strip idiom,
  AND — load-bearing — macOS cumulative-CPU-time acquisition: the v1 mechanism is a
  whole-table `ps -o pid=,ppid=,lstart=,time=,comm=` read (cumulative TIME, no new
  dependency); a `proc_pidinfo(PROC_PIDTASKINFO)` / `proc_pid_rusage` native addon
  is a follow-up. Re-verify `ps time=` granularity + failure behavior empirically <!-- tracked: CMT-1901 -->
  (the CPU-delta design pivots on it); ALSO verify `process.hrtime.bigint()`
  sleep-pause behavior on the target Node version (the monotonic-Δwall fix's
  EFFECTIVENESS — not going blind after wake — depends on it; SAFETY is independent
  via the implausible-Δwall guard). Also confirm the launchd-supervised process
  topology (launchd-direct lifeline has no tmux ancestor) for the own-root fallback.
lessons-engaged:
  - "Sovereignty — I own what is mine (the target processes are the operator's; the standard resolves to ASK, satisfied structurally by the operator directive + the PIN-gated arm — see §7)"
  - "Signal vs. Authority (the floor is a hard-invariant guard on an irreversible action; the model holds the judgment call — §2)"
  - "P7 LLM-Supervised Execution (the zombie-classify classifier IS the pipeline's LLM supervisor — effectively Tier-2 decision authority — with a fail-safe-to-alert unavailability policy; §2, §5)"
  - "P17 notification bounding / P19 no-unbounded-loop (§6)"
  - "#1069 event-loop safety (worker-side sampling AND worker-side kill-time re-confirm — §1, §4)"
  - "P18 Observation Needs Structure (alert delivery produces a durable artifact first — §6)"
  - "L5 State-detection robustness / Scrape-Parser Fixture Realness (the load-bearing ps CPU-time parser is registered with a captured realness fixture — §1, §Testing)"
review-iterations-so-far: 11
review-convergence: "2026-07-04T01:22:31.218Z"
review-iterations: 11
review-completed-at: "2026-07-04T01:22:31.218Z"
review-report: "docs/specs/reports/external-hog-zombie-autokill-sentinel-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 14
cheap-to-change-tags: 2
contested-then-cleared: 2
approved: true
approved-by: "Justin (verified operator, telegram topic 30379), 2026-07-03 — approved as-specified (AI-decides with the §7 soak spare-rate threshold; the deterministic-only alternative recorded in the convergence report was NOT chosen)"
---

# External-Hog Zombie Auto-Kill Sentinel

## Glossary (internal primitives referenced)

- **P17 / P19** — instar loop-safety standards: P17 = notification-flood bounding
  (coalesce, per-signature dedup, per-window budget); P19 = no unbounded loop
  (max-attempts, backoff, breaker).
- **OrphanProcessReaper / McpProcessReaper** — existing monitors. The former
  classifies processes as tracked/instar-orphan/external (external = report-only);
  the latter reaps orphaned MCP helpers (Playwright Chromium, Electron bridges) and
  owns `resolveOwningSession` (the ppid-chain ancestry walk this spec reuses).
- **Guard-Posture** — the `/guards` inventory: every guard reports
  `on-confirmed` / `on-dry-run` / `on-stale` / `errored` / `off`; a boot
  enabled→disabled flip trips the Guard-Posture Tripwire.
- **dev-gate (`developmentAgent`)** — the gate that ships a feature live-on-dev,
  dark-on-fleet by OMITTING `enabled` from config.
- **LlmQueue** — the shared, priority-laned, daily-spend-capped background LLM
  call queue (also serves the tone gate + PromiseBeacon).
- **Guard-Posture Tripwire** — the boot-time check that raises an attention item when
  a guard goes enabled→disabled between boots.
- **PendingRelayStore** — the durable SQLite-backed retry queue for outbound Telegram
  delivery (the layer that makes a notice survive a wobbly send).
- **hostSpawnCap** — the host-wide semaphore bounding concurrent LLM subprocesses
  (the fork-bomb floor); `maxClassificationsPerScan < hostSpawnCap` by design.
- **WS4.4 / WS5.2** — multi-machine-seamlessness workstreams: WS4.4 = pool-stable
  links + mesh-signed operator assertions; WS5.2 = account follow-me (the precedent
  that a dashboard PIN cannot cross the mesh).
- **CMT-NNNN** — a durable commitment id (follow-through tracking).
- **#NNN / #1069 / #863** — a referenced GitHub issue capturing a prior lesson
  (#1069 = event-loop-blocking process scans; #863 = an unbounded reaper kill-loop).

## Problem

An **external** process (not instar's own) can pin multiple CPU cores and starve
the agent server for hours before any human notices. The concrete incident
(2026-07-03): an orphaned VS Code editor-extension process — the MongoDB
extension's language-server work, reparented to launchd after the VS Code window
closed — held ~2.2 cores for ~24h. instar watches only its OWN processes for
runaway CPU; an outside hog is invisible to every existing guard until a person
feels the drag.

**Honest framing (round-11 — codex).** The GENERAL problem is "a runaway external
CPU hog goes unnoticed," and the OBSERVABILITY half (§4 floor: surface any sustained
external hog) addresses it broadly. The AUTO-KILL half is deliberately NARROW: v1's
kill class is the **Electron editor-extension-host WRAPPER** only (§3) — so v1 is,
honestly, an *Editor-Extension-Host-Wrapper auto-kill + general external-hog
observability* sentinel, not a general process killer. Whether the 2026-07-03 anchor
was that wrapper or a standalone language-server child is a build-time grounding gate
(§3); the design's value does NOT hinge on the anchor being a wrapper — the
observability floor catches every external hog regardless, and the narrow kill class
is the safe, evidence-gated starting envelope that later classes extend via reviewed
source changes.

## Prior art — and why we CANNOT simply extend it

`OrphanProcessReaper` classifies processes as `tracked` / `instar-orphan` /
`external` (external = report-only, never killed). The initial design proposed
sub-classifying within its `external` bucket. **Round-1 review killed that
premise (near-unanimous finding):** `OrphanProcessReaper.findAllFrameworkProcesses()`
pre-filters `ps` with a framework-needle grep (claude/codex/…). The 2026-07-03
target — a MongoDB extension language server — matches NO framework needle, so it
never enters the reaper's process list at all. **The subsystem we meant to extend
is structurally blind to the class of process this feature exists to reclaim.**

Consequence: this sentinel owns its **own** host-process discovery. It does not
reuse the framework-needle scan and does not reuse `killProcess()` verbatim.

## Design

**Candidate lifecycle at a glance (round-10 — a reason-ability aid; the sections are
authoritative).** A process moves through:

```
discovered (§1, own-euid, ancestry-excluded)
  → stage-1 candidate (cross-tick Δcputime/Δwall over threshold)
  → sustained-hog confirmed (§1 N-window delta ≥ cpuCoreThreshold)         ── else: dropped
  → classified (§5 one call/candidate; worst-CPU-first within maxClassificationsPerScan)
  → Stage-A admission (§4 fresh worker-side CPU micro-check; fail#1 → DEFER, 2 fails → ALERT)
  → in-flight kill (§4 Stage-B instantaneous re-checks twice; SIGTERM → grace → SIGKILL)
  → killed        ── OR at any gate: ABORTED-to-alert (floor veto / disarm / identity change)
                  ── OR: DEFERRED (fd-skip, capped by maxKillDeferrals) <!-- tracked: CMT-1901 -->
```
Every confirmed sustained hog that is NOT killed — model said `leave`, decider
unavailable, or any floor veto — is ALWAYS surfaced by the §4 observability floor.
Nothing kills unless `deterministic_floor_pass && classifier_verdict === 'kill'`.

### 1. Discovery + CPU signal (off the event loop, delta-based end to end)

**CPU signal is a DELTA everywhere — never `ps %cpu` (round-6 correction).** An
earlier draft justified this by calling macOS `ps -o %cpu` a "lifetime average";
that is the LINUX behavior. BSD/macOS `ps %cpu` is a **~1-minute DECAYING average**
(and `p_pctcpu` is frequently zero when `_PROC_HAS_SCHEDINFO_` is unset), so the
real reason to avoid it is precision + a bounded-history lag, not "lifetime." Both
STAGES therefore use a cumulative-CPU-time delta, never `%cpu`:
- **`sustainedHighCpu`** = per-pid `Δcputime / Δwall` in core-equivalents, where
  `cputime` is cumulative `(user+system)` CPU time. **v1 acquisition mechanism
  (settled, round-8):** a whole-table `ps -o pid=,ppid=,lstart=,time=,comm=,uid=`
  read — `time=` is cumulative CPU time (`[dd-]hh:mm:ss`), consistent with the
  stage-1 pass and needing NO new dependency. A `proc_pidinfo(PROC_PIDTASKINFO)` /
  `proc_pid_rusage` native addon (`pti_total_user + pti_total_system`, finer
  resolution) is an explicit FOLLOW-UP, not v1. NOT a `/proc` read (macOS has none) <!-- tracked: CMT-1901 -->
  and NOT `ps %cpu`.
  - **`Δwall` MUST be a MONOTONIC clock (round-9 — scalability/gemini; load-bearing
    on THIS machine).** Measure `Δwall` with `process.hrtime.bigint()` /
    `performance.now()` (mach_absolute_time-backed on macOS) — NEVER `Date.now()`.
    Two failure modes a wall clock creates, both acute here: (1) this machine
    sleep/wakes frequently — a window spanning sleep would read `Δwall` = hours (via
    `Date.now()`) while `Δcputime ≈ 0`, so `rate ≈ 0` and a real hog reads idle after
    every wake, the feature going blind exactly on resume; a monotonic source pauses
    during sleep, so `Δwall` naturally excludes sleep time and the rate stays
    accurate. (2) an NTP step mid-window distorts the ratio and could push an
    in-envelope non-hog over threshold — a monotonic clock is immune. **Guard:** a
    non-positive OR implausibly-large `Δwall` (≫ the intended window ⇒ the clock did
    something unexpected) → the field is UNKNOWN → alert-never-kill.
  - **`ps time=` quantization floor (round-9 — scalability; state it, not material
    for safety).** `ps time=` is ~1-second-granular. At the 30s window a ~2-core hog
    accrues ~60 CPU-sec, so ±1s ≈ ±1.5% — immaterial, well clear of the 1.5-core
    threshold. The 2.5s kill-time micro-window (§4) is deliberately sized so the
    0.5-core threshold sits at a safe quantization boundary: a 1-CPU-sec reading
    (~0.4 core) → SPARE (safe), ≥2-CPU-sec (~0.8 core) → proceed — the "still pinning
    ~2 cores vs went idle" signal dwarfs 1s quantization and near-boundary errors fail
    toward spare. The `proc_pidinfo` follow-up removes quantization entirely. <!-- tracked: CMT-1901 -->
  - **Failure behavior (fail-closed on data):** a pid that is gone, a zombie,
    permission-denied, or returns an unparseable `time=`/`lstart=` → the field is
    UNKNOWN → alert-never-kill. A process must exceed the core threshold across N
    delta windows to qualify. **The `ps`-table parser is REGISTERED with a captured
    realness fixture — see §Testing (round-9, load-bearing).**
- **Stage-1 candidacy also uses a delta, not `%cpu`.** Persist the previous scan's
  `(pid, start-time) → cumulative-cputime` map and compute candidacy from
  `Δcputime/Δwall` since the last scan — pure arithmetic over the already-captured
  snapshot, no extra sampling. **Map eviction is WHOLESALE REPLACEMENT each scan:**
  the map is rebuilt from the current `ps` table every scan (dead/rotated keys
  dropped), so it stays bounded by live process count even under fork-storm pid
  churn — never accumulate-only. This delta stage is essential: a process idle for
  23h that only NOW starts pinning cores has a diluted `%cpu` and would be dropped
  before the delta stage — exactly the emergent-hog case the feature exists to
  catch. Acceptance fixture: a long-idle process that becomes a hog in the latest
  window MUST be surfaced as a candidate; a high-average-but-now-idle process MUST
  NOT satisfy `sustainedHighCpu`.

**Two-stage, so cost is O(candidates):** (1) one cheap whole-table pass computing
the cross-tick delta selects candidates (typically 0–3); (2) the expensive
N-window confirmation + full-argv read runs ONLY on that small set. Stage-1 `ps`
reads `comm`, which is truncatable and argv-less — so allowlist token-matching,
`--parentPid` extraction, and the `command-hash` are all computed from FULL argv at
stage-2, never from `comm`.

**Discovery is scoped to the sentinel's OWN effective uid (round-8; round-9 unified
on `geteuid`).** Stage-1 discovery restricts to `process.geteuid()` — the SAME uid
notion the §4 kill floor uses, since signal-send permission is governed by the
EFFECTIVE uid (the round-8 draft scoped discovery to `getuid()` (real) while the floor
checked `geteuid()` (effective) — a self-inconsistent "hard invariant"; unified here).
A process owned by a DIFFERENT euid is NEVER a candidate — never classified, never
alerted, never a kill attempt. This is both a hard safety property (the sovereignty
grant covers only the granting operator's OWN processes — see §4's same-uid floor
invariant, of which this is the discovery-side half) and a privacy property (another
principal's process names/argv never enter this operator's classifier calls or audit
log). An arm-time precondition additionally asserts `getuid() === geteuid()` and
refuses to arm under privilege separation, so real and effective never diverge in
practice. The read-time same-uid check in §4 is the defense-in-depth backstop;
excluding at discovery is the primary gate.

**Exclude instar's OWN process TREE at discovery via an ANCESTOR-WALK, not a flat
pid set (round-8 — integration finding; the round-6 flat exclusion was defective).**
The round-6 flat set (agent-server, `session:*`, McpProcessReaper-known,
SessionManager-known, the sampler worker) covers only TOP-LEVEL instar pids — it
does NOT cover DESCENDANTS of a live session (vitest workers, `tsc`, compilers
spawned via the Bash tool), which routinely pin >1.5 cores for sustained windows on
this exact dev machine (the 2026-07-02 test-storm: 29 vitest roots). Under a flat
set those become confirmed sustained hogs → classifier spend + observability-alert
noise during every heavy build — precisely the false-hog noise the exclusion exists
to prevent. Fix: for each stage-1 candidate, **walk the ppid chain** and exclude the
candidate if its ancestry reaches a live/known instar tmux session pane OR an
instar-owned root pid (both sets — see below).
`McpProcessReaper.resolveOwningSession` (`src/monitoring/McpProcessReaper.ts`)
supplies ONLY the cycle-guard (`seen` set) + the hop-bound — it takes NO start-time
data and trusts each `tree.get(pid)` edge verbatim — so it must be **EXTENDED, not
reused verbatim (round-9 — adversarial)**: the process-tree snapshot carries per-pid
`(ppid, start-time)`, and each hop verifies the recorded parent's CURRENT occupant
start-time matches before trusting the edge. **Fail-direction on a start-time
mismatch = treat as NO-ANCESTOR (round-10 — adversarial corrected the rationale).**
This is the ANTI-EVASION direction: it prevents an EXTERNAL hog from FALSE-EXCLUDING
itself by walking a stale/reused edge into an unrelated live instar pane. It does NOT
(and need not) fix a "false-INCLUDE of an instar-own process" — that hole barely
exists on macOS (when an intermediate parent dies the child reparents to pid 1, so
the walk never follows a live reused pid), and instar-own protection is carried
instead by reparent-to-pid-1 semantics + the allowlist-class floor (§4), NEVER by
this walk's mismatch direction. **Grounding caveat:** re-verify against master
whether the tree / `tmuxPaneMap` builders expose per-pid start-times — they currently
do NOT, so this is an extension of the builder, not just the walk.
**BOTH a tmux-pane walk AND an own-root fallback set are required — the tmux-only
claim was topology-false (round-10 — integration, code-grounded).** The round-9 text
claimed a tmux-pane walk alone suffices because "instar's server + all sessions run
inside tmux panes." That holds ONLY on the lifeline→ServerSupervisor path (the server
lands in a `<project>-server` pane). Under launchd supervision — the PRODUCTION mode
of the target machine — the LaunchAgent runs the lifeline (`INSTAR_SUPERVISED=1`,
`setup.ts:1695`) as a DIRECT node child of launchd with NO tmux ancestor, and the
`--foreground` server topology has none at all; a same-euid sustained-CPU descendant
of the launchd-direct lifeline would have no tmux ancestor and become a false hog. So
the exclusion ALSO carries an **own-root fallback set**: the sentinel runs INSIDE the
server, so `process.pid` is the server root — ancestry reaching `process.pid`, a
recorded instar-spawned pid (the sampler; the resolvable lifeline pid), or a known
tmux pane is instar-owned. A correctly-orphaned target reparented to pid 1 has NO
instar ancestor (neither pane nor own-root) and passes the walk untouched (still
killable).
Acceptance fixture: a high-CPU child of a live tracked session is neither classified
nor alerted; an orphaned exthost with no instar ancestor is a candidate. instar owns
its own-process CPU story (BurnDetector, ResourceLedger); this lane is
external-only. `ResourceLedger` also can't supply the signal here — it samples only
instar-owned pids, not arbitrary external ones — so the sentinel uses its own
external-pid sampler.

**Off the event loop + cadence decoupled (round-6).** All sampling runs in a
worker/detached child, never a `spawnSync`+sleep loop on the server event loop (the
#1069 lesson). Critically, the N-window confirmation (default 3×30s = 90s) is
LONGER than `scanIntervalMs` (default 60s), so it CANNOT be a per-tick blocking
step — it would be abandoned every tick under single-flight and the feature would
be inert. Instead a **continuous rolling background sampler** maintains the last-N
cumulative-cputime deltas per candidate; the poll reads the most-recent COMPLETED
verdict (never blocks on a 90s sample).

**Two DISTINCT single-flight scopes (round-8 — the round-6 startup guard was a
vestige of the abandoned per-tick-blocking design).** There is no longer any
coupling `sustainedSampleCount × sampleWindowMs ≤ singleFlightBudget` — the poll
never blocks on the sample, so the poll's budget need not cover the 90s sample
product. Instead:
- the **background SAMPLER** has its own single-flight: it must finish one N-window
  cycle before the next begins;
- the **poll** has its own `singleFlightBudgetMs` (default 20000), sized to the
  cheap stage-1 scan that only reads the most-recent completed verdict — a stuck
  poll is declared stuck in ~20s, not 90s+.
Replacing the deleted guard, a **verdict-staleness bound** enforces freshness: a
completed verdict older than `sustainedSampleCount × sampleWindowMs + scanIntervalMs`
is treated as UNKNOWN → alert-never-kill (fail-closed on data).

**Sampler liveness — a dead sampler must never silently blind the feature (round-8
— scalability finding).** The rolling sampler is a new single point of failure and
is likeliest to die during the exact CPU/memory-starvation events this sentinel
hunts; a dead sampler → stale snapshot → no fresh candidates → no kills AND no §4
observability alerts, the very silent-invisible-hog failure this feature exists to
fix. So:
- (a) **Liveness is a per-cycle HEARTBEAT on a SUCCESSFUL read, not candidate data
  (round-9 — scalability; round-10 tightened the success condition).** The sampler
  advances `lastSnapshotAt` every cycle in which the stage-1 whole-table `ps` read
  SUCCEEDS — regardless of candidate count (the pass runs every cycle and rewrites the
  snapshot even when the candidate set is empty, the overwhelmingly common no-hog
  steady state). **A cycle whose `ps` read errors, times out, OR returns an
  IMPLAUSIBLE parse does NOT advance the heartbeat** (round-10 — scalability; round-11
  tightened "successful" to a plausible parse): a "successful read" for heartbeat
  purposes is spawn-ok AND a plausible whole-table parse (the sentinel's own euid pid
  present, or ≥ a minimum row count) — a spawn that exits 0 but yields zero parseable
  rows (macOS `ps` format drift) is treated as a FAILURE, so it does not advance. An
  *empty successful* read (zero CANDIDATES but a plausible table) advances; a
  *failed/implausible* read does not. Otherwise a persistent whole-table `ps`
  failure — an `EAGAIN`/`ENOMEM` on spawn under the exact CPU/memory starvation this
  sentinel hunts — would present a FRESH heartbeat while the sampler is blind (fresh
  heartbeat → not sampler-dead → no self-heal, and zero candidates → no kills and no
  §4 alert → fully silent blindness). With the success condition, a persistently
  failing read freezes the heartbeat → sampler-dead → P19 self-heal → degradation on
  persistent failure. The poll treats a HEARTBEAT older than
  `max(2 × scanIntervalMs, sustainedSampleCount × sampleWindowMs)` as sampler-dead.
  `lastVerdictAt` (legitimately absent/old when there are no candidates) is NEVER used
  for liveness — "no candidates" must never be classifiable as sampler-dead, or a
  healthy idle machine would thrash a restart every ~2 minutes (a transient single-
  cycle `ps` hiccup is absorbed by the 120s threshold + degrade-only-on-exhaustion).
- (b) On a sampler-dead heartbeat, **restart the sampler under a P19 bounded-retry
  cap**; the ONE coalesced degradation (§6) surfaces ONLY after self-heal FAILS to
  restore heartbeat freshness within the retry budget (self-heal first, notify on
  persistent failure — the silently-stopped-trio pattern; round-9 — integration),
  never on first detection.
- (c) The guard-posture row (§8) degrades to `on-stale` / `errored` on a heartbeat-age
  breach — NOT config-only.
- (d) `GET /external-hog` reports `lastSnapshotAt` (the heartbeat) and `lastVerdictAt`
  (last real candidate verdict) so staleness is observable and the two are never
  conflated.

**Single-flight + fail-closed on data:** any missing/timed-out sample → the field
is unknown → alert, never kill; a stuck scan never overlaps the next tick. The
sampler's snapshot artifact is written inside the agent home (sandbox-stable) at
mode `0600` via atomic rename — never a world-writable tmp dir — and the poll treats
it strictly as candidate hints; every kill-gate fact is re-read live from the OS (§4).

### 2. The decision: intelligence decides, WITHIN a mechanical safety floor

**Design correction (operator review, 2026-07-03):** an earlier draft made the
deterministic predicate the SOLE kill authority and the LLM a mere veto. That is
backwards relative to instar's "Intelligent Prompts / gates inform the LLM, who
makes the call" standard. Corrected model — **intelligence holds the decision
authority; the mechanical layer holds VETO authority**, never the reverse:

> **In one line (round-10 — clarity):** the model's "decision authority" means it
> may WITHHOLD a kill (spare an in-envelope process), never EXPAND kill eligibility.
> A kill executes iff `deterministic_floor_pass && classifier_verdict === 'kill'` —
> the floor defines the killable set (safety); the model only ever subtracts from it
> within that set (effectiveness). "Decider," throughout, means decider-within-the-
> envelope, not authority to widen the envelope.

- **The intelligence makes the call.** The benchmarked classifier
  (`zombie-classify`) decides **kill / leave / alert** for each candidate — the
  nuanced judgment ("is this a dead-weight zombie, a busy legitimate process, or
  something to just flag?"). This is exactly the judgment we WANT a model making.
- **Rigid code INFORMS it (facts, not decisions).** The classifier is fed the
  deterministically-computed DERIVED facts, each envelope-wrapped (§5): provenance
  signals, `ownerAppRunning`, the `sustainedHighCpu` CPU-delta, the launchctl-label,
  a same-uid boolean (not the raw uid value), and the matched class. **The raw
  `(pid, start-time, command-hash)` identity tuple is deliberately NOT a model input
  (round-8 — adversarial):** the model does not need it to decide kill/leave/alert,
  and omitting it denies an injection payload a concrete target to name in its
  logged "reason." The §4 floor recomputes every invariant on the exact
  code-surfaced candidate regardless, so withholding the tuple costs the model
  nothing.
- **The mechanical SAFETY FLOOR can only VETO a kill, never order one.** A kill the
  model decides on EXECUTES only if it ALSO clears every hard invariant in §4
  (allowlist class, provenance-of-orphanhood, not a launchctl-labeled job,
  owner-app-dead, same-uid as the sentinel's own non-root euid, not system/root,
  identity-tuple re-check at kill time, euid≠0). If ANY invariant fails, the kill is
  BLOCKED and downgraded to **alert** — no matter how confident the model is. The
  model can decide to kill anything *inside* the safe envelope; it structurally
  CANNOT get a kill executed *outside* it. **Stated as one equation: a kill executes
  iff `deterministic_floor_pass && classifier_verdict === 'kill'`** — a two-key AND
  of independently-necessary conditions.

Why the floor still matters even though intelligence leads: a process's name/argv
is attacker-controllable text the model reads, so a cleverly-named process could
try to talk the model into a bad kill. The floor makes that harmless — the worst a
successful injection achieves is a kill *within* the allowlist envelope (the
intended action) or sparing a real hog (safe direction). Injection can never
EXPAND the target set. Intelligence drives; the floor bounds the blast radius.

**Honest scope of the model's authority (round-6 refinement — codex + lessons-aware).**
Because §4 promoted `sustainedHighCpu` into the floor, the floor is now a COMPLETE
deterministic kill predicate, so mechanically a kill fires iff `floor-passes AND
model-says-kill` — a two-key AND of necessary conditions. That makes the model's
authority **subtractive**: it can SPARE an in-envelope process (say `leave`/`alert`)
but can never authorize a kill the floor wouldn't independently green-light. This
is deliberate and correct for an irreversible action — **kill-SAFETY is carried
entirely by the floor; the model carries EFFECTIVENESS**: the genuinely nuanced
call the rules can't make — "is this allowlisted orphan dead-weight, or a language
server still doing real work I should spare?" — plus the triage/alert judgment on
the broader ambiguous-hog population that isn't a narrow-allowlist kill candidate.
The `zombie-classify` benchmark therefore measures the model's false-leave /
false-alert rate (effectiveness), NOT kill-safety. This is the honest, precise form
of "intelligence decides, structure bounds" — the model decides *within* a set the
structure has already proven safe.

The deterministic facts fed to the model, defined concretely:
- **Provenance-of-orphanhood, not bare `ppid===1`.** On macOS every LaunchAgent
  has `ppid===1` by design. Accepted provenance: (a) instar OBSERVED the process
  transition from a real non-1 parent that has since died (track pid→original-parent
  across the sample window; guard against parent-pid reuse via start-time); OR
  (b) for the editor-exthost class, the process carries `--parentPid=<N>` in argv
  and that named pid is dead. Bare `ppid===1` with no provenance is a floor VETO.
- **launchctl label** — a labeled launchd job is a floor VETO (managed; killing it
  invites a respawn loop).
- **`ownerAppRunning` — the SPECIFIC spawning parent, NOT "any window of the app"
  (round-6 correction).** For the editor-exthost class, `ownerAppRunning === false`
  means the SPECIFIC `--parentPid` process that spawned this exthost is dead
  (start-time-verified) — identical granularity to provenance (b). It must NOT mean
  "any process of the GUI app is alive," because an exthost is spawned per
  window/workspace: with that coarse rule, having ANY other editor window open
  would VETO the kill and the sentinel would fail on the exact 2026-07-03 anchor
  incident (multiple windows is the common case). `ownerAppRunning` is
  class-parameterized; owner cannot be positively established → floor VETO. (The
  prior art's loose `command.includes('code'|'Electron'|…)` substring heuristic is
  NOT used as floor authority — spoofable and false-positive-prone.)
  **Comparison direction, defined (round-8 — adversarial):** on the effective v1
  provenance path (b, post-restart, when no original-parent start-time is on disk —
  only argv `--parentPid=N`), `ownerAppRunning === false` iff pid `N` is ABSENT, OR
  its current occupant's start-time is LATER than this child's (so `N` was reused and
  cannot be the real parent). Otherwise (`N` alive AND started before the child) →
  treat the parent as live → floor VETO. A naive "does pid N exist?" over-vetoes but
  still fails SAFE; this precise rule avoids the false veto on a reused parent pid.
- **`sustainedHighCpu`** per the CPU-delta definition in §1.
- **matched code-defined allowlist class** (§3) — outside the allowlist is a floor
  VETO regardless of the model's call.

### 3. Allowlist is CODE-DEFINED, never runtime-editable (blast-radius invariant)

The known-safe-class allowlist is a **constant compiled into the sentinel**, NOT
a config key, NOT agent/replication/PATCH-editable. It is part of the §4 safety
floor: the intelligence may only get a kill executed for a process INSIDE an
allowlist class — the model decides *whether* to kill within the envelope, the
code-defined list decides the envelope's *edges*. Config may only NARROW or
disable (kill-switch / dryRun), NEVER add a class. Growing the allowlist requires
a source change through `/instar-dev` review — expanding an operator-granted kill
scope is a reviewed change, not a runtime tuning knob. **v1 seed (single class):**
orphaned editor extension hosts / language servers — the four literal name regexes,
each ALSO requiring an extension-host/language-server argv token:
- `/^Code Helper \(Plugin\)$/` (VS Code)
- `/^Cursor Helper \(Plugin\)$/` (Cursor)
- `/^Windsurf Helper \(Plugin\)$/` (Windsurf)
- `/^Code - OSS Helper \(Plugin\)$/` (VSCodium)

**Argv-token match tolerates extension-path-dominated argv (round-8 — codex).** A
real language server's argv is often dominated by extension paths, Node entrypoints,
or opaque bundled commands, so the token match looks for an
`*extension*host*` / `*language*server*` / `--type=extensionHost` token ANYWHERE in
the full argv (including inside a path segment), not only as a leading arg — else a
real MongoDB-style server misses the class and silently becomes alert-only. **Build
requires captured, sanitized argv exemplars** from VS Code, Cursor, Windsurf,
VSCodium, and the 2026-07-03 MongoDB incident, committed as match fixtures; the
class match is DEFINED by the frontloaded name-regex + token rule and VALIDATED
(evidenced) by those captured exemplars — the exemplars are build-time realness
fixtures, NOT a runtime match input (round-10 — security; this keeps the §8 arm-scope
content-hash, which hashes the name regexes + argv tokens only, the sole match
authority, so the never-widen guarantee has no exemplar-shaped hole).
(Exemplar-synthesis fallback, round-9 — decision-
completeness: if an editor isn't installed on the build machine, its exemplar may be
SYNTHESIZED from the frontloaded name+token rule so the build never stalls on a
missing app — the match rule itself is fully frontloaded, so this is a fixture
obligation, not a definition gap.)

**Honest v1 class boundary (round-9 — codex).** The v1 class is specifically the
**Electron extension-host WRAPPER** process — how VS Code / Cursor / Windsurf /
VSCodium run their extension hosts (`… Helper (Plugin)`), which is the process that
holds the CPU when an extension's in-host work runs away. A **standalone** language
server that an extension spawns as its OWN child process (a bare `node` / `python` /
`java` whose editor parent appears only in argv ancestry) is a DIFFERENT class and is
explicitly a NAMED FOLLOW-UP, out of v1 — the v1 name-regex would not match it, and <!-- tracked: CMT-1901 -->
that is deliberate, not an accidental miss. **Build MUST verify the actual `comm`/
argv of the 2026-07-03 MongoDB anchor against the v1 regex:** if that incident's hog
was the shared exthost wrapper, v1 covers its own anchor; if it was a standalone node
LS child, v1 must either add the standalone-LS class or the anchor is honestly a
follow-up — this is a build-time grounding gate (a blocker for the coverage CLAIM, <!-- tracked: CMT-1901 -->
NOT a spec-convergence blocker — decision-completeness round-10 confirmed the
frontloaded scope default resolves it either way). **If the historical anchor process
is no longer capturable at build time** (it ran ~24h and is long gone): ship v1
as-scoped (the exthost-wrapper class), record anchor coverage as UNVERIFIED in the
ship notes, and file the standalone-LS class as a P10-tracked follow-up if it ever <!-- tracked: CMT-1901 -->
recurs — the build never stalls on an uncapturable historical process.

### 4. The safety floor (VETO-only — bounds the decision, never makes it)

Every invariant below can only BLOCK a kill the intelligence (§5) decided on and
downgrade it to an alert — none can trigger a kill. Together they are the envelope
inside which the model's decision is allowed to act.

**The floor — not the model — carries the hard safety properties (round-4
correction).** When the decision authority moved to the model (§2 correction),
two guarantees the old deterministic predicate held implicitly had to be promoted
INTO the floor so a single model misjudgment cannot break them:

- **`sustainedHighCpu` is a HARD VETO, not just a model input.** A kill is BLOCKED
  and downgraded to alert unless the target is a confirmed sustained CPU hog (the
  §1 CPU-delta, N windows ≥ `cpuCoreThreshold`) at kill-time re-evaluation. This
  restores the guarantee that an idle orphan or a momentary spike is NEVER killed
  regardless of the model's verdict — the feature stays scoped to CPU reclamation,
  by construction, not by the model's judgment.
- **Deterministic observability floor — the model CANNOT silence a real hog.** The
  floor is veto-only for KILLS, but visibility is not the model's to suppress. ANY
  candidate that deterministically meets the sustained-hog threshold and is NOT
  killed — whether because the model said `leave`, the model was unavailable, or a
  floor invariant vetoed the kill — is AT MINIMUM surfaced as a coalesced, deduped
  alert (§6). The model decides kill-vs-not-kill; it can never decide whether you
  find out a hog exists. Without this, an attacker-named hog could talk the model
  into `leave` and re-create the exact silent-invisible-hog failure this feature
  exists to fix (worse, because you'd believe it was watched).

- **Positive-allowlist model, not a daemon denylist.** Nothing is killed unless it
  affirmatively matches the narrow allowlist AND passes every §2 condition. A name
  denylist cannot enumerate every critical process — it misses USER-owned critical
  processes (cfprefsd, securityd, trustd, keychain agents, Dock, Finder) that are
  not root and spike CPU. The daemon/root denylist (fseventsd, WindowServer,
  kernel_task, launchd, cloudd, mds/mdworker, coreaudiod, any root-owned pid) is
  **defense-in-depth only**, never the primary gate.
- **Same-uid floor invariant (round-8 — hard property, not incidental EPERM).** A
  kill is BLOCKED and downgraded to alert unless `target-uid === process.geteuid()`
  (the sentinel's own non-root euid). This is the construction-time guarantee behind
  the sovereignty grant's scope — "we only ever kill within the granting operator's
  OWN processes" — and it must NOT rest on the kernel's EPERM by accident: without
  this invariant, another user's non-root orphaned exthost passes every other floor
  check and is stopped only at `kill(2)`, AND that other principal's argv would have
  already flowed into the classifier call + audit log. Enforced at discovery (§1
  own-uid scope) AND re-checked in the atomic kill-time set below.
- **Refuse to arm as root.** If `process.geteuid() === 0`, the kill lane does not
  arm (the non-root euid is the backstop that makes "never kill root" hold via
  EPERM). Re-check target ownership at kill time; a reused pid now owned by root, or
  now owned by a different uid, is skipped.
- **The kill sequence has TWO distinct re-check stages with DIFFERENT mechanics
  (round-9 — adversarial resolved a cadence contradiction).** The round-8 draft
  lumped the cross-scan CPU confirmation into a same-pass "before FIRST signal /
  before SIGKILL" structure — impossible, since the CPU confirmation spans two scans
  while a SIGTERM→SIGKILL pass is ~12s. Separated cleanly:
  - **Stage A — CPU micro-check is a PRE-SIGTERM ADMISSION GATE (cross-scan, worker-
    side).** BEFORE any signal is sent, `sustainedHighCpu` is freshly re-confirmed:
    a bounded two-point cumulative-cputime delta on the identity-verified pid over
    `killTimeCpuRecheckWindowMs` (default 2500), run IN THE SAMPLER WORKER, never
    inline (the #1069 lesson applies to the kill lane too). **Dip policy:** a
    "not-idle-now" test at a LOWER threshold (0.5 core) — 1 CPU-sec (~0.4 core) →
    below → DEFER; ≥2 CPU-sec (~0.8 core) → pass. A candidate that fails micro-check
    #1 is DEFERRED: it holds NO signal, is NOT entered into the in-flight-kill set, <!-- tracked: CMT-1901 -->
    and is re-checked on the NEXT scan (cache-suppressed meanwhile). TWO consecutive
    failed micro-checks → ABORT to alert (a sustained 90s hog is never spared by a
    single momentary dip; an idle orphan is never killed). Only after Stage A passes
    does the candidate enter the kill funnel.
  - **Stage B — the instantaneous re-check set, run twice per pass (genuinely
    atomic).** Immediately before the FIRST signal AND again immediately before
    SIGKILL, re-check ONLY the instantaneous facts: identity tuple (pid + start-time
    + command-hash), owner is non-root, `owner-uid === own euid`, NO launchctl label,
    `ownerAppRunning === false` (the specific `--parentPid` still dead), allowlist
    class, AND a live re-read of `dryRun`/`enabled` + the armed marker (§7/§8). Any
    mismatch → abort to alert. **The CPU delta is NEVER part of Stage B** — it is a
    cross-scan measurement and cannot be evaluated atomically; Stage A already
    admitted the candidate as a live hog.
  macOS recycles pids aggressively; a 30s+ window makes a wrong-target SIGKILL
  reachable, and a process can acquire a launchd label, go idle, or be disarmed
  between scan and kill — this two-stage set closes all of them.
- **Hardened kill funnel — async, never blocking the event loop** (do NOT reuse
  `killProcess()` verbatim): [candidate has passed Stage A] SIGTERM → **timer-based**
  wait `sigtermGraceMs` → Stage-B re-check → SIGKILL only if still the same process
  and still alive. All waits are timer-based and all sampling/identity re-reads are
  async with hard per-command timeouts (~1s for the instantaneous checks); no step
  blocks the server event loop. Grace widened for this lane (language servers may be
  mid-write).
  **The open-writable-fd skip is BEST-EFFORT courtesy, NOT a safety invariant
  (round-10 — codex; narrowed from the round-8 over-broad version).** Safety is
  carried entirely by the §4 floor; this skip is only a courtesy to avoid truncating
  a genuine in-progress document write, and it is explicitly best-effort — a precise
  path classifier is impossible (editors write temp files, rename-on-save files,
  SQLite state, indexes, generated project files), so the spec does NOT claim it
  reliably protects every document write. Concretely: before SIGKILL, an `lsof`-shaped
  probe (bounded ~1s timeout, worker-side) checks for open writable REGULAR FILES
  under the user's WORKSPACE/document paths, EXCLUDING logs, caches, sockets, pipes,
  and the extension's own storage dir (which language servers hold open essentially
  always — the round-8 blanket "any writable fd" version would have PERMANENTLY spared
  the target zombies). On a match it DEFERS the SIGKILL this pass (the process already
  has SIGTERM and may still exit on its own), with a hard `maxKillDeferrals` cap
  (default 3): after the cap it PROCEEDS to SIGKILL — the hog is the priority, never an
  unbounded defer. (The in-flight-kill set + `inFlightKillTtlMs`, §6, prevent a
  re-SIGTERM while a deferred SIGKILL waits.) **Probe-failure/ambiguity direction = DEFER <!-- tracked: CMT-1901 -->
  within the SAME capped budget (round-10 — reconciling lessons + codex):** if the
  `lsof`-shaped probe errors, times out, or can't classify a path, treat it like a
  match — DEFER the SIGKILL and COUNT it against `maxKillDeferrals` — so an uncertain
  read leans toward not truncating a possible write, yet stays bounded (after the cap
  it proceeds regardless). This satisfies both "don't SIGKILL blindly on a failed
  probe" and "never permanently spare a hog." The fd result is NEVER safety-load-
  bearing (a veto belongs to the floor); the probe is a bounded courtesy that can
  neither permanently spare a hog nor be gamed into shielding one.
  **Placement — the probe gates SIGKILL, NOT SIGTERM (round-11 — adversarial;
  consistent with §6 + the §Design lifecycle diagram, which both place the deferral in <!-- tracked: CMT-1901 -->
  the in-flight-kill stage).** SIGTERM is the graceful "please exit" a well-behaved
  language server catches to flush and exit cleanly — it is NOT the truncation risk;
  SIGKILL (uncatchable, no flush) is. So the courtesy runs in the post-SIGTERM grace
  window, immediately before SIGKILL, and defers only the SIGKILL — never a
  "send-nothing-this-pass" gate before SIGTERM. (This corrects an earlier draft that
  placed it before SIGTERM.)
- **Never interpolate attacker-controlled strings into a shell.** Only
  integer-validated pids reach any command; use array-arg `spawn`, never
  `/bin/sh -c`, and never a SYNCHRONOUS sampling call on the server event loop, for
  sampling and identity re-reads.
- **Audit captures WHY a model-driven kill happened (round-4 correction).** Because
  the model authorizes the irreversible action, the audit must let an operator
  reconstruct the decision, not just the floor pass. Each `logs/external-hog-kills.jsonl`
  record (and each would-kill soak record) carries: `pid + start-time + matched-class`,
  the **model verdict** (kill/leave/alert), the **model's stated reason**
  (scrubbed + length-clamped through the same argv-scrub chokepoint, since it can
  echo attacker-controlled process text), the **model id + framework** (from the
  `ExternalHogSentinel/ZombieClassifier` attribution), a **hash/snapshot of the
  fact envelope** fed to the model, and the **floor result** (passed / vetoed-with-
  which-invariant). Process names/argv can carry secrets or markup — all raw text
  is scrubbed/neutralized before it reaches the log, dashboard, or Telegram.
  **Audit write is gated on a verdict/state CHANGE, not per-scan-per-match (round-9 —
  scalability).** A persistent hog scanned every 60s over a multi-day dryRun soak
  would otherwise write ~1,440 near-duplicate would-kill lines/day (the anchor hog ran
  ~24h), making the soak's own load-bearing artifact noisy and unbounded. So a
  would-kill / kill record is appended only when the `(verdict, floor-result, class)`
  for a target signature CHANGES (or on first observation), coalesced per hog like the
  §6 notices. The durable `state/` kill-ledger and `logs/external-hog-kills.jsonl`
  both carry a stated retention/rotation bound (size- or age-capped) so neither grows
  without limit.

### 5. The intelligence — the DECIDER (inputs, envelope, unavailability)

The benchmarked classifier (`zombie-classify`) is the decision-maker: it returns
**kill / leave / alert** for each candidate, given the deterministic facts from §2.
It holds the kill DECISION authority; the §4 floor holds only VETO authority.

- **Output is a bounded enum, ONE call per candidate (hard invariant).** The
  classifier output is exactly `{kill|leave|alert}`. **Each candidate gets its OWN
  classifier call (round-8 — adversarial):** the verdict is bound to its subject by
  being the sole subject of the call, NOT by list-position in a batched response — a
  batched call returning fewer/reordered items could apply candidate A's `kill`
  verdict onto candidate B (the §4 floor keeps that SAFE, but it silently defeats the
  model's per-candidate nuance, killing a process the model judged worth sparing).
  The call carries NO pid, target, or identity — the §4 floor recomputes every
  invariant on that exact code-surfaced candidate. Parsing a pid/target out of model
  output is PROHIBITED; the entire blast-radius bound depends on the model never
  naming or influencing WHICH process is acted upon.

- **Untrusted-data envelope at runtime (not just in the benchmark).** Every
  process-fact field (name, argv) is attacker-controllable; each is wrapped in the
  boundary-marked "do not follow instructions" envelope, length-clamped, and
  scrubbed before the call. Injection is contained NOT because the model lacks
  authority (it decides), but because the §4 floor bounds what any decision — honest
  or injected — can reach: a kill only ever lands inside the allowlist envelope, on
  a non-system/non-root, owner-dead, identity-verified process. So the worst
  injection does is spare a real hog (safe) or kill an in-envelope zombie (intended).
- **Decider-unavailable policy (settled, fail-safe direction).** Because the model
  is now the DECIDER, if it is unavailable (provider down / spawn-cap saturated /
  timeout) there is no kill decision → **no kill** → the candidate is surfaced as an
  alert instead. An irreversible action never proceeds without the intelligence that
  authorizes it. (During the dryRun soak in §7 nothing is killed regardless.)
- **Classifier is gated behind the deterministic `sustainedHighCpu` pass + a
  per-scan cap, worst-hogs-first (round-6 cap; round-8 rationale + ordering fix).**
  A process the floor will VETO anyway (not a confirmed sustained hog) is NEVER worth
  a model call, so the classifier only ever sees deterministically-confirmed
  sustained hogs. A hard `maxClassificationsPerScan` cap (default 4) bounds spend.
  **Honest binding scenario (round-8 — scalability corrected the round-6
  rationale):** the cap does NOT bind on an aggregate fork storm — 230+ processes
  sharing 8–12 cores yield ~0.03–0.05 core-equivalents each, so NONE crosses
  `cpuCoreThreshold` (1.5) and a small-process storm produces ZERO confirmed hogs and
  ZERO classifier calls. The cap's real binding scenario is **multiple distinct
  multi-core hogs coexisting** (physical ceiling ≈ cores ÷ threshold ≈ 5–8 on typical
  hardware — the default 4 is right for that). **Slot-selection order = DESCENDING
  sustained CPU, with a deterministic tie-break (round-8; round-9 added the
  tie-break):** when the confirmed-hog set exceeds the cap, the `cpuCoreThreshold`-
  topmost `cap` hogs get the classification slots (worst first); the remainder degrade
  to deterministic coalesced **alert-only** (no kill, no spend — the §4 observability
  floor still surfaces them). Without a defined order, a flood of ≥4 low-severity
  in-envelope decoys could consume every slot and starve the single genuinely-damaging
  hog into alert-only, defeating the auto-kill in exactly the multi-hog case the
  feature exists for. **Ties (equal sustained CPU — an attacker can pin several decoys
  at the same core count) break on a NON-attacker-controllable secondary key:
  earliest detection time, then longest sustained-window count** — a stable sort so a
  real long-running hog is never evicted from a slot by same-CPU decoys. Unit fixture:
  given N > cap confirmed hogs, the topmost `cap` by (sustained CPU, then earliest
  detection) are the ones classified; the tie-break degrades SAFE (an evicted hog is
  still surfaced by the observability floor, and same-CPU decoys are themselves
  killed).
- **Aggregate small-process storms are OUT OF SCOPE here (round-8 — honest scope
  note).** Per the arithmetic above, a many-small-process storm is invisible to the
  per-pid threshold. An instar-ORIGIN storm is owned by the fork-bomb spawn-cap floor
  (a separate host-wide guard); an EXTERNAL aggregate storm is a named follow-up (a <!-- tracked: CMT-1901 -->
  cheap `total-external-Δcputime > X cores` observability-only trigger), not v1.
- Routed through the rate-limited LlmQueue **BACKGROUND/low-priority lane** with
  feature-metrics attribution (`ExternalHogSentinel/ZombieClassifier`). The
  deliberate relationship `maxClassificationsPerScan (4) < hostSpawnCap (8)` means a
  full classification burst can never occupy more than half the host's spawn slots,
  so the sentinel cannot crowd out the tone gate on the priority-less host semaphore
  during the load events it hunts (the 2026-07-01 codex-flood-blocks-Telegram
  lesson). Cached per **full identity tuple** `(pid, start-time, command-hash)` — NOT
  `(pid, command-signature)` — with a TTL (`classifierCacheTtlMs`, default 300000)
  AND a max-entries LRU cap (`classifierCacheMaxEntries`, default 256), so a
  persistent benign hog is NOT re-classified every scan while a pid reused by a new
  incarnation cannot inherit the prior incarnation's cached `kill` verdict. The cache
  is ADVISORY: the §4 kill-time re-check (start-time-inclusive) is the authoritative
  gate and a cache hit can never bypass it. Once the §6 P19 breaker trips a
  signature, short-circuit the classifier for it. The `zombie-classify` benchmark
  measures which model best makes THIS decision.

### 6. Loop brakes (P19) and notification bounding (P17)

- **P19 — no unbounded kill loop.** A durable kill ledger (stored under `state/`,
  NOT `logs/`) keyed on a **respawn-surviving signature**. Two forces are in tension
  and the round-8 adversarial review showed the round-6 key was defective:
  - The key MUST strip volatile tokens (pid, `--parentPid=N`, ports, uuids) or a
    legitimately app-respawning process gets a fresh key each spawn and the breaker
    never trips (#863 returns).
  - But for the v1 exthost class, stripping those tokens makes two DISTINCT orphaned
    exthosts (e.g. from two different VS Code windows) normalize to nearly-identical
    argv — their keys COLLIDE. An attacker who spawn-kill-respawns ONE decoy exthost
    K times would then trip the breaker for the WHOLE class and shield a different
    real hog of that class.
  **Fix (both, round-8; round-9 hardened the fallback):** (a) the ledger key includes
  a stable, respawn-surviving DISCRIMINATOR that differs between two logical
  exthosts — the `--user-data-dir` / workspace-root token if present in argv — so
  genuine respawns of the SAME logical process collapse to one key while two distinct
  exthosts stay independent; and (b) the guarantee is stated HONESTLY: the breaker
  shields same-key hogs from further KILL only — NEVER from the §4 observability
  floor, which keeps surfacing them. **When only a VOLATILE fallback is available
  (round-9 — adversarial):** the round-8 fallback ("first-observed original-parent
  identity") derives, on the effective v1 path (b), from `--parentPid=N` — a token
  the key STRIPS as volatile, so a per-volatile-key breaker would never trip and the
  #863 loop returns. So the anti-loop guarantee does NOT rest on the per-key breaker
  when the discriminator is volatile: it falls back to (i) a CLASS-level breaker (K
  kills within the window across the whole allowlist class → stop + surface) and (ii)
  the per-target backoff — both of which trip without a stable key. The stable
  `--user-data-dir` discriminator is used when present; the volatile case is carried
  by class-breaker + backoff, stated explicitly rather than silently relying on a
  breaker that can't fire. After K kills of the same key (or class, in the volatile
  case) within a rolling window (default 3 / 1h) the sentinel STOPS killing, marks it
  "respawning — likely launchd/app-managed", and raises ONE degradation that NAMES
  that same-signature hogs remain **surfaced-but-unkilled** (so the operator is not
  misled that class-wide shielding is impossible). **The message is scope-accurate
  (round-10 — adversarial):** a PER-KEY breaker trip says "I've stopped killing this
  specific process signature but I'm still reporting it"; a CLASS-LEVEL breaker trip
  (the volatile-discriminator fallback) says "I've stopped auto-killing this whole
  editor-exthost class — same-class hogs remain surfaced-but-unkilled — because one
  keeps respawning; your call", so the operator understands the actual shielded scope
  (which under the class breaker may include OTHER real hogs of that class they wanted
  killed, not just the respawning one). Plus an in-flight-kill set (pid+start-time), size capped,
  whose eviction is tied to CONFIRMED exit (or `inFlightKillTtlMs`, default
  `3 × sigtermGraceMs` — a ceiling comfortably longer than the grace, NOT
  `2 × sigtermGraceMs` which could re-enter the funnel and SIGKILL a mid-write
  language server early; the narrow open-writable-fd skip in §4 is the primary guard).
  Backoff on repeated same-target action. This is the #863 reaper-kill-loop shape
  (17,503 identical requests) — brakes are mandatory.
- **Note — argv self-rewrite is inherent and fails SAFE (round-8, not a defect).**
  An attacker's own process can rewrite its argv between detect and kill so the
  kill-time command-hash re-check aborts, making its hog effectively un-killable.
  This only spares the attacker's OWN hog (safe direction) and the §4 observability
  floor still surfaces it — an accepted consequence of the identity-tuple safety
  guard, recorded so it isn't later mistaken for a flaw.
- **P17 — no notification flood, across ALL notice classes.** NOT one notice per
  event. A single coalescing chokepoint covers every notice class — kills,
  decider-unavailable alerts, floor-veto downgrades, AND the deterministic
  "sustained hog left alive" observability alerts (§4) — with per-signature dedup +
  a per-window budget (`noticeBudgetPerWindow`, default 4, over the P17 coalescing
  window `noticeWindowMs`, default 600000), so a persistent condition (a hog the
  model keeps sparing, or a provider outage possibly caused by the hog itself) raises
  ONE degradation, not one-per-scan. Emit at most ONE coalesced summary per scan
  cycle ("auto-killed N zombies: <list>, freed ~M cores; left M hogs alive:
  <list>"). **Budget-exhaustion ordering (round-8 — codex):** when the budget is
  exhausted in a window, notices are prioritized by severity —
  `kill > decider-unavailable > floor-veto-downgrade > hog-left-alive` — and the
  coalesced summary reports the DROPPED count for lower classes; a LIVE kill notice
  always pierces the budget (never dropped). Routed through the DETERMINISTIC
  delivery path to a fixed system/lifeline topic (never the tone gate — it can fail
  closed under the very load this reports — never the active conversation topic),
  carrying the machine nickname.
- **Alert delivery is durable — the observability guarantee cannot die on an unset
  channel (round-8 — lessons-aware, P18).** The §4 promise that "a real hog can never
  be silently invisible" is only as strong as delivery, and the deterministic
  system-topic path has a documented silent-death mode (topic unset/unresolvable on a
  fresh or non-Telegram install → silent drop — the exact class the 2026-06-26 F3
  work closed). So: (a) every alert emission writes a durable audit artifact FIRST (a
  `notify`-outcome row in the sentinel log, reap-notify-style) BEFORE the send is
  attempted; (b) delivery rides the durable relay layer (PendingRelayStore-backed
  queue with retry), not a fire-and-forget send; (c) an undeliverable/unroutable
  alert is itself a LOUD event — but surfaced ONLY via the IDEMPOTENT
  `GET /external-hog` status field + the guard-posture row, **NOT a per-scan attention
  record (round-9 — lessons-aware, P17).** The round-8 durability fold introduced this
  undeliverable-alert as a new notice surface; on a channel-set-but-unroutable install
  with a persistent hog, a per-scan attention record would flood (each scan → alert →
  retry → exhaustion → record) — the exact P17 failure this spec elsewhere prevents.
  The status field + guard-posture row are idempotent (one steady state, not one-per-
  scan), so undeliverability is loud-but-bounded; it does NOT also go through the
  per-scan attention path. (d) on an install with NO messaging channel the floor
  degrades HONESTLY to log + status route, and the status payload says so. A
  mis-deciding model cannot silence a hog (§4); neither can an unconfigured topic.

### 7. Rollout — dev-agent-gated, dark-on-fleet, dryRun-soak-FIRST

**Sovereignty engagement (round-8 — the Standards-Conformance flag, named
explicitly).** The Sovereignty standard ("is this mine? if yes act; if it's the
human's, ask") applies directly: the target processes — orphaned editor extension
hosts — are the OPERATOR's, not the agent's, so the standard resolves to ASK. That
asking is satisfied STRUCTURALLY, twice, and no live kill can ever precede it:
1. the **originating grant** — the named operator directive (Justin, 2026-07-03,
   "auto-kill from the start" for the incident machine); and
2. the **standing grant mechanism** — the PIN-gated `POST /external-hog/arm` (§8),
   which EVERY install (dev included) must exercise before the first live kill.
The grant's SCOPE is the granting operator's own processes (the same-uid floor
invariant, §4) and exactly the compiled allowlist envelope as it existed at arm time
(the arm-scope snapshot, §8) — nothing outside that is ever killable regardless of
config. Per-kill approval would reintroduce the operator-in-the-loop latency this
feature exists to remove, for a target class that is by construction owner-dead
dead-weight with no live human workflow depending on it. This is the same
standing-bounded-revocable-consent pattern the codebase already accepts for
irreversible-action guards (green-PR automerge enable, credential re-pointing).

Reconciling that directive with the graduated-rollout standard and the round-1
consensus (three reviewers independently counsel a soak because the discovery path
is NEW, the CPU signal is measurement-fragile, and `ownerAppRunning` has never run
against real host processes):

- **Rides the `developmentAgent` gate** (omit `enabled` so it resolves
  live-on-dev, dark-on-fleet) — the **`credentialRepointing`-style precedent**
  (omit `enabled` + a `dryRun:true` canary), NOT green-PR automerge (round-10 —
  integration corrected the citation: green-PR automerge is a `DARK_GATE_EXCLUSION`,
  `action-bearing`, shipping `enabled:false` fleet-wide with an explicit per-dev-agent
  flip + `expectedGhLogin` — a different pattern; green-PR is the right analogy only
  for the §8 arm/disarm two-halves-of-a-kill-switch, not for the dark-gate posture).
  **Load-bearing registration obligation (round-10 — integration):** the structural
  proof that "omit `enabled`" genuinely resolves live-on-dev / dark-fleet is
  registration in `DEV_GATED_FEATURES` (`src/core/devGatedFeatures.ts`), which drives
  the both-sides wiring test (the #1001-class guarantee). This spec MUST register
  `monitoring.externalHogSentinel.enabled` there WITH a `credentialRepointing`-style
  justification — because the three sibling process-killers
  (`sessionReaper` / `agentWorktreeReaper` / `mcpProcessReaper`) are DELIBERATELY
  EXCLUDED from `DEV_GATED_FEATURES` as destructive, so a 4th process-killer is
  admissible ONLY on the explicit ground that the `enabled` gate makes scan / classify
  / LOG live while the KILL itself stays doubly-held by `dryRun:true` AND the PIN
  armed-marker (§7). See §Testing for the wiring-test entry. "Kill from day one" is
  scoped to the DEVELOPMENT agent (Justin's machine, the incident machine). A non-dev
  fleet agent requires an explicit per-operator opt-in — never a silent fleet-wide
  auto-kill on update.
- **Ships ARMED in dryRun soak (default `dryRun: true`).** From day one it scans,
  classifies, and LOGS the full would-kill record (facts + model verdict + reason +
  floor result, per §4) for each match — blocking/killing nothing — so "auto-kill
  from the start" is honored operationally (it is on and watching from boot).
  **The FLOOR (§4), not the soak, carries the hard guarantee** — the model decision
  is non-deterministic, so a clean soak does NOT bound future model behavior the way
  it would a fixed predicate. The soak's job is therefore to prove the FLOOR bounds
  even a mis-deciding model to **zero wrong kills**, and to measure the model's
  false-alert / false-kill rate. Go-live criterion: "floor-bounded to zero wrong
  kills across the soak window" (not "the model was clean"). The narrow allowlist +
  the sustainedHighCpu veto + the atomic re-check are what make that hold. (Settled
  Frontloaded Decision — Justin can flip to live via the PIN-gated arm route once
  satisfied.) **Soak spare-rate metric (round-8 — gemini; round-10 reconciled the
  data source + added a threshold).** The metric counts events where the
  deterministic floor WOULD have passed but the model said `leave`/`alert` — the
  "model spared an in-envelope process" event. **Data source, reconciled with §4's
  change-gated audit (round-10 — adversarial):** §4's would-kill/spare AUDIT log is
  change-gated (a record only on a `(verdict, floor-result, class)` CHANGE, to avoid
  ~1,440 near-dup lines/day), so a per-SCAN spare-rate cannot be read from it. The
  spare-rate is therefore defined as **per-DISTINCT-in-envelope-hog** — the
  denominator is distinct confirmed in-envelope hogs over the soak, the numerator is
  those the model spared — computed from the change-gated first-observation records
  (NOT a per-scan line); a separate lightweight in-memory per-scan counter MAY back a
  finer real-time gauge but is never the durable audit. This makes "records every
  event" precise: every distinct spare DECISION, not every scan. **Go-live spare-rate
  THRESHOLD (round-10 — gemini):** go-live is contingent NOT ONLY on "floor-bounded to
  zero wrong kills" but ALSO on the soak showing a spare-rate ABOVE a stated floor —
  if the model's decisions essentially MIRROR the deterministic floor (spare-rate ≈ 0
  over a meaningful sample of distinct in-envelope hogs), the added non-determinism +
  cost are NOT justified and the honest outcome is to ship deterministic-kill-only and
  demote the model to alert-explanation. The threshold makes the LLM's value-add
  falsifiable, not asserted. It feeds the `zombie-classify` benchmark.
- **Arming is DIRECTION-ASYMMETRIC — a config write can only ever DISARM (round-8 —
  the security-critical fix).** The round-7 text let any config write flip the
  feature live, making the PIN gate decorative. Corrected: the kill chokepoint reads
  `enabled`/`dryRun` live every poll, but a live config read can only move toward
  SAFE — a `dryRun:true` / `enabled:false` value takes effect immediately (this
  preserves emergency disarm-by-edit and the §8 disarm route). Transitioning TO
  live-kill requires the PIN-gated arm route (§8), which persists a **server-side
  armed marker** (0600, agent-home, DISTINCT from config).
  **Marker lifecycle — an ARM-EPOCH, so a disarm can never be silently un-done
  (round-9 — the security-critical refinement).** The round-8 marker had no
  invalidation-on-disarm, so a `disarm → config dryRun:false → server restart`
  sequence would re-derive "armed" from the persisted marker + config and boot
  live-killing WITHOUT a fresh PIN — reopening the exact bypass round-8 set out to
  close. Fixed with a monotonic epoch pair:
  - the PIN arm route writes the marker with a monotonically increasing `armEpoch`;
  - ANY disarm — the §8 route OR an emergency config-edit to `dryRun:true` /
    `enabled:false` — persists a `lastDisarmEpoch` ≥ the current `armEpoch` (and the
    chokepoint, on observing a safe-direction config transition, proactively bumps
    it);
  - the marker is VALID only while `armEpoch > lastDisarmEpoch`. The chokepoint kills
    only when `enabled && !dryRun && marker-valid`. (`armEpoch` and `lastDisarmEpoch`
    are read/written as ONE atomic marker file so a concurrent arm+disarm cannot lose
    the disarm — round-10 note.)
  Consequences that close the bypass: `config.dryRun:false` is NEVER a positive arm
  signal — it is a DISARM signal's ABSENCE, nothing more; ignored as a permit on a
  live read, and on BOOT the chokepoint treats the feature as UNARMED unless a
  currently-valid marker (`armEpoch > lastDisarmEpoch`) exists. Returning to live-kill
  therefore ALWAYS requires a fresh PIN arm. A bare `dryRun:false` from a file edit, a
  generic `PATCH /config`, or an injected agent can never arm. The arm DIRECTION of
  this config block is additionally excluded from generic `PATCH /config`.
- **During the soak, the §4 observability alert fires for real** (a read-only
  coalesced heads-up — it is not a kill), so the operator learns which real hogs
  exist while would-KILL records stay in the log. The observability guarantee is
  live from day one; only the destructive action waits on the PIN-gated arm (§8).

### 8. Integration obligations

- **Migration Parity.** Register `monitoring.externalHogSentinel` in
  `migrateConfig()` (existence-checked, add-missing-only, idempotent) with the
  migrated default (`enabled` omitted → dev-gate; `dryRun: true`). Without this the
  feature — including its kill-switch — is invisible to every deployed agent.
- **Guard-Posture derived from EFFECTIVE kill-capability, not config alone (round-9 —
  integration).** The posture row must reflect verified reality, not a config wish:
  emit `on-confirmed` ONLY when `enabled && !dryRun && marker-valid`
  (`armEpoch > lastDisarmEpoch`); otherwise `on-dry-run`. (A genuinely distinct
  `armed-pending` state — `!dryRun` but no valid marker — is NOT in the current
  `GuardEffectiveState` enum, so v1 MAPS that case to `on-dry-run`; adding a distinct
  `armed-pending` is a cross-cutting enum change — summary counts, dashboard,
  pool-merge — deliberately DEFERRED, not implied free (round-10 — integration).) Keyed on config alone, the reachable <!-- tracked: CMT-1901 -->
  `config.dryRun:false` + marker-absent state would falsely read `on-confirmed` while
  the feature is not actually killing — the exact "config-wish, not verified reality"
  dishonesty `/guards` forbids, on a load-bearing safety surface. The guard wiring
  READS the armed marker, not just config. Wire into the Guard-Posture Tripwire
  (enabled→disabled flip raises the attention item) and `GET /guards?scope=pool` (the
  correct multi-machine surface for a host-local guard), and to the sampler-liveness
  `on-stale`/`errored` degradation (§1).
- **Arm / disarm are phone-complete routes, NOT a config edit (round-6 —
  Mobile-Complete Operator Actions; round-8 hardening).** Going live is a
  higher-stakes operator action than any sibling guard. Mirror green-PR-automerge:
  - `POST /external-hog/arm` — flip to live killing. **dashboard-PIN-required** (arming
    an irreversible kill scope is structurally above a Bearer token). It persists the
    **server-side armed marker** (§7) with a fresh monotonic `armEpoch`, and records
    (i) `armedBy`/`armedAt` and (ii) an **allowlist snapshot as a SET of per-class
    CONTENT hashes** — `{classId: sha256(the class's name regexes + required argv
    tokens)}` — NOT a single aggregate hash (round-9 — security). A single value
    cannot deliver both required guarantees at once: an aggregate hash is
    all-or-nothing (any unrelated class addition would disable ALL killing until
    re-arm — an availability regression), while a bare class-id key would let an
    `/instar-dev` update that BROADENS an existing class's match rules kill the wider
    envelope with the same id and NO re-arm (silent widening). The per-class content
    hash gives both: a class kills only if its CURRENT `{id, contentHash}` is in the
    armed set — a NEW class is absent → alert-only; a BROADENED existing class → hash
    mismatch → alert-only until a fresh PIN-gated re-arm; an unrelated class addition
    leaves existing entries intact. ONE coalesced attention item announces any pending
    (absent or changed) class. (An armed grant never silently widens — the PIN
    consented to exactly the class CONTENT that existed at arm time.)
  - `POST /external-hog/disarm` — emergency back to the safe direction, lower
    friction (Bearer acceptable toward safe). **Disarm writes `dryRun: true`** by
    default (kills off; scanning + the §4 observability alerts CONTINUE — the safe
    direction) AND bumps `lastDisarmEpoch` so the armed marker is invalidated (§7) —
    a disarm is never merely a config flip that a later restart or strip could undo.
    Full-off (`enabled: false`) is an explicit separate parameter and ALSO invalidates
    the marker. The kill funnel MUST re-read `dryRun`/`enabled` + the armed marker
    IMMEDIATELY before the SIGKILL escalation step and ABORT the escalation on disarm
    — a pid already SIGTERM'd inside its `sigtermGraceMs` window is not SIGKILLed after
    a disarm (the green-PR "two halves of one kill switch" lesson: the per-poll read
    alone doesn't stop already-in-flight work).
  Both mutate server-side via read-modify-write of the FULL block — NEVER a
  client-supplied partial `PATCH /config`. **Strip-migration safety (round-9 —
  integration corrected the round-8 misdescription).** There is NO generic dynamic
  strip in the codebase — every strip is a SEPARATE, HARDCODED per-feature allowlist
  (`migrateDevGateTeethStrip` and siblings; the code comment: "Allowlist is HARDCODED,
  never 'the dev-gated ones' dynamically"), each existing only to remove a STALE
  `ConfigDefaults` literal that predates a re-gating. So the obligation is threefold,
  not "exclude from a generic strip": (a) `ConfigDefaults` OMITS `enabled` for
  `externalHogSentinel` from day one (the dev-gate resolves with no literal, so no
  stale `enabled:false` is ever persisted and no strip is ever needed); (b) a
  documented NEGATIVE invariant + a guard-test (§Testing) that `externalHogSentinel`
  is NEVER added to any per-feature strip allowlist — for THIS key `enabled:false` is
  a load-bearing operator disarm, not a stale default; (c) more robust than leaning on
  (b): because a full-off disarm ALSO invalidates the armed marker (above), even if
  `enabled:false` were ever stripped, no valid marker → no kill — the safety does not
  rest on the strip-exclusion alone. Every arm/disarm transition (who, when, from
  where, old→new, epoch) is APPENDED to the audit trail (`logs/external-hog-kills.jsonl`
  or a sibling audit line). Surface both on the dashboard Guards/Machines tab.
- **No manual kill/trigger route in v1 (round-8 — decision-completeness).** There is
  no operator-invocable "run a scan / kill this pid now" route in v1; the only kill
  path is the internal deterministic lane. (A future manual trigger, if ever added,
  would only run the classifier over predicate-confirmed targets — never accept a
  caller-supplied pid.)
- **Sampler process lifecycle (round-8 — security).** A detached sampler child that
  outlives a crashed server is itself the leaked-process shape this feature hunts, so:
  the sampler pid is recorded (agent-home, 0600), killed on server stop, and on
  restart the recorded pid is adopted-or-replaced (verified by identity), never
  duplicated. **The recorded sampler pid is added to the §1 discovery exclusion set
  explicitly (round-10 — security clarity)** — it is triply-unkillable anyway
  (CPU-trivial so never a hog, fails the exthost allowlist class, own-root ancestry),
  but naming it in the exclusion set closes the doc gap.
- **Reaper de-confliction (kill AND observability lanes).** McpProcessReaper also
  reaps orphaned launchd-reparented helpers (Playwright Chromium, Electron bridges).
  Explicitly EXCLUDE pids owned/known by McpProcessReaper and SessionManager from
  BOTH the kill lane AND (per §1's ancestor-walk) candidate discovery / the
  observability lane. **Suppression seam, named (round-8 — integration):**
  OrphanProcessReaper's external-report state is private (`reportedExternalPids`,
  24h cooldown) with no suppression API, and the overlap only exists for a process
  matching both a framework needle and the exthost allowlist. So the sentinel EXPOSES
  its in-lane identity-tuple set, and OrphanProcessReaper CONSULTS that set before
  external-alerting a pid — a concrete seam, not an assumed one — to avoid
  double-notify.
- **Agent Awareness.** Update `generateClaudeMd()` (+ the template migrate path)
  with the capability, the `GET /external-hog` status/audit route, and the
  proactive triggers ("why did a process on my machine get killed?", "what zombies
  got reaped?").
- **Endpoints.** All new routes require Bearer auth on the authenticated port
  (4042). NO endpoint accepts a caller-supplied pid to kill; the only kill path is
  the internal deterministic lane. A manual trigger, if any, only runs the
  classifier and acts on predicate-confirmed targets.

## Multi-machine posture

machine-local-justification: hardware-bound-resource

The sentinel, its audit log (`logs/external-hog-kills.jsonl`), and its status
route are **machine-local BY DESIGN**: a host OS process physically exists on and
can only be actioned from the one machine it runs on — it cannot be reaped from,
or replicated to, another machine. Cross-machine visibility is via each machine's
own `GET /external-hog` and the pool-scope `GET /guards?scope=pool` posture read,
not a merged log. No mesh coordination or pool-scope authority applies. (The
`hardware-bound-resource` key covers the DATA plane — the managed object is a host
OS process bound to one machine's kernel/CPU.)

**Operator-action plane — cross-machine arm (round-8 — integration).** The arm/
disarm routes (§8) are PIN-gated, and a dashboard PIN does not cross the mesh (the
WS5.2 follow-me cancel had to drop to a Bearer-only relay for exactly this reason —
which is NOT acceptable for arming an irreversible KILL scope). So the v1 posture is
**per-machine arm by design**: arming a machine's sentinel requires that machine's
own PIN surface (the operator reaches a peer machine's dashboard via that machine's
own tunnel/dashboard URL + PIN). For v1 this is moot — the dev-gate scopes live
arming to the single dev machine. The named FLEET follow-up (so this does not <!-- tracked: CMT-1901 -->
silently collide with the "one dashboard, not per-machine" standard) is the WS4.4
mechanism: PIN validated at the fronting dashboard edge → a short-lived,
audience-bound (target machine + the exact arm action), single-use, mesh-signed
operator ASSERTION relayed to the target machine, which re-validates before writing
its armed marker. Until that ships, cross-machine arm is honestly per-machine-
dashboard-only, stated here rather than left implicit.

## Frontloaded Decisions

- **Kill-from-day-one:** ships ARMED in dryRun soak (`dryRun: true`) on the dev
  agent; go live via the PIN-gated `POST /external-hog/arm` route (§7/§8), not a bare
  config flip, after a zero-false-positive would-kill soak. Dark on fleet
  (per-operator opt-in). Settled — the "DECISION FOR JUSTIN" block is removed.
- **Allowlist:** CODE-DEFINED constant, v1 = editor extension-host / language-server
  class only; config can only narrow/disable.
- **LLM role:** the intelligence is the DECIDER (kill/leave/alert), within the §4
  mechanical safety floor which holds veto-only authority. Decider-unavailable →
  no kill → alert (fail-safe). Corrected from the initial veto-only draft per the
  operator's explicit directive (Justin, 2026-07-03): the principle he named is
  "intelligence makes the judgment call; rigid code doesn't" — so the model decides
  and the mechanical layer only bounds the blast radius. Operator-ratified and
  settled; the recurring external-reviewer preference for a deterministic-only reaper
  is recorded but does not override the operator's call (and the model's value-add is
  measured by the §7 soak spare-rate).
- **Triage model:** the fast off-Claude default per the provider-fallback policy,
  component `ExternalHogSentinel/ZombieClassifier`; overridable via
  `sessions.componentFrameworks` once the `zombie-classify` benchmark names a winner.
- **Full config schema** (`monitoring.externalHogSentinel`): `enabled` (omitted →
  dev-gate), `dryRun` (default true), `scanIntervalMs` (default 60000, read-only
  scan), `cpuCoreThreshold` (default 1.5 core-equivalents — anchored above the
  observed ~2.2 and clear of legitimate single-core disowned jobs),
  `sustainedSampleCount` (default 3), `sampleWindowMs` (default 30000),
  `singleFlightBudgetMs` (default 20000 — the POLL's budget, sized to the cheap
  stage-1 scan; NO coupling to `sustainedSampleCount × sampleWindowMs` — the round-6
  startup guard was a vestige of the abandoned per-tick-blocking design and is
  removed, per §1), `killTimeCpuRecheckWindowMs` (default 2500),
  `sigtermGraceMs` (default 12000), `inFlightKillTtlMs` (default `3 × sigtermGraceMs`
  ≈ 36000, the in-flight-kill-set eviction ceiling), `maxKillDeferrals` (default 3,
  the §4 narrow-fd-skip defer cap before proceeding to SIGTERM),
  `killLedgerMaxPerSignaturePerHour` (default 3), `maxClassificationsPerScan`
  (default 4), `classifierCacheTtlMs` (default 300000), `classifierCacheMaxEntries`
  (default 256), `inFlightKillSetMax` (default 64), `noticeBudgetPerWindow` (default
  4), `noticeWindowMs` (default 600000, the P17 coalescing window). The durable kill
  ledger + audit log live under `state/` and `logs/` respectively, each with a stated
  retention/rotation bound (§4).
  **The numeric kill-gate knobs (`cpuCoreThreshold`, `sustainedSampleCount`,
  `sampleWindowMs`) are read-time CLAMPED to code-defined minimums (round-8 —
  integration correction).** They are file-editable like any agent-config key
  (SourceTreeGuard covers the instar SOURCE tree, not agent config — there is no
  "non-agent/non-replication-editable" protection to claim here); the real guarantee
  is the read-time clamp plus the owner-dead allowlist envelope: lowering a knob can
  only ever act inside that envelope, never widen the target set. Allowlist is NOT a
  config key (code-defined); v1 name regexes enumerated in §3 (`Code Helper
  (Plugin)`, `Cursor Helper (Plugin)`, `Windsurf Helper (Plugin)`, `Code - OSS Helper
  (Plugin)`) each REQUIRING the `*extension*host*`/`*language*server*` argv token, and
  a class is admissible only if it carries a verifiable dead-specific-parent signal
  (e.g. `--parentPid`) — provenance path (a), observed-transition, does not survive a
  server restart that post-dates the orphaning, so path (b) is the effective
  provenance for v1.

## Testing (all three tiers + mandated invariants)

- **Unit:** the deterministic predicate over every case class (all 8
  `zombie-classify` cases as code fixtures — `canon-orphaned-exthost-kill`,
  `canon-fseventsd-leave`, `canon-live-build-alert`, `canon-instar-own-leave`,
  `adv-zombie-name-but-live-parent`, `adv-root-daemon-claims-safe`,
  `adv-missing-field-uncertain`, `adv-momentary-spike-not-sustained`), PLUS the floor
  invariants: a high-lifetime-average-but-idle process must NOT satisfy
  `sustainedHighCpu` (CPU-delta correctness); a bare `ppid===1` launchd job must NOT
  qualify (provenance); a PID-reuse fixture (identity tuple changed between detect and
  kill → abort); **model says `kill` on an idle/momentary-spike orphan → floor
  VETOES** (sustainedHighCpu not met → no kill, alert); **model says `leave` on a
  deterministic sustained hog → the observability floor STILL emits an alert** (the
  model cannot silence a real hog); model output carrying a pid/target string →
  rejected (enum-only invariant); cached `kill` verdict on a reused pid with a new
  start-time → atomic re-check aborts. **Round-8 additions:** a process owned by a
  DIFFERENT uid meeting all other invariants → never a candidate, never alerted,
  never killed (same-uid floor); a high-CPU CHILD of a live tracked instar session →
  neither classified nor alerted (ancestor-walk exclusion), while an orphaned exthost
  with no instar ancestor IS a candidate; given N > `maxClassificationsPerScan`
  confirmed hogs, the topmost `cap` by sustained CPU are the ones classified
  (slot-order); TWO distinct orphaned exthosts (different `--user-data-dir`) get
  DISTINCT ledger keys and do not shield each other, while a genuine respawn of the
  SAME logical exthost collapses to ONE key and trips the breaker (P19 discriminator);
  a `leave` verdict batched-misaligned onto another candidate is impossible because
  each candidate is a separate call (one-call-per-candidate). **Round-9 additions:** a
  candidate that fails kill-time CPU micro-check #1 is DEFERRED (holds no signal, not <!-- tracked: CMT-1901 -->
  in the in-flight set) and only aborts-to-alert after TWO consecutive failures
  (admission-gate cadence); the narrow fd-skip DEFERS on a writable regular file under
  a workspace path but PROCEEDS after `maxKillDeferrals`, and does NOT defer on an
  open log/socket/cache (regression guard); a `Δwall` clock discontinuity (simulated
  sleep / NTP step) yields UNKNOWN → alert-never-kill (monotonic-clock guard); slot
  tie-break — N>cap hogs at EQUAL sustained CPU rank by earliest-detection, real hog
  not evicted by same-CPU decoys; volatile-discriminator respawn (no `--user-data-dir`)
  trips the CLASS-level breaker / backoff, not a per-volatile-key breaker.
- **Scrape/Parser realness (round-9 — lessons-aware F1, BLOCKING; L5; round-10
  extended scope):** the `ps`-table parser + `parseProcTimeToSeconds` are REGISTERED
  in the curated parser registry (`SCRAPE_PARSERS`) with a captured realness fixture
  at `tests/fixtures/captured/ps-proc-table/` (real bytes, structural-bytes-
  sacrosanct, same-shape redaction) covering at minimum: a `dd-hh:mm:ss` day-prefix
  row (the ~24h anchor case), an `lstart=` EMBEDDED-SPACE row (`Sat Jul  3 11:34:22
  2026` — a multi-token mid-field-list value that misaligns a naive whitespace split;
  round-10 — lessons), a space-bearing/clamped `comm`, a `<defunct>`/zombie row, and a
  permission-denied/gone pid — loaded via `loadCapturedFixture(...)` in a
  feeds-and-asserts test asserting BOTH correct core-equivalent computation AND the
  fail-closed→UNKNOWN behavior on the malformed rows. **The `lsof`-shaped writable-fd
  probe parser is ALSO registered (round-10 — lessons) with its own realness fixture,
  OR documented as using a non-textual API; either way the probe-FAILURE direction is
  DEFER-within-`maxKillDeferrals` (§4).** The launchctl-label reader is registered if
  textual, OR documented redundant-with-the-provenance-veto (a bare `ppid===1` with no
  provenance is already a floor VETO).
- **Discriminator fixture coverage (round-10 — codex):** the P19 ledger-key
  discriminator is exercised across multi-window, multi-workspace, symlinked-workspace,
  and MISSING-`--user-data-dir` (volatile-fallback) cases; the test documents the
  expected false-suppression behavior of the class-level fallback (it shields the whole
  class from KILL, never from the observability floor).
- **Dev-gate wiring (round-10 — integration):** the `DEV_GATED_FEATURES`-driven
  both-sides wiring test (the #1001-class guarantee) covers
  `monitoring.externalHogSentinel.enabled` — asserting it resolves live-on-dev /
  dark-on-fleet with no `ConfigDefaults` literal.
- **Strip-allowlist negative invariant (round-9 — integration):** a guard-test asserts
  `externalHogSentinel` is absent from every per-feature dev-gate strip allowlist
  (`migrateDevGateTeethStrip` and siblings) — for this key `enabled:false` is a
  load-bearing operator disarm, never a stale default.
- **Own-root exclusion (round-10 — integration):** a same-euid high-CPU descendant of
  a launchd-DIRECT lifeline (no tmux ancestor) is excluded via the own-root fallback
  (`process.pid` / recorded instar pids), not just the tmux-pane walk.
- **Armed-marker lifecycle (round-9 — security):** an `arm(PIN) → disarm →
  config.dryRun:false → restart` sequence boots UNARMED (marker invalid,
  `armEpoch ≤ lastDisarmEpoch`) — re-arming requires a fresh PIN; a per-class
  content-hash arm-scope kills an unchanged class, alert-onlys a new OR broadened
  class until re-arm.
- **Guard-posture honesty (round-9 — integration):** the reachable
  `config.dryRun:false` + marker-absent state reports `on-dry-run` (v1 maps the
  deferred `armed-pending` → `on-dry-run` per §8), never `on-confirmed`. <!-- tracked: CMT-1901 -->
- **P17 burst-invariant:** a burst of M simultaneous zombie kills produces ≤ the
  notice budget (wire into `notification-flood-burst-invariant.test.ts`); the
  undeliverable-alert surfaces via the idempotent status/guard-posture row only, never
  a per-scan attention record.
- **Sampler-liveness (round-9 — scalability):** an IDLE machine (zero candidates for
  many cycles) is NOT classified sampler-dead (the per-cycle heartbeat advances
  `lastSnapshotAt`); a genuinely dead sampler self-heals under the P19 cap and only
  degrades loudly after the retry budget is exhausted.
- **P19 breaker:** the same signature re-appearing every cycle trips the breaker
  and STOPS killing after K attempts, surfacing ONE degradation.
- **Event-loop safety assertion:** no `/kill-lane` or kill-time-re-confirm code path
  issues a SYNCHRONOUS sampling call on the server event loop (all sampling/identity
  re-reads are async or worker-side — the #1069 guard, enforced by test).
- **Integration:** `GET /external-hog` + audit read (Bearer-authed); guard-posture
  row.
- **E2E:** feature-alive (200 not 503 when enabled); a synthetic
  orphaned-high-CPU-delta fixture process is classified confirmed-zombie and
  (in live mode) reaped; a synthetic root-daemon / launchd-labeled fixture is left
  alone.
- **Live-user-channel proof:** the coalesced auto-kill Telegram notice + the alert
  path, driven as the user (test-as-self), per the standing mandate.

## Benchmark linkage

`research/llm-pathway-bench/instar-bench-v2/tasks/zombie-classify.json` (committed,
CMT-1901) measures which model best makes the kill|leave|alert call — the DECISION
the intelligence owns (§5). The mechanical safety floor (§4) only vetoes; the model
this benchmark selects is the actual decider, so the benchmark is load-bearing.

## Out of scope / follow-ups <!-- tracked: CMT-1901 -->

- Growing the code-defined allowlist beyond editor exthosts (evidence-gated, source
  PR). The §4 observability alerts double as allowlist-CANDIDATE nominations — a
  recurring sustained external hog of a new class can be recommended for candidacy in
  the alert text — but expansion itself stays a reviewed source change, never a
  runtime knob.
- An EXTERNAL aggregate small-process storm (many sub-threshold processes summing to
  a machine-saturating load) — invisible to the per-pid `cpuCoreThreshold`; a named
  follow-up (a cheap `total-external-Δcputime > X cores` observability-only trigger). <!-- tracked: CMT-1901 -->
  instar-ORIGIN storms are already owned by the fork-bomb spawn-cap floor.
- A finer CPU-time source — a `proc_pidinfo(PROC_PIDTASKINFO)` / `proc_pid_rusage`
  native addon — as a follow-up to the v1 `ps time=` acquisition. <!-- tracked: CMT-1901 -->
- Cross-machine (fleet-phase) arming via the WS4.4 mesh-signed operator assertion
  (see Multi-machine posture) — until then arm is per-machine-dashboard-only.
- A wedged root-owned daemon (e.g. fseventsd) — cannot be auto-killed here; belongs
  to the **machine-ownership** workstream (CMT-1902), where a machine the agent owns
  grants standing authority for privileged daemon management.
- Leftover-state cleanup on a full feature revert — the sampler snapshot artifact,
  the durable kill ledger, and `logs/external-hog-kills.jsonl` are inert if the
  feature is removed (no runtime consumer); a cleanup pass is a follow-up, not a v1 <!-- tracked: CMT-1901 -->
  obligation.

## Open questions

*(none)*
