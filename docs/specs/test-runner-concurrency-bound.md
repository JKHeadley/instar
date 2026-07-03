---
title: "Test-Runner Concurrency Bound"
slug: "test-runner-concurrency-bound"
author: "echo"
status: draft
parent-standard: "Bounded Blast Radius"
eli16-overview: "docs/specs/test-runner-concurrency-bound.eli16.md"
---

# Test-Runner Concurrency Bound — a host-wide vitest semaphore (Bounded Blast Radius)

## Constitutional fit

This spec implements the **Bounded Blast Radius** constitutional standard (the same standard that mandates the fork-bomb LLM-spawn cap). An unbounded per-actor resource-spawn pattern whose host-wide aggregate is catastrophic is precisely what that standard exists to prevent; the test-runner storm is the second instance of that class (the first, LLM subprocesses, is already bounded). It also serves **Responsible Resource Usage** (OS resource hygiene) and directly closes the load-stall kill cascade documented in the 2026-07-02 respawn root-cause analysis.

**But it is NOT a verbatim copy of the spawn cap.** Round-1 convergence review established that the spawn cap's core reclaim policy and fail-direction were tuned for a *fundamentally different consumer* (one long-lived server process, second-scale holds, an OOM-catastrophe fail-direction). Reusing them unmodified would re-create the exact meltdown this feature prevents and inherit the 2026-07-01 stale-holder wedge. This spec therefore **extracts a parameterized core** and derives a *consumer-specific* policy for the test lane. §1.1 is the load-bearing section: the fail-direction inverts.

## 1. Problem

A vitest ROOT process is not one process: it forks a worker pool sized to the machine (~cores threads/forks). N concurrent roots ≈ N × cores workers competing for CPU, memory, and the filesystem. On an Instar dev host, many actors start suites independently and simultaneously:

- several agent build sessions, each running `pnpm test` / `pnpm test:integration` in its own worktree;
- every `git push` (husky pre-push runs a suite);
- `/build` phase gates and scratch verification runs;
- occasional operator-driven runs.

Nothing bounds the SUM. The existing fork-bomb spawn cap (`hostSpawnSemaphore`) bounds LLM subprocesses only — test runners ride completely outside it. 29 concurrent roots on a 16-core host ≈ 300+ runner threads: the event loops of the co-resident agent servers starve, their supervisors interpret the stall as ill-health, and healthy servers get killed. The safety mechanism becomes the outage.

This is the same *class* as the 2026-06-20 LLM fork-bomb, one layer over: an unbounded per-actor spawn pattern whose aggregate is catastrophic, needing a HOST-WIDE counting bound at a single structural chokepoint.

### 1.1 The fail-direction INVERTS from the spawn cap (the load-bearing design decision)

The spawn cap fails **closed** on uncertainty (can't confirm host-local disk → refuse to reclaim → keep counting; can't acquire → don't spawn). That is correct *for an OOM safety floor*: a delayed LLM spawn is cheap, an OOM is catastrophic, and its background consumers have a heuristic-degradation fallback when a call is shed. **None of that holds for a test cap.** The harms invert:

- A false **BLOCK** (over-counting, a stale/phantom holder, a wedged lock) has NO degradation path — it wedges *every* `git push` (husky pre-push), *every* `/build` phase gate, and *every* scratch run host-wide behind a loud timeout wall. On a host that can't push, the agent can't ship the fix for the very reachability/load incidents this family exists to prevent — the bound blocks the release valve.
- A false **PASS** (bounded over-admission) is one extra concurrent suite — transient, self-limiting CPU pressure that resolves in minutes.

Therefore the least-harmful direction on *uncertainty* for THIS detector is **fail-OPEN — admit the run**. Every uncertainty branch in this spec (df misclassification, pid-reuse, corrupt holders file, unavailable lock, unresolvable ancestry) biases toward *admitting* a run over *wedging* the dev loop. This is the single most important divergence from the spawn cap and it is applied consistently below. (State-Not-Symbol: "unknown fails toward the least-harmful action *for that detector*" — and this detector's least-harmful is the opposite of the spawn floor's.)

### 1.2 Prior incident this design must not repeat (2026-07-01)

On 2026-07-01 a crashed agent server left **unreaped holders** in `host-spawn-holders.json` → **false saturation** → the tone gate (a fail-closed consumer) held → **the agent went unreachable**. The inherited "dead-holder auto-heal" did NOT fire; recovery was a manual dead-PID prune of the holders file. That incident is *this exact holder-set reclaim logic failing to self-heal in production.* Building a SECOND semaphore on the same core doubles that surface, and the test lane makes each stale holder worse (cap 1–2 vs 8 → one phantom is 50–100% of capacity; minute-scale suites vs second-scale spawns → wider stale window + more pid-reuse exposure). This design answers the incident directly with: fail-OPEN on uncertainty (§1.1), a max-hold TTL that reclaims even a pid-alive holder (§2.4), immediate reclaim of a provably-dead pid (§2.4), and a first-class manual + passive prune lever (§2.6). §5 requires tests that specifically exercise crashed / SIGKILL / pid-reuse / hung holders on the *test* file.

## 2. Design

### 2.1 Primitive — extract a PARAMETERIZED core; do NOT reuse spawn semantics verbatim

Extract the holder-set mechanics of `src/core/hostSpawnSemaphore.ts` into a shared internal core `src/core/hostSemaphoreCore.ts`. The extraction seam is explicit (integration review M2):

- **Moves into the core:** the lock primitive (`O_CREAT|O_EXCL` + stale-lock reclaim), holders read/parse/write (atomic temp+rename), the host-local `df -P` determination, and the prune-dead pass — but the prune-dead pass takes a **ReclaimPolicy** parameter (see §2.4), not the spawn cap's hardcoded `pidDead && heartbeatStale && dfLocal`.
- **`acquire()` admission is parameterized** via an optional `admit(live, cap) => boolean` predicate. The spawn cap passes its F5 interactive/background reservation predicate; the test lane passes a plain `live.length < cap`. The F5 lane logic is NOT hoisted into the core — it stays in `hostSpawnSemaphore`'s predicate.
- **The singleton + config layer stays per-module** (`configureHostSpawnSemaphore` / `getHostSpawnSemaphore` / `_resetForTest` are duplicated thin per module — two holders files, two caps, two independently-tunable policies). It is NOT extracted (two caps can't share one singleton).
- **`hostSpawnSemaphore.ts`'s public export list AND its on-disk holders-file byte format are unchanged.** A golden/characterization test (§5) pins the spawn holders format (including the optional `lane` field's presence/absence) byte-identical pre/post extraction, and the 10 importers (4 src, 6 test) are verified against the unchanged export surface. The extraction is treated as its OWN reviewed change with its own tests — not an assumed no-op.

New `src/core/hostTestRunnerSemaphore.ts` — holders file `~/.instar/host-test-runner-holders.json`, cap from `INSTAR_HOST_TEST_MAX`, the plain `admit` predicate, and the test **ReclaimPolicy** (§2.4). Two resource pools stay strictly separate (separate holders + lock files, no cross-talk); the two caps are **independent and additive**, not jointly bounded (§2.7).

### 2.2 Chokepoint — vitest globalSetup, with hard performance constraints

A `tests/setup/test-runner-semaphore.globalSetup.ts` is added to the `globalSetup` of all five vitest configs (`vitest.config.ts`, `vitest.integration.config.ts`, `vitest.e2e.config.ts`, `vitest.contract.config.ts`, `vitest.push.config.ts`). Only the integration config already has a `globalSetup` array (`build-dist.globalSetup.ts`) — there the semaphore is **prepended** so `setup()` acquires before the dist build and `teardown()` releases after it (globalSetup teardown runs in reverse); the slot is deliberately held through the build (acceptable at this cap). The other four are a plain add. Integration review confirmed these 5 are exhaustive (no `vitest.workspace.ts`, no programmatic `startVitest`; every `package.json` path + husky pre-push routes through one of the 5). A §5 guard-test asserts every `vitest.*.config.ts` includes the globalSetup so a future 6th config can't silently escape the bound.

**Hard implementation constraints (each closes a round-1 finding — a naive reuse re-creates the meltdown):**

1. **Async yielding wait, never a busy-spin.** The between-poll wait MUST be `await new Promise(r => setTimeout(r, interval))`. The spawn cap's in-module `busyWaitTiny()` synchronous spin, multiplied across 20+ queued cold-starting roots, pegs every core for the whole wait — re-introducing the exact starvation this spec prevents. Only the sub-millisecond lock critical section may spin, and its deadline MUST exceed the critical-section duration.
2. **`df -P` OUTSIDE the lock.** The host-local determination is computed BEFORE taking the holders lock and passed in, so the critical section is file-read + count + write (sub-ms). (In the spawn cap a single long-lived server memoizes `df` once; here every root is fresh, so `df`-under-lock would hold the exclusive lock for up to 3s while all others spin-and-timeout.) The determination is cached to a small on-disk marker so cold-start roots skip the probe entirely.
3. **Jitter, not backoff, on the poll; write only on change.** The poll is cheap (0.2/s) so backoff isn't needed and would only delay noticing a freed slot; instead add ±jitter to desynchronize the thundering herd, and skip the holders rewrite on a failed acquire when prune removed nothing (the spawn cap rewrites on every failed poll → O(waiters) churn). This is the correct reading of the conformance gate's "no backoff" flag: **jitter-not-backoff.**
4. **Throw a typed error on timeout, never `process.exit()`.** `process.exit` bypasses vitest cleanup and any prepended-after teardowns and can leak the slot; a thrown typed error is reported cleanly by vitest and leaves no holder. Confirm no slot is held on the timeout path. The poll carries P19 brakes: bounded interval + jitter, a hard wait ceiling, bounded per-minute logging.
5. **Acquire BEFORE worker-pool fanout — a load-bearing invariant that MUST be verified, not assumed.** The whole design rests on `globalSetup` running before vitest materializes the worker pool (and its transform/project-graph/reporter state). If a vitest version initializes any of that before `globalSetup`, the semaphore would bound only part of the blast radius. §5 carries an explicit validation item that instruments each pinned config/version to prove the slot is acquired before worker fanout; if a version cannot guarantee it, the chokepoint moves to a thin wrapper (`node scripts/guarded-vitest.mjs` invoked by the test scripts) that acquires before spawning vitest at all. The spec does not ship on the *assumption* — it ships on the verified invariant or the wrapper fallback.

### 2.3 Run-class differentiation (resolves the coarse-cap tension)

A single coarse root-count cap is caught between two real needs: the operator directive "NEVER run builders' full **suites** concurrently" argues for a very low cap on suites, while an inner-loop `npx vitest run one.test.ts` (1–2 workers, trivial load, nowhere near a fork-bomb) should not be blocked behind two full suites for up to the wait ceiling. So the globalSetup classifies the run:

- **suite-class** — the integration / e2e / contract / push configs (always full suites), AND a `vitest.config.ts` run with NO explicit file/pattern filter in argv (a full default-suite run). Counted against the cap.
- **targeted-run** — `vitest.config.ts` invoked with an explicit file or pattern filter in argv (a single-file / focused TDD run). **Exempt** from the cap (it still forks a worker pool, but it is not the full-suite fork-storm the directive targets, and blocking the inner loop trains `--no-verify`). Exemption is logged (§2.6).

This lets the suite-class cap sit at the low value the directive wants without punishing the inner loop, and it makes "bound every root" no longer the design (closing the scope decision by construction — see Frontloaded Decisions).

### 2.4 ReclaimPolicy for the test lane (parameterized, NOT the spawn defaults)

The test lane's ReclaimPolicy diverges from the spawn cap's on every axis where the workload differs:

- **Immediate reclaim of a provably-dead pid.** On a df-confirmed-local disk, a holder whose pid is dead is reclaimed IMMEDIATELY — no 5-minute `heartbeatStale` gate. That gate exists to protect a *live-but-heartbeat-quiet* spawn from reclaim; the test lane has no heartbeat-refresh thread, so a live suite is already fully protected by pid-liveness alone, and the gate would only add up-to-5-min reclaim latency after every test crash/Ctrl-C (a frequent dev event that would otherwise stall the next push).
- **Max-hold TTL with SIGTERM (the single most important test-lane addition).** A holder older than a ceiling (default 60 min, > the longest legitimate suite) is reclaimable EVEN IF its pid is alive; the reclaimer SIGTERMs the offending root (loud, audited) and frees the slot. This closes the "hung-but-alive vitest root never reclaimed → two hangs wedge all host testing indefinitely" failure that pid-liveness alone cannot (a hung root keeps its pid alive forever). Also self-heals the pid-reuse leak (a reused pid past the ceiling is reclaimed regardless).
- **Fail-OPEN on reclaim uncertainty** (§1.1): if `df` can't confirm host-local, if the holders file is corrupt/unparseable, or if the lock can't be taken within its short deadline, the globalSetup ADMITS the run (bounded over-admission) rather than wedging — the opposite of the spawn cap. On a corrupt file the design **admits AND quarantines** (a reconciliation of the fail-open direction with the external reviewer's concern that silently rewriting-empty could mask a concurrent-writer/fs bug): under the lock, the corrupt file is renamed aside to `host-test-runner-holders.corrupt-<ts>.json` for inspection (never silently discarded), a fresh empty holders file is created via the single repair path, and the run is admitted. A "poison sanity ceiling" (liveHolders beyond an absurd bound) is treated as corruption and takes the same quarantine path. A **foreign-hostname holder on a df-confirmed-local disk is bogus by this design's own host-local contract** — it is dropped (not counted forever) and surfaced loudly as a likely synced-`~/.instar` signal (§2.7).

### 2.5 Re-entrancy — ancestry + holders cross-check, NOT a bare inherited env flag

A test can itself spawn a child vitest; without a skip it would deadlock waiting for a slot its parent holds. The spawn-boundary makes a bare inherited `process.env` flag unsafe on two counts: (a) vitest runs the *test* in a WORKER whose env is a snapshot — a `process.env` mutation made in the root's globalSetup is NOT guaranteed to reach the worker (pool/version-dependent; threads copy env unless `SHARE_ENV`), so the child's globalSetup may see no flag and deadlock against its own parent; (b) a leaked/exported flag in a persistent shell silently disables the bound host-wide (fail-open in the *wrong* place — a real second root skips).

The skip is therefore **corroborated, holder-scoped, and cross-checked**:

- The marker is `INSTAR_TEST_SEMAPHORE_HELD=<root-pid>:<slot-id>`, injected into worker env explicitly via each config's `test.env` (not left to ambient inheritance), so it reliably reaches the worker that spawns the child.
- A child skips ONLY when that marker names a pid that is a **live ancestor in the child's process tree** AND that pid holds a **current slot in the holders file**. A stale/foreign/leaked marker fails the ancestry+holders cross-check and does NOT skip (so a leaked export can't silently disable the bound).
- A **process-global in-memory flag** ensures one process never takes more than one slot even if multiple prepended globalSetups run in it (workspace/aggregate runs): once this process holds a slot, all further globalSetups in it skip.
- §5 meta-test spawns a REAL nested `vitest run` from inside a WORKER (not two roots) and asserts the child skips, and a second meta-test spawns a child with a SCRUBBED env and asserts the ancestry path still skips it (env alone would fail).

### 2.6 Exemptions, observability, and the recovery lever

- **Kill switch — env only.** `INSTAR_HOST_TEST_SEMAPHORE=off` is the SOLE chokepoint kill switch. Config `enabled:false` is NOT a chokepoint lever (the globalSetup runs in a bare test process that can't know which agent's config to read — the config lever would silently no-op, worse than no lever). The config `intelligence.testRunnerCap` exists only to tune the *route's report* and any server-launched tooling; §6 and this section state env-only rollback honestly.
- **CI exemption — hardened.** Skip only when `CI === 'true' || CI === '1'` AND a positive CI signal is present (`GITHUB_ACTIONS` / `RUNNER_OS`) — a stray local `CI` export (or `CI=false`, which is truthy) must not disable the dev-host bound. Documented assumption: GitHub-hosted ephemeral single-suite runners; a self-hosted shared runner running matrix jobs concurrently is out-of-scope (stated, not silently unbounded).
- **Watch / list exemption.** Detect via the globalSetup context `config.watch` (vitest v2+ context arg) with an argv fallback; a `vitest --watch` session skips (a long-lived interactive tool must not hold a slot for hours). This is an explicit **operator-trusted exemption, outside the bound** — NOT enforcement (a printed notice is not a cap): a watch session can still run expensive roots, and the design accepts that as an operator's deliberate long-lived tool rather than bounding it (bounding a watch session with its own small long-lived slot was considered and rejected as complexity out of proportion to the risk — watch sessions are few and operator-initiated). A collect/list invocation (`vitest list`, used by `pre-push-smoke.mjs`) is no-op'd on the same seam so a mere listing doesn't wait for or consume a slot.
- **Every skip prints one deterministic line** naming the reason (`off` / `CI` / `watch` / `list` / `reentrant` / `targeted-run` / `fail-open-admit`) so an inert bound is never silent (a fork-storm debugged with the guard off must be observable).
- **Distinct capacity-timeout signal.** The timeout throws a typed error with a DISTINCT exit code and an unmistakable message: "could not START within budget — this is NOT a test failure; N holders: [pid, age]; levers: INSTAR_HOST_TEST_SEMAPHORE=off, INSTAR_HOST_TEST_MAX". The per-minute wait line goes to STDERR and carries an active-work indicator recognized by the silence/load-stall sentinels (§2.8). CLAUDE.md tells agents a rejected push may be contention, not red tests.
- **Priority/timeout split.** Interactive- and pre-push-launched runs get a longer wait budget (they are user-blocking and few); background `/build` verification runs get the short fail-loud. The class is derived from the launching config (push config, or an env hint the server sets when it launches build tooling), never from user input.
- **Recovery lever (the 2026-07-01 lesson).** `POST /test-runner-limiter/prune` forces a reclaim pass (surfaced action, not a hand-edit of JSON). The read route passively prunes-on-read (a cheap self-heal). Both are considered for back-port to `/spawn-limiter`.

### 2.7 Observability route (parity + no-lie constraint)

`GET /test-runner-limiter` (Bearer-auth, GET-only, never on the `/health` allowlist) → `{ cap, liveHolders: [{pid, hostname, acquiredAt}], available, saturated }`, matching the `/spawn-limiter` shape decision (documented divergence: `/spawn-limiter`'s `waiters`/`acquireMs`/`waitersMax` are in-process-singleton stats the out-of-process test globalSetup doesn't share, so they are omitted rather than faked; `liveHolders` is an array here — the honest live-state read).

**No-lie constraint (integration H1):** the route resolves `cap` through the IDENTICAL resolver the globalSetup uses (`INSTAR_HOST_TEST_MAX` env → code-default), reading the holders file only for live state — NEVER from `intelligence.testRunnerCap.maxConcurrent` (which the enforcing process doesn't read; reporting a config cap while runs are bounded at the code-default would make the "why is my run waiting?" answer a lie). The status read is **lock-free and write-free** (read + parse + count-with-pid-liveness; no exclusive lock, no write-back) so polling the route never contends with acquisition.

**Security on the route (untrusted holder fields):** `hostname`/`id` are untrusted (a poisoned holders file can carry markup). They are clamped to a sane charset + length at the route projection and HTML-escaped on any render; verify whether the existing `/spawn-limiter` dashboard render escapes and fix the sibling if not. `~/.instar` is created `0o700` (owner-only holder metadata). Docs state: do NOT place `~/.instar` on a userspace-synced path (Dropbox/iCloud/Syncthing) — `df -P` reports such a home as local, and a synced holders file cross-counts foreign-hostname holders between machines (the §2.4 foreign-on-local-disk drop + loud surface is the mitigation).

### 2.8 The wait must not read as a hang (closes the very cascade this spec targets)

An agent `/build` session blocked in globalSetup for the wait budget shows a tmux frame with a once-a-minute line and no spinner — a plausible false-positive for the `ActiveWorkSilenceSentinel` (30-min threshold) and load-stall watchers whose false kills MOTIVATED this spec. Before shipping, the wait's frame signature is validated against the live silence/load-stall predicates; the printed wait line carries an active-work indicator those predicates recognize, OR the waiting run registers as known-blocked so no watcher kills it. Otherwise the fix re-triggers the exact layer-3 kill it targets (adversarial F10).

### 2.9 Config surface & audience split

`.instar/config.json` → `intelligence.testRunnerCap`: `{ enabled, maxConcurrent, acquireWaitMs }` (tunes the route report + server-launched tooling only; NOT the chokepoint kill switch — §2.6). Env is the chokepoint authority (test processes don't read agent config, and multiple agents on one host must agree): `INSTAR_HOST_TEST_MAX` (suite-class cap, code-default **1** — ratified §4), `INSTAR_HOST_TEST_ACQUIRE_MS`, `INSTAR_HOST_TEST_SEMAPHORE=off`, `INSTAR_HOST_TEST_ENFORCE` (unset ⇒ log-only dry-run — ratified §4; `1` ⇒ enforcing) (one prefix family, parity with the spawn cap's `INSTAR_HOST_SPAWN_*`), plus the internal `INSTAR_TEST_SEMAPHORE_HELD=<pid>:<slot>` re-entrancy marker.

**Migration wiring (Migration Parity):** type in `src/core/types.ts` under `intelligence`; default in `src/config/ConfigDefaults.ts` (the codebase's only-add-missing mechanism, matching the `spawnCap` treatment — no hand-written `migrateConfig` block); CLAUDE.md awareness in BOTH `src/scaffold/templates.ts` (new agents) AND `PostUpdateMigrator.migrateClaudeMd` (existing agents). **Audience split:** the chokepoint files (5 vitest configs, the globalSetup, the core, the new semaphore module) are instar-repo SOURCE — they reach the incident population (builder/worktree hosts) by `git` pull into a checkout, NOT via `PostUpdateMigrator`; the route + config knob + CLAUDE.md awareness ship to deployed agent servers via the update/migrate path.

## 3. What this is NOT

- NOT a change to any test's content, worker/pool settings, or vitest version.
- NOT a scheduler with priorities/preemption. Admission is barging (whoever wins the lock when a slot frees), bounded by the wait ceiling — **the spec makes NO FIFO fairness claim** (the holder-set primitive has no arrival ordering; an earlier "FIFO-ish" claim was inaccurate and is removed). A monotonic arrival ticket is a possible future refinement, explicitly out of scope.
- NOT cross-machine: holders file host-local by the `df -P` fail-closed contract. Multi-machine posture: **machine-local BY DESIGN** — a test run consumes THIS host's cores; the route needs no `?scope=pool` (nothing to aggregate). "Host-wide" means **across actors sharing one OS-user home** (`os.homedir()`); a multi-OS-user host (e.g. an operator's `git push` as `justin` vs an agent's `pnpm test` as `justin_instar_1`) is not bounded across users — stated, with single-user dev host as the covered case. The test cap and the LLM spawn cap are **additive, not jointly bounded** (worst case ≈ suite workers + 8 spawns) — the combined ceiling to sanity-check against core count.
- NOT a gate on WHAT code may run: a deterministic resource bound (counting, no content judgment), same class as the shipped spawn cap — Signal-vs-Authority compliant (no brittle blocking authority over behavior).

## 4. Frontloaded Decisions

Resolved here so the /instar-dev build never stops to ask. The run-class design (§2.3) already resolves the original "bound every root vs only suites" scope question by construction (suites counted, targeted runs exempt). Published interfaces are FROZEN at build start (renaming post-ship is a breaking change to a fleet interface): env names (`INSTAR_HOST_TEST_MAX`, `INSTAR_HOST_TEST_ACQUIRE_MS`, `INSTAR_HOST_TEST_SEMAPHORE`, `INSTAR_HOST_TEST_ENFORCE`, `INSTAR_TEST_SEMAPHORE_HELD`), config path `intelligence.testRunnerCap.{enabled,maxConcurrent,acquireWaitMs}`, the holders-file path `~/.instar/host-test-runner-holders.json` (a cross-process rendezvous contract — every instar version/agent on a host must agree byte-identically or the bound splits into sub-bounds), and the route shape `GET /test-runner-limiter`.

**Two items were the operator's call, and both are now RATIFIED** (operator ratification 2026-07-02, topic 30379 — "Go with your recommendations"):

- **[RATIFIED] Suite-class default cap = 1.** The standing operator directive "NEVER run builders' full suites concurrently" is honored literally: full suites serialize one-at-a-time per host (targeted runs already exempt via §2.3, so the inner loop is unaffected). The per-host escape hatch remains `INSTAR_HOST_TEST_MAX=2` if serialization proves too slow — an operator lever, not a default.
- **[RATIFIED] Ship posture = dry-run-first soak, then enforce.** The chokepoint ships in a **log-only "would-block" dry-run** (`INSTAR_HOST_TEST_ENFORCE` unset ⇒ dry-run: every would-block decision is logged with the holder set that would have blocked it, the run is admitted). After a soak window proves the classification + observability under real load with zero false would-blocks, enforcement is flipped by setting `INSTAR_HOST_TEST_ENFORCE=1` in the host environment (same env-authority chokepoint as the other levers — §2.9; the flip is an operator/dev decision recorded at flip time, not an auto-promotion). The first-line rollback from "enforcing wedged something" is unsetting it — back to dry-run, not off.

## 5. Test plan (Testing Integrity — all three tiers)

- **Unit** (`tests/unit/host-test-runner-semaphore.test.ts`): cap enforcement; the test ReclaimPolicy (immediate dead-pid reclaim; max-hold TTL reclaims a pid-ALIVE holder + SIGTERMs it; fail-OPEN on corrupt file / df-unknown / lock-unavailable; foreign-hostname-on-local-disk dropped); jitter/write-only-on-change; async-wait (no busy-spin); ancestry+holders re-entrancy skip; process-global one-slot-per-process; env-only kill switch; hardened CI predicate.
- **Core extraction** (`tests/unit/host-semaphore-core.test.ts` + the untouched `hostSpawnSemaphore` suite passing byte-for-byte): the `admit`/ReclaimPolicy parameterization; a **golden test** pinning the spawn holders-file byte format (disabled-lane state) unchanged; an export-list-unchanged assertion.
- **Integration** (`tests/integration/test-runner-limiter-route.test.ts`): `GET /test-runner-limiter` through the real routes pipeline (200; Bearer required; cap resolved via env→code-default NOT config — a config-set maxConcurrent must NOT change the reported cap; lock-free read); `POST /test-runner-limiter/prune`.
- **E2E** (`tests/e2e/test-runner-limiter-lifecycle.test.ts`): the route is ALIVE through real AgentServer plumbing (200 not 503).
- **Meta-verification** (does the chokepoint actually bind?): two minimal vitest child runs with cap=1 against a temp holders file assert serialized execution windows; a REAL nested `vitest run` spawned from inside a WORKER asserts the child skips; a child spawned with a SCRUBBED env asserts the ancestry path still skips it; a hung-holder fixture asserts the max-hold TTL reclaims + SIGTERMs; a corrupt-file fixture asserts admit-AND-quarantine (the corrupt file is renamed aside, a fresh one created, the run admitted); a config-list guard-test asserts every `vitest.*.config.ts` includes the globalSetup.
- **Acquire-before-fanout validation** (the load-bearing invariant, §2.2 item 5): for each pinned vitest config/version, instrument the globalSetup and a worker to record timestamps and assert the slot is acquired BEFORE the first worker forks. If the pinned version cannot guarantee it, this test fails and forces the `guarded-vitest.mjs` wrapper fallback — the spec must not ship on the unverified assumption.

## 6. Rollback & failure table

**Rollback:** `INSTAR_HOST_TEST_SEMAPHORE=off` (env, immediate, no release — the sole chokepoint switch). Full rollback = revert the PR (pure code + config defaults; no persistent state beyond the inert holders file). The ratified dry-run-first posture (§4) means the enforcing behavior is itself behind the `INSTAR_HOST_TEST_ENFORCE` flip, so the first-line rollback from "enforcing wedged something" is unsetting it — back to dry-run, not off.

| Failure | Behavior | Direction |
|---|---|---|
| Holders file corrupt/unparseable | treat as empty, rewrite; poison-sanity ceiling on absurd counts | **fail-OPEN** (admit) |
| `df -P` can't confirm host-local | admit the run; reclaim disabled for that pass | **fail-OPEN** (admit) |
| Lock unavailable within deadline | admit the run (never wedge on a contended lock) | **fail-OPEN** (admit) |
| Holder pid dead (df-local) | reclaimed IMMEDIATELY (no 5-min gate) | self-heals fast |
| Holder hung-but-pid-alive past TTL | reclaimed + SIGTERM'd (loud, audited) | self-heals, bounded |
| Foreign-hostname holder on local disk | dropped + surfaced loudly (synced-home signal) | self-heals |
| SIGKILL'd root | pid-dead ⇒ immediate reclaim next pass | self-heals fast |
| Wait timeout | typed error, DISTINCT exit code, "NOT a test failure" + levers | visible, never silent |
| Re-entrant child (verified ancestor+slot) | skips acquisition | no deadlock |
| Stale/leaked HELD marker | fails ancestry+holders cross-check ⇒ does NOT skip | bound stays live |
