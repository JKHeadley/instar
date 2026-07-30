# Side-effects review — worktree read-path event-loop safety

**Spec:** `docs/specs/worktree-read-path-eventloop-safety.md`
**Declared tier:** 3 (gate signalled `suggestedTier=2`, `riskFloor=2` — declared **above** the floor, not below)
**Files:** `src/monitoring/AgentWorktreeReaper.ts`, `src/monitoring/agentWorktreeGit.ts`,
`src/monitoring/OrphanedWorkSentinel.ts`, `src/monitoring/orphanedWorkGit.ts`, `src/server/routes.ts`
(+ 3 new test files, 3 migrated test files)
**Test status:** 97 tests green across 10 files — unit, integration and e2e.
**Review status:** six internal reviewers + the conformance gate + one external family
have all reported. Their blocking findings are fixed; see the Review record below.

---

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

**No new rejection is introduced at the classifier.** Not one gate, gate order, or
fail-closed direction changed; the two CONTROL tests pin identical verdicts before
and after.

One genuine over-block risk exists and is deliberate. `defaultReadGitAsync` resolves
**only** on a clean exit, so a read that previously "succeeded" with partial output
under an edge case now rejects. Rejection routes to KEEP, i.e. the safe direction —
it can cause a worktree to be *retained* that might have been reclaimable, never the
reverse. Retaining a reclaimable worktree costs disk; deleting an unreclaimable one
costs work. This trade is intentional.

Second, narrower: `readStream` refuses destructive verbs/shapes. Every call here is a
genuine read (`worktree list`, `status`, `rev-parse`, `cherry`), all already
permitted by the identical classifier `readSync` uses. A future contributor adding a
non-read verb to this path gets a hard refusal rather than silent execution — correct.

## 2. Under-block — what failure modes does this still miss?

Named honestly; none is a regression, all pre-exist:

- **RESOLVED after review.** An earlier draft left `gh pr list` and `lsof`
  synchronous-but-memoized and tracked their conversion. The Standards-Conformance
  Gate flagged that as a No-Deferrals violation and was right: the event-loop test
  excludes both for determinism, so no test could have caught the remainder, and the
  claim "the read path does not block" would have been merely nearly true. Both are
  now non-blocking, each memo gained its own single-flight latch, and the
  `lint-allow-blocking-scan` exemption was deleted along with its false
  justification. The `withSyncOp` marker went with it — it existed to hide a
  blocking spawn from the watchdogs, i.e. to make this freeze invisible rather than
  absent.
- **Request cancellation is not threaded.** An abandoned client does not cancel an
  in-flight pass. Bounded by single-flight to one running pass rather than N; named
  as a decision in the spec. <!-- tracked: topic 37155 -->
- **`currentBranch` and `hasActiveBuildMarker` remain synchronous.** Both are on the
  *reclaim* path, not the read path, and are single cheap calls — but they are
  blocking, and `reap()` is now async around them. The wiring-integrity test asserts
  zero blocking reads on the READ path specifically, so this residue is scoped and
  visible rather than assumed away. <!-- tracked: topic 37155 -->
- **Unbounded total work.** `snapshotConcurrency` bounds concurrency, not the total.
  An agent with 500 worktrees still performs ~1500 reads per request, just politely,
  without starving the loop. Pagination, streaming and a background-pass-with-
  generation-id were each considered and are named in the spec with reasons for
  deferral. This is a latency property, not an event-loop property.
  <!-- tracked: topic 37155 -->

## 3. Level-of-abstraction fit

Right layer, and deliberately not lower. The obvious alternative — extend
`SafeGitExecutor` with a new async primitive — was **avoided** once `readStream` was
found to already exist there with identical guard semantics. So the safety
checkpoint is untouched and this change sits entirely in its consumers.

Not higher either: an Express-level timeout or a worker thread would mask the
symptom while leaving a synchronous fan-out inside a status handler. The cartographer
precedent (instar#1069) used a worker because it parses a large index in-process;
here the cost is subprocess spawns, which async I/O addresses directly without a
worker's setup cost per request.

`mapBounded` is a local 15-line helper rather than a dependency, and is co-located
with its only two consumers.

## 4. Signal vs authority compliance

**Compliant — but an earlier version of this answer was FALSE and is corrected here.**
Reference: `docs/signal-vs-authority.md`.

The reaper is an authority (it deletes). This change does not touch that authority's
DECISION LOGIC — the gate set, their order, the blast-radius cap and the per-path
failure breaker are unchanged. But the earlier claim that it "does not alter a single
verdict" and that "the reclaim race guard is untouched" was wrong on two counts, both
found by review and both now fixed:

1. **`reclaimRaceGuard` changed behaviour**, because its inputs changed type and it was
   not updated. Reading an un-awaited Promise in a boolean test made the in-use check
   refuse every delete and made the dirty/unmerged re-checks vacuous — the latter being
   a path where a worktree that went dirty between evaluation and reclaim would have
   been deleted. Fixed; pinned by tests driven with promise-returning signals.
2. **`isInUse` did not fail closed.** A failed process scan returned an empty set,
   which reads as "nothing is using this worktree" and clears a delete gate. That is a
   success-shaped rejection on a delete-authorising signal. It now returns an explicit
   `unknown` and the answer is KEEP.

The honest statement is therefore: this change alters execution strategy and, in two
places, RESTORES a fail-closed property the code did not actually have. It adds no new
authority.

The structural decision that IS about authority: signals are `Awaitable<T>` and
`evaluate()` awaits them, so the reap timer and the read route share ONE classifier. A
separate async-only route path was rejected precisely because the classification
authorising an irreversible delete must not drift from the one displayed.

The one structural decision that *is* about authority: signals are `Awaitable<T>` and
`evaluate()` awaits them, so the reap timer and the read route share **one**
classifier. A separate async-only route path would have been simpler and was
rejected precisely because the classification authorising an irreversible delete must
not be able to drift from the one displayed for observability.

## 5. Interactions

- **Shared deps between two consumers.** `makeOrphanedWorkSentinelDeps` builds on
  `makeAgentWorktreeReaperDeps`, so converting one forced the other. Both are
  converted; typecheck confirms no third consumer exists.
- **Caught near-miss — injection contract.** Tests inject a sync `readGit` to control
  `isClean`. After the conversion that injection no longer reached the async path, so
  those tests would have silently asserted against **real git** instead of their
  fixture. The factory now derives the async reader from an injected sync one. This is
  the highest-value finding in this review: an existing green test that had quietly
  stopped testing anything.
- **Single-flight vs the reap timer.** They share `evaluate()` but not the
  single-flight latch (`pendingSnapshot` guards `snapshot()` only; `reap()` keeps its
  own `running` flag). A snapshot and a reap pass can therefore run concurrently, as
  before. Both are read-only up to the reclaim step, and the reclaim step is
  unchanged and still race-guarded.
- **No double-fire, no shadowing.** No new timer, listener or scheduled work.
- **`withSyncOp` marker REMOVED from this path.** It previously wrapped the `gh`
  call so a blocking spawn would not read as a stuck event loop to the watchdogs —
  i.e. it made this freeze *invisible* rather than absent. With the spawn now async
  there is nothing to mask, so the marker went with its cause. Worth flagging as an
  interaction: any watchdog tuned on seeing in-flight-sync markers from this path
  will now see none, which is correct rather than a signal loss.

## 6. External surfaces

- **Route contract.** Both handlers are async. Response bodies are byte-identical;
  status codes gain a last-resort `500` so a rejected promise can never become an
  unhandled rejection that takes the server down. `503`-when-unwired is unchanged.
- **Latency profile changes shape.** A bounded fan-out (default 4) is wall-clock
  slower than an unbounded one would be, but the route was never fast — and the whole
  server is no longer hostage to it. `snapshotConcurrency: 1` is the gentlest setting.
- **New config key** `snapshotConcurrency` with an inline default of 4. Absent config
  preserves shipped behaviour, so no `migrateConfig` entry is required.
- **No timing or conversation-state dependence**; no user-visible messaging; no
  dashboard surface change.
- **Agent Awareness:** no CLAUDE.md template change proposed. The route, its purpose
  and its triggers are already documented; nothing an agent should newly *do* was
  added — this is a correctness fix behind an existing documented surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local.** `machine-local-justification: hardware-bound-resource`.
Both routes report on worktree checkouts that physically exist on the serving
machine's own disk, and the starved event loop is that machine's own. Nothing
replicates, nothing is proxied on read, no durable state is written, no generated URL
crosses a machine boundary, and there is no notice requiring one-voice gating.

The conformance gate flagged an earlier draft here for defending locality with *scope
control* instead of a real impossibility. The corrected argument separates the
**resource** (a directory on one filesystem, plus a process table and on-disk locks
from one kernel — genuinely not unifiable) from a **pool-scoped view over those local
reads** (feasible, the `/guards?scope=pool` pattern, and a separate feature this spec
does not introduce). A reviewer may legitimately argue the routes should grow such a
view; that is a different spec.

The cross-machine consequence runs the other way and is the point: a frozen loop
stalls this machine's serving-lease heartbeat and rope probes, so a purely local
blocking read presents as mesh instability. Fixing it locally removes a
mesh-visible failure mode. Corroborated across both machines via
`GET /guards?scope=pool`, which reports divergent classifications for the same
manifest key — evidence the exemption comment was being relied on where the guard is
armed.

## 8. Rollback cost

**Low.** `snapshotConcurrency: 1` serialises the fan-out with no code change. A full
back-out is a revert of five source files. No migration, no persisted state, no
config default that must be unwound, no agent-state repair, and no data to fix — the
change is confined to execution strategy. The test migrations revert with it.

---

## Review record

**Standards-Conformance Gate (code-backed, reads the living constitution).**
Round 1: 82 standards checked, **2 possible violations** — (a) *No Deferrals*, for
leaving the `gh`/`lsof` conversion tracked-but-undone while claiming read-path
event-loop safety; (b) *An Instar Agent Is Always a Multi-Machine Entity*, for
defending machine-local with scope control rather than a concrete impossibility.
**Both accepted.** (a) was fixed in code; (b) was rewritten to separate the
hardware-bound *resource* from a feasible-but-nonexistent pool-scoped *view*.
Round 2 (after both fixes): **0 findings**, fit verdict `fit`.

**Cross-model external review — `codex-cli:gpt-5.5`, verdict MINOR ISSUES.**
Five findings, all folded:
1. *Injection-contract escape hatch* (design) — the sync-derived async reader means a
   future production wiring could reintroduce blocking behind an `await`. **Fixed
   structurally**: a new wiring-integrity suite asserts production deps make **zero**
   `readSync` calls across `listWorktrees` / `isClean` / `isMerged` and a full
   snapshot pass, and documents the shim as test-only.
2. *Route coverage* (design) — parity between the two routes was not demonstrated.
   **Real gap found**: the sentinel had bounded fan-out but **not** single-flight.
   Added, plus an explicit per-route parity table.
3. *Cancellation* (design) — abandoned clients leave the pass running. Now a named
   decision with its rationale rather than an omission.
4. *Scalability alternatives* (precision) — pagination / streaming / background-pass
   alternatives now named with reasons for deferral.
5. *"Single-flight, not a cache"* (precision) — tightened to "no settled result is
   reused; a caller may join an already-running pass," including the honest
   consequence.

**Second external family — `gemini-cli:gemini-3.1-pro-preview`: ATTEMPTED, DEGRADED
(timeout).** Detected as available and invoked; the call timed out and returned no
findings. Recorded as a degraded per-round result, not a clean pass and not a skip.
(Consistent with this framework's behaviour on other recent specs in this repo, where
it timed out across rounds 6-9.) Because the codex family succeeded, the aggregate
external posture is a genuine RAN — but only ONE of two available families actually
produced an opinion, which is less assurance than two.

**Six internal reviewers (security, scalability, adversarial, integration,
decision-completeness, lessons-aware): REPORTED.** Roughly thirty findings. Two were
CRITICAL and both falsified the author's central claim:
- `reclaimRaceGuard` reading awaitable signals in boolean context (inert reaper in one
  configuration; **deleting a dirtied worktree** in a nearby one). Found independently
  by four reviewers, two of which proved it by executing the code rather than reading
  it. FIXED + discriminating tests added.
- `/orphaned-work` still fully blocking, because its deps builder defaulted its own
  reader and passed the defaulted one down, so the compatibility shim always took its
  sync branch. Found independently by five reviewers. FIXED, plus two reads on that
  route that had never been converted at all.

Also fixed: the dropped output bound (a truncated `status` reads as CLEAN), missing
stream-error handling (a partial read exiting 0 read as complete), `isInUse` failing
open toward deletion, the third memo missing its single-flight latch, a cached null
base ref pinning the whole agent to "unmerged", detached fan-out workers after a
rejection, a NaN concurrency silently producing an empty answer, and a rollback lever
that reached only one of the two routes.

**Independent second-pass review (Phase 5): OUTSTANDING.** Required because this change
touches a reaper. Owned by the peer agent (topic 37155), who accepted it. Deliberately
NOT self-signed. **This artifact is incomplete until that concurrence is recorded
here.**

**The lesson worth carrying out of this review** (recorded because it generalises): every
one of the critical findings had the same shape — an interface was widened to allow
promises, and its consumers were never audited for it. TypeScript permits truthiness on
`boolean | Promise<boolean>`, this repo has no lint that rejects it, and every existing
test injected synchronous fakes so production's shape never appeared in the suite. The
defect class is not specific to this change.
