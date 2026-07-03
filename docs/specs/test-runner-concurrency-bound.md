---
status: draft
---

# Test-Runner Concurrency Bound — a host-wide vitest semaphore (Bounded Blast Radius)

**Slug:** `test-runner-concurrency-bound`
**Author:** Instar Agent (echo)
**Date:** 2026-07-02
**Parent standard:** Bounded Blast Radius (constitution); sibling of `docs/specs/forkbomb-prevention-simple.md` (the LLM-subprocess spawn cap)
**Incident:** 2026-07-02 — 29 concurrent `vitest` root processes on one host starved the event loop of the agent servers sharing it; the load-stall health checks then KILLED healthy servers (respawn-rootcause layer 3). Also a standing operator directive: "NEVER run builders' full suites concurrently."

## 1. Problem

A vitest ROOT process is not one process: it forks a worker pool sized to the machine (~cores threads/forks). N concurrent roots ≈ N × cores workers competing for CPU, memory, and the filesystem. On an Instar dev host, many actors start suites independently and simultaneously:

- several agent build sessions, each running `pnpm test` / `pnpm test:integration` in its own worktree;
- every `git push` (husky pre-push runs the unit suite);
- `/build` phase gates and scratch verification runs;
- occasional operator-driven runs.

Nothing bounds the SUM. The existing fork-bomb spawn cap (`hostSpawnSemaphore`) bounds LLM subprocesses only — test runners ride completely outside it. 29 concurrent roots on a 16-core host ≈ 300+ runner threads: the event loops of the co-resident agent servers starve, their supervisors interpret the stall as ill-health, and healthy servers get killed. The safety mechanism becomes the outage.

This is the same shape as the 2026-06-20 LLM fork-bomb, one layer over: an unbounded per-actor spawn pattern whose aggregate is catastrophic, needing a HOST-WIDE counting bound at a single structural chokepoint.

## 2. Design

### 2.1 Primitive — reuse the proven holder-set semaphore, as a parameterized core

Extract the holder-set mechanics of `src/core/hostSpawnSemaphore.ts` (exclusive `O_CREAT|O_EXCL` lock file, atomic temp+rename holder records `{id, pid, hostname, acquiredAt}`, count-live-holders-never-mutate-a-counter, dead-holder prune gated on pid-dead-AND-heartbeat-stale, FOREIGN-hostname holders never pruned, `df -P` host-local-disk fail-closed reclaim gate) into a shared internal core (`src/core/hostSemaphoreCore.ts`), consumed by:

- `hostSpawnSemaphore.ts` — unchanged public API and unchanged holders file (`~/.instar/host-spawn-holders.json`); a pure refactor proven by its existing test suite passing untouched.
- NEW `src/core/hostTestRunnerSemaphore.ts` — holders file `~/.instar/host-test-runner-holders.json`, cap from `INSTAR_HOST_TEST_MAX` (default **2**), no lanes (tests have no interactive/background split).

Two resource pools stay strictly separate: a test run must never consume an LLM spawn slot or vice versa.

**Decision (why not a second bespoke module):** the 2026-06-15 ResumeQueue lesson and the spawn-cap hardening (pid-reuse, cross-host volumes, partial writes) are exactly the bugs a fresh copy would re-earn. One audited core, two thin instantiations.

### 2.2 Chokepoint — vitest globalSetup in every repo config

A tiny `tests/setup/test-runner-semaphore.globalSetup.ts` is PREPENDED to the `globalSetup` array of all five vitest configs (`vitest.config.ts`, `vitest.integration.config.ts`, `vitest.e2e.config.ts`, `vitest.contract.config.ts`, `vitest.push.config.ts`):

- **setup():** acquire one slot with bounded ingress (poll every 5s up to `INSTAR_TEST_SEMAPHORE_WAIT_MS`, default 15 min). On success, export `INSTAR_TEST_SEMAPHORE_HELD=1` into `process.env` (inherited by every child the run spawns). On timeout: **fail LOUD** — exit non-zero with a message naming the live holders (pid + acquiredAt), the cap, and the two levers (`INSTAR_HOST_TEST_MAX`, `INSTAR_TEST_SEMAPHORE=off`). A resource bound that "proceeds anyway" is advisory, not a bound.
- **teardown():** release the slot. SIGKILL'd runs are reclaimed by the dead-holder prune (the holder's pid is the vitest root pid; no live-heartbeat thread is needed because prune requires pid-dead — a live long suite can never be reclaimed out from under itself).

Why globalSetup and not a package.json wrapper script: globalSetup catches EVERY invocation path through the repo's configs — `pnpm test`, bare `npx vitest run foo.test.ts`, husky pre-push, /build phases — with zero wrapper drift risk. (The e2e config's existing "deliberately NO build-dist globalSetup" note (instar#1069) is about not paying a BUILD on every e2e run; this setup does no build, no dist access — a sub-millisecond file lock — so it does not violate that decision. The spec calls this out so the e2e config comment is updated to say "no BUILD-dist globalSetup", not "no globalSetup".)

### 2.3 Exemptions and re-entrancy (each one closes a real deadlock or wedge)

1. **Child-run re-entrancy:** a test that itself spawns vitest (the repo has such tests) would deadlock waiting for a slot its parent holds. `INSTAR_TEST_SEMAPHORE_HELD=1` in the environment → the child's globalSetup SKIPS acquisition (the parent's slot covers its process tree). Set by the setup itself, so it propagates automatically.
2. **CI:** `process.env.CI` → skip. GitHub runners are ephemeral single-suite machines; the bound targets shared dev/agent hosts. (CI also must never be blocked by a stale holders file from a previous life of a self-hosted runner.)
3. **Watch mode:** `vitest --watch` skips WITH a one-line printed notice. A watch session is a long-lived interactive tool; holding a slot for hours would wedge the queue, and the measured incident shape is `vitest run` storms, not watch sessions.
4. **Kill switch:** `INSTAR_TEST_SEMAPHORE=off` env or `intelligence.testRunnerCap.enabled: false` config → skip entirely (the no-release rollback lever).

### 2.4 Observability (Registry First)

- Read-only route `GET /test-runner-limiter` on the agent server, mirroring `GET /spawn-limiter`: `{ cap, liveHolders: [{pid, hostname, acquiredAt}], available, saturated }`, reading the holders file directly (works even while saturated — the server never acquires).
- The waiting globalSetup prints one line per minute of wait: who holds the slots and for how long — an agent staring at a "stuck" test run sees WHY immediately.
- CLAUDE.md template + PostUpdateMigrator awareness section per the Agent Awareness + Migration Parity standards ("why is my test run waiting?" → read the limiter route).

### 2.5 Config surface

`.instar/config.json` → `intelligence.testRunnerCap`: `{ enabled: true, maxConcurrent: 2, acquireWaitMs: 900000 }`. Env (`INSTAR_HOST_TEST_MAX`, `INSTAR_TEST_SEMAPHORE_WAIT_MS`, `INSTAR_TEST_SEMAPHORE`) overrides config, because test processes don't read the agent config and multiple agents on one host must agree — env + code defaults are the authority; config exists so an operator can tune per-agent tooling that LAUNCHES runs. Default cap 2: the incident host runs 3 agents; 2 roots × ~16 workers is the measured comfortable ceiling, and a queued run behind a 5-minute suite loses less time than a starved host loses to kill cascades.

## 3. What this is NOT

- NOT a change to any test's content, workers/pool settings, or vitest version.
- NOT a scheduler: FIFO-by-arrival polling, no priorities, no preemption (the F5 interactive-lane problem is the SPAWN semaphore's concern, not this one — tests are all background-class).
- NOT cross-machine: the holders file is host-local by contract (same `df -P` fail-closed gate as the spawn cap). Multi-machine posture: **machine-local BY DESIGN** — a test run consumes THIS host's cores.
- NOT a gate on what code may run: signal-vs-authority — this is a deterministic resource bound (counting, no content judgment), the same class as the shipped fork-bomb spawn cap.

## 4. Failure modes and the safe direction

| Failure | Behavior | Direction |
|---|---|---|
| Holders file corrupt/unparseable | treat as empty + rewrite on next acquire (single-host file, worst case brief over-admission) | fail-open on the BOUND, never wedge testing |
| Lock file orphaned (crash mid-acquire) | stale-lock breaker after N seconds (core already has it) | never wedge |
| Holder SIGKILL'd | pid-dead prune reclaims on next acquire attempt | self-heals |
| Foreign-hostname holder (shared volume) | never pruned; counts toward cap; loud log | fail-closed per host-local contract |
| Cannot confirm host-local disk | bound still enforced; reclaim disabled | fail-closed on reclaim, never on bounding |
| Wait timeout | loud non-zero exit naming holders + levers | visible, never silent |

## 5. Test plan (Testing Integrity — all three tiers)

- **Unit** (`tests/unit/host-test-runner-semaphore.test.ts`): cap enforcement, FIFO-ish admission under contention, dead-holder reclaim, foreign-host refusal, corrupt-file recovery, re-entrancy env skip, the extracted core keeps `hostSpawnSemaphore`'s entire existing suite green byte-for-byte.
- **Integration** (`tests/integration/test-runner-limiter-route.test.ts`): `GET /test-runner-limiter` through the real routes pipeline (200 with live holders; auth required).
- **E2E** (`tests/e2e/test-runner-limiter-lifecycle.test.ts`): the route is ALIVE through real AgentServer plumbing (200 not 503).
- **Meta-verification** (the "does the chokepoint actually bind?" test): a unit test spawns two minimal vitest child runs with cap=1 against a temp holders file and asserts serialized execution windows (no overlap), plus the `INSTAR_TEST_SEMAPHORE_HELD` child-skip.

## 6. Rollback

`INSTAR_TEST_SEMAPHORE=off` (env, immediate, no release needed) or config `enabled:false`; full rollback = revert the PR (pure code + config defaults; no persistent state beyond the holders file, which is inert when nothing reads it).
