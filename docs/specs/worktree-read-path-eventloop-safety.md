---
title: "Worktree read-path event-loop safety — a status route must not freeze the server"
slug: "worktree-read-path-eventloop-safety"
author: "echo"
parent-principle: "Structure beats Willpower"
status: "draft"
tier: 3
origin: "2026-07-29 topic 37155 — blocking finding on the guard-enumeration spec (PR #1748), raised in five separate convergence rounds across two failed 10-round attempts"
relates:
  - "docs/specs/agent-worktree-reaper.md"
  - "docs/specs/ORPHANED-WORK-SENTINEL-SPEC.md"
  - "docs/specs/CARTOGRAPHER-SWEEP-EVENTLOOP-SAFETY.md"
  - "docs/specs/tmux-event-loop-resilience.md"
  - "docs/postmortems/2026-06-07-server-temporarily-down.md"
---

# Worktree read-path event-loop safety

## Problem

`GET /worktrees/agent-reaper` was a non-async Express handler calling
`AgentWorktreeReaper.snapshot()` directly. `snapshot()` fans `evaluate()` out over
every worktree, and each gate shells out **synchronously** through
`SafeGitExecutor.readSync` (`execFileSync`). A synchronous spawn cannot be
preempted, so the whole Node event loop — every route, every timer, the serving
lease heartbeat, the mesh rope probes — stalls for the full duration of the
fan-out. `GET /orphaned-work` had the identical shape.

### Measured, not theorised

On a live agent (Laptop, 2026-07-29, 48 registered worktrees):

| Probe | Latency |
| --- | --- |
| `GET /health`, loop idle | ~17 ms |
| `GET /health`, during one `GET /worktrees/agent-reaper` | **10.6 s** |
| `GET /worktrees/agent-reaper` itself | 10.9 s |
| `GET /health`, during one `GET /orphaned-work` | **3.7 s** |

One request, ~620× degradation, no hang and nothing pathological required.

### Why the measured number is a floor, not a ceiling

1. **Gates short-circuit cheapest-first.** 34 of the 48 worktrees stopped at the
   dirty check and never paid for the expensive `git cherry` comparison. A tidier
   agent whose worktrees are mostly clean pays the full price on all of them.
2. **The default branch was re-resolved per worktree, un-memoized.**
   `isMerged` called `resolveBaseRef()` for *every* worktree; that walks up to four
   candidate ref names probing each two ways. On an agent whose first candidate
   remote exists it is one extra spawn per worktree; on a fleet agent lacking it,
   five before one succeeds. So per-worktree cost is nearer **seven** spawns than
   the "up to three" the parent spec assumed.
3. **Two non-git commands sat on the same blocking path.** `isMerged` may consult
   `gh pr list` (30 s bound, a *network round trip*) to catch multi-commit
   squash-merges, and `isInUse` shells out to a full-system `lsof` (15 s bound).
   Both are memoized (60 s / 10 s), so each costs one call per request rather than
   one per worktree — but a **cold cache still froze the loop**, and on a busy host
   the process scan is the single most expensive call on the path. Both are
   converted here (see Design); leaving them would have meant the hazard was
   *reduced*, not removed.

### Why the existing exemption did not cover it

`agentWorktreeGit.ts` carries a `lint-allow-blocking-scan` comment justifying the
blocking scan on the grounds that the reaper "ships dark + dry-run + reviewed (off
by default), so this is not on any live agent's hot path."

That reasoning only ever covered the **background timer**. The reaper is
constructed *unconditionally* and passed into the server context regardless of the
enabled flag, so the **read route runs the full pass whether or not reaping is
armed**. Independently corroborated across two machines via
`GET /guards?scope=pool`: the same manifest key classifies as `on-dry-run` on one
machine and `on-unverified` on the other, and the live snapshot on the Laptop
returned `enabled: true, dryRun: false`.

So the exemption is not merely stale — it is a **documented safety claim that
nobody re-checked after the config diverged**, being relied upon on an agent where
the guard is armed. That is what puts this hazard in scope rather than tracked.

### Why this could not be left as prose

The shipped mitigation was documentation telling readers to poll `/guards`
instead. A reviewer correctly called that a violation of *Structure beats
Willpower*: a written instruction is not a guardrail. The parent spec also makes
this route **more authoritative**, so adoption pressure rises while the hazard
stays.

## Design

### Rejected: a cache on the existing route

Explicitly rejected, for two independent reasons:

1. It contradicts the parent spec's own freshness rule. `/guards` is deliberately
   pass-based and lags; this route answers "what do you see **right now**". Making
   its answer depend on who polled it last recreates a defect that took ten
   convergence rounds to remove.
2. **A cache cannot fix the first request** — and the first request is the one
   that froze the loop.

### Rejected: a route-level concurrency bound alone

It prevents concurrent hits from stacking, but does nothing about a single
request's ten seconds. Necessary at best, nowhere near sufficient.

### Adopted: non-blocking end to end, bounded, single-flighted

Four parts, each load-bearing:

1. **`defaultReadGitAsync`** — a non-blocking read built on
   `SafeGitExecutor.readStream`, which **already** applies the identical verb
   classification, destructive-shape refusal, SourceTreeGuard checks, environment
   scrubbing and audit-trail emission as `readSync`. **No new privilege and no new
   bypass is added to the git funnel**; only the moment the calling thread is
   released changes. Precedent: `src/core/cartographerDetect.ts` consumes the same
   primitive for the same reason (fix instar#1069).

   It resolves **only on a clean exit**. Partial stdout is discarded on every
   failure shape — non-zero exit, spawn error, or the executor's own SIGKILL
   timeout — so a truncated read can never be mistaken for a successful one. Every
   caller treats a rejection as "cannot determine", which routes to KEEP. The
   deletion-safe direction is preserved bit for bit.

2. **Bounded fan-out (`mapBounded`, `snapshotConcurrency`, default 4).** Freeing
   the loop without bounding the work would replace one freeze with a burst of
   ~150 concurrent git subprocesses on a 48-worktree agent — a different hazard, in
   the direction of the 2026-06-20 fork-bomb. The bound keeps both civil.

3. **Base ref resolved once per pass**, memoized — removing defect (2) above.

4. **Single-flight**, not a cache. Precisely: **no settled result is ever reused —
   a caller may join an already-running pass.** Nothing is retained after a pass
   settles, so the next request always starts fresh work. The honest consequence,
   which the cross-model reviewer was right to make explicit: a caller who joins an
   in-flight pass receives results from work that began marginally before its own
   request. That is bounded by one pass duration and is categorically different from
   a cache, which would serve a *completed* result to a later request. The parent
   spec's freshness rule — never serve an answer whose age depends on who polled
   last — holds.

5. **The two non-git commands are non-blocking too.** `gh pr list` and the
   full-system `lsof` now run through an async runner with the same
   clean-exit-or-reject contract, and each memo gained its own **single-flight**
   latch — without which a bounded fan-out of N evaluations racing a cold cache
   would each launch its own full-system scan (the async form of the stampede the
   memo exists to prevent).

   The `lint-allow-blocking-scan` exemption was **removed along with its
   justification**, not merely annotated. Keeping an exemption whose stated reason
   is false is how the original defect survived review, so the fix is to stop
   blocking rather than to re-word the permission. This removes ONE INSTANCE of the hazard class named in root cause #4 of
   `docs/postmortems/2026-06-07-server-temporarily-down.md`. It does NOT close that
   root cause: its two named follow-ups (OrphanProcessReaper, mcpProcessReaper) still
   use blocking process scans and are untouched here. An earlier draft claimed the
   closure outright, which was wrong. <!-- tracked: topic 37155 -->

   The `withSyncOp` in-flight marker around the `gh` call was removed with it. That
   marker existed so a *blocking* spawn would not read as a stuck event loop to the
   watchdogs — i.e. it made this freeze **invisible to the watchdog rather than
   absent**. An async spawn never stalls the loop, so there is nothing left to mask;
   removing the mask together with its cause is deliberate.

### One classification path, deliberately

Signals are typed `Awaitable<T>` and `evaluate()` awaits each. The reap timer and
the read route therefore share **one** classifier. A second async-only path would
be the obvious smaller change and is rejected: the classification that authorises
an irreversible `git worktree remove` must not be able to drift from the one the
observability route displays. Awaiting a non-promise is a no-op, so injected sync
fakes behave exactly as before.

### Injection contract preserved

Callers supplying only the blocking `readGit` (every existing unit test) must still
control what the async path reads. The deps factory **derives** the async reader
from an injected sync one rather than ignoring it. Without this, those tests
silently assert against real git instead of their fixture — a caught near-miss,
recorded here because it is the exact shape of a test that looks green and proves
nothing.

### Both routes, explicitly

The reviewer correctly noted the design read as if it covered only the reaper. It
covers both, and the two are held at parity deliberately — they had the identical
blocking shape, so they get the identical protections:

| Property | `/worktrees/agent-reaper` | `/orphaned-work` |
| --- | --- | --- |
| async handler + last-resort 500 | yes | yes |
| non-blocking git reads | yes (shared deps) | yes (shared deps — it builds on the reaper's) |
| non-blocking `lsof` / `gh` | yes | yes (same shared deps) |
| bounded fan-out | yes (`snapshotConcurrency`) | yes (bounded, not `Promise.all`) |
| base ref memoized per pass | yes | inherited (same deps instance) |
| single-flight in-flight sharing | yes | yes |
| tests | unit + integration + e2e | unit + integration + e2e |

The sentinel's single-flight was added specifically in response to this finding; the
first draft gave it bounded fan-out but not in-flight sharing, so parity was real for
the expensive part and incomplete for the stampede part.

### Request cancellation — deliberate, not overlooked

An abandoned HTTP client does **not** cancel an in-flight pass. This is a conscious
choice: no `AbortSignal` is threaded through the fan-out. The reasoning is that
single-flight already bounds the damage — repeated aborts by the same or several
clients coalesce onto **one** running pass rather than accumulating passes, so the
abandoned-client cost is capped at one pass in flight, not N. Threading cancellation
through the reads, the process scan and the network call would add a failure surface
(partial reads, half-cancelled subprocesses) to a path whose whole purpose is
delete-safety, for a bounded gain. Named as a decision rather than left silent.
<!-- tracked: topic 37155 -->

### What is still bounded only by memoization

Honest residue, stated rather than implied: total work is still unbounded in the
number of worktrees. `snapshotConcurrency` bounds *concurrency*, not the total, so an
agent with 500 worktrees performs ~1500 reads per request — politely, without
starving the loop, but the response gets slower with scale. No per-request ceiling
or pagination is introduced. This is a latency property, not an event-loop property —
but at large worktree counts latency becomes availability pressure (long-held request
slots, subprocess churn), so the alternatives are named rather than ignored:

- **Pagination / a max-worktrees-per-request cap** — rejected here because a partial
  answer to "which worktrees can be reclaimed, and why is each kept?" invites exactly
  the misreading the parent spec fought: a truncated list read as a complete one.
- **Streaming the response** — plausible, and a larger change to the route contract
  than a safety fix should carry.
- **A background pass with a generation id served on read** — this is the cache the
  parent spec's freshness rule forbids, wearing a different name.

All three are deferred as separate work, not dismissed. The measured problem was a
frozen event loop; that is fixed. Scale-shaped latency is a real but different
problem, and conflating them would have widened this change substantially.
<!-- tracked: topic 37155 -->

## Signal vs authority

This change holds **no** decision authority. It does not alter a single verdict:
the gates, their order, their fail-closed directions and the reclaim race guard are
untouched. It changes *when the calling thread is released* and *how many reads run
at once*. The two CONTROL tests exist to pin exactly that — verdicts before and
after are identical.

The one behavioural surface is the route contract: both handlers are now async and
carry a last-resort `catch` so a rejected promise becomes a 500 rather than an
unhandled rejection that could take the server down.

## Test plan

Three tiers, per the Testing Integrity Standard.

**Tier 1 — unit** (`tests/unit/agent-worktree-git-async-read.test.ts`): the async
read against real git — clean read, byte-identical to the blocking read it
replaces, multi-line porcelain intact, **rejects** on non-zero exit, **rejects
rather than resolving empty** on an invalid path (resolving `''` would read as
clean/merged and could authorise a delete). Plus `mapBounded`: order preservation,
concurrency never exceeded, empty input, limit clamping.

**Tier 2 — integration** (`tests/integration/agent-worktree-reaper-eventloop.test.ts`):
sampled event-loop drift across a real fan-out over 12 real worktrees, wired
through the **production deps factory**. Budget 250 ms.

**Tier 3 — e2e**: the existing reaper and orphaned-work lifecycle suites, which
drive the production initialisation path.

### Discrimination discipline

Every test was run against **unfixed** source first.

- The event-loop test **passed against unfixed source on its first run** — and was
  therefore worthless. Cause: `await` on a *synchronous* body resolves through the
  microtask queue, which runs before timers, so `clearInterval` fired before the
  sampler could observe the stall; a genuine multi-second freeze measured as ~0 ms.
  The cartographer precedent does not hit this because the work it measures is
  already async and its sampler runs *during* the work. One missing macrotask yield
  made the measurement structurally blind.
- Corrected, it fails against unfixed source at **758 ms against a 250 ms budget**
  (12 worktrees, with `lsof` and the network call excluded for determinism — so
  even that is an under-estimate), and passes after.
- Tests that pass either way are labelled **CONTROL** in the file, with a comment
  stating they pin the classification contract and are **not** evidence the hazard
  is gone. They are not counted as proof.

## Rollback

`snapshotConcurrency: 1` makes the fan-out fully serial (slowest, gentlest) without
reverting anything. A full back-out is a revert of the five source files; no
migration, no persisted state, no config default change, and no data to repair —
the change is confined to execution strategy.

## Decision points touched

This change touches decision points **only in how they execute**, never in what they
decide. Each is classified below.

| Decision point | Classification | Justification |
| --- | --- | --- |
| `evaluate()` reap-eligibility gates (`isInUse` → branch → `isClean` → `isMerged`) | **invariant** | Deterministic by design and must stay so: this gate authorises an irreversible `git worktree remove`. Every gate fails CLOSED to KEEP, and "any ambiguity → KEEP" is the parent spec's hard requirement. NOTE: this was NOT true of `isInUse` before this change — a failed process scan returned an empty set, indistinguishable from "nothing is using it", which CLEARED a delete gate. It now returns an explicit `unknown` and `isInUse` answers KEEP. The universal claim is true as of this change, and was not before it. No competing signals are weighed: each gate is a monotone conjunction over conservative positive-evidence sources, and any missing or failed source yields KEEP. |
| Read-failure disposition (a git read rejects → treat as "cannot determine") | **invariant** | Deliberately one-directional: unknown always resolves to KEEP. Making this a judgment call would mean sometimes deleting on an unproven read, which is the one outcome the design forbids. |
| Fan-out width (`snapshotConcurrency`) | **invariant** | A resource bound, not a behavioural decision — it cannot change any verdict, only how many reads are in flight. Operator-tunable; `1` is the gentlest setting. |
| `reclaimRaceGuard` — the TOCTOU re-check immediately before an irreversible delete | **invariant** | Same fail-closed rationale as the gates above; it exists because `info.branch` is captured at enumeration and may be stale by reclaim time. **This spec CHANGED its behaviour and an earlier draft wrongly listed it as untouched.** When the signals became awaitable the guard still read them synchronously: an un-awaited Promise is always truthy, so the in-use check refused every delete (an inert reaper) while the negated dirty/unmerged checks became vacuous — meaning a worktree that went dirty between evaluation and reclaim would have been DELETED. It now awaits every signal, and three tests driven by promise-returning fakes (the production shape) pin both directions. |
| Single-flight sharing (concurrent callers share the in-flight pass) | **invariant** | Deterministic latch on presence of an in-flight pass. No signal is weighed and no verdict is affected — the shared result is the same result each caller would have computed. |

No decision point in this change is a **judgment-candidate**: none of them weighs
competing or ambiguous signals. This is asserted rather than assumed — the failure
class judgment-candidates exist for is a static rule arbitrating between signals
that genuinely conflict, and there is no such arbitration here. If a future change
introduced one (for example, deciding *staleness* rather than reading objective
facts) that would need reclassifying.

## Frontloaded Decisions

Every decision this build required is settled here; none is parked on the user.

1. **Shape.** Non-blocking end to end + bounded fan-out + once-per-pass base ref +
   in-flight sharing. Chosen over a cache (cannot fix the first request, and breaks
   the parent spec's freshness rule) and over a concurrency bound alone (does
   nothing about a single request's ten seconds).
2. **No new funnel primitive.** Build on the existing `readStream` rather than
   adding an async read to `SafeGitExecutor`, because it already carries identical
   guard and audit semantics.
3. **One classification path**, via `Awaitable<T>`, rather than a second async-only
   route path — so delete-authorising classification cannot drift from displayed
   classification.
4. **Injected sync `readGit` derives the async reader** rather than being ignored,
   preserving the existing test injection contract.
5. **Default `snapshotConcurrency: 4`**, inline-defaulted so absent config preserves
   shipped behaviour and no config migration is required.
6. **No blocking call is left on the read path.** An earlier draft memoized
   `gh pr list` and `lsof` and deferred their conversion. The
   Standards-Conformance Gate flagged that as a No-Deferrals violation and was
   right: the event-loop test excludes both for determinism, so the test could not
   have detected the remainder, and "the read path does not block" would have been
   *nearly* true. Both are converted.
7. **Tier 3 declared** above the gate's signalled floor of 2.

## Open questions

*(none)*

## Multi-machine posture

**Posture: machine-local.**

`machine-local-justification: hardware-bound-resource`

Both routes report on worktree checkouts that physically exist on the serving
machine's own disk, and the event loop being starved is that machine's own. A
worktree is a directory on one filesystem; it cannot be read from another machine
without that machine's filesystem, so the *subject* of these routes is bound to
specific physical hardware. Nothing replicates, nothing is proxied on read, no
generated URL crosses a machine boundary, and no durable state is written.

**Why the resource is genuinely hardware-bound, distinct from the view over it.**
The Standards-Conformance Gate flagged an earlier draft for defending machine-local
with *scope control* rather than a concrete impossibility. That objection was
correct about the draft's reasoning, and the corrected argument separates two things
the draft conflated:

- **The resource is hardware-bound and cannot be unified.** A worktree is a
  directory on one physical filesystem. Reading it requires that machine; there is no
  representation of another machine's worktree that this machine could serve. The
  same is true of both signals the routes depend on — the running-process table and
  the on-disk locks are properties of one kernel and one disk. This is the
  `hardware-bound-resource` key in its literal sense, not a convenience label.
- **A pool-scoped *view* over those local resources is feasible, and is a separate
  feature.** `GET /guards?scope=pool` demonstrates the pattern: each machine reads
  its own local state and a fronting machine merges the answers. Such a view would
  not make any worktree non-local — it aggregates per-machine local reads, and it
  brings its own obligations (peer fan-out, dark-peer tolerance, staleness tagging).

So `unified` is **infeasible for the resource** and **feasible for a view that does
not yet exist**. This spec introduces no view and does not change the routes' scope;
it changes execution strategy only. A reviewer may still argue the routes *should*
grow a pool-scoped mode — that is a real position, and it is a separate spec rather
than a silent assumption here. <!-- tracked: topic 37155 -->

The cross-machine relevance runs in the opposite direction and is the point of the
fix: a frozen loop stalls *this* machine's serving-lease heartbeat and rope probes,
which is exactly how a purely local blocking read presents as mesh instability.
Corroborated across both machines via `GET /guards?scope=pool`, which reports
divergent classifications for the same manifest key.
