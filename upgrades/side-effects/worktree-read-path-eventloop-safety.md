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

Right layer — and round three moved it DOWN one, deliberately, against my earlier
answer here. This section previously said extending `SafeGitExecutor` with a new
async primitive was **avoided** because `readStream` already existed "with identical
guard semantics". The guard semantics were identical; the AUDIT semantics were not.
`readStream` hands back a live child, so the funnel records `allowed` at spawn and
never sees how the read ended — a failed read that gates an irreversible delete was
recorded as allowed with no failure row, while the blocking path records
`denied: subprocess-error`.

So the change now DOES add a primitive to the safety checkpoint: `readAsync`, the
async twin of `readSync`, with the classification/guard/env preamble extracted and
shared by all three read entry points so they cannot drift. That is a larger
footprint in the funnel than this section originally claimed, and it is the reason
the declared risk tier is right. The alternative was keeping a spec claim that was
false on the delete path, in the same branch that filed a finding about an armed
deleter leaving no record of what it deleted.

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
- **Single-flight vs the reap timer — READ §4 FIRST.** They share `evaluate()` but not
  the single-flight latch (`pendingSnapshot` guards `snapshot()` only; `reap()` keeps
  its own `running` flag), so a snapshot and a reap pass can run concurrently.
  **Correction to an earlier version of this bullet, which said the reclaim step was
  "unchanged and still race-guarded":** that was reassurance, and it was wrong. The
  reclaim guard's BEHAVIOUR changed (§4 finding 1) — it read awaitable signals in
  boolean context, which made two of its three re-checks vacuous. It is fixed and
  pinned by tests, but a reviewer checking concurrency safety must not read this bullet
  as "nothing changed here".
  A second, genuinely new interleaving: `snapshot()` now yields between gates while
  `reap()` can call the blocking `removeWorktree`. An in-flight `isClean` against a path
  the reaper just removed rejects → KEEP → the route can report a *deleted* worktree as
  `keep / uncommitted-changes`. Harmless for delete-safety (it errs toward keeping) but
  it IS a verdict produced by the execution change, so the blanket "no verdict changed"
  claim does not survive here either. <!-- tracked: topic 37155 -->
- **No double-fire, no shadowing.** No new timer and no new scheduled work. There IS
  one new listener — a permanent constructor-level `error` listener on the reaper,
  added in round four because emitting `error` with none was killing the process. It
  RECORDS to a bounded ring rather than swallowing, and a consumer attaching its own
  listener still receives everything. An earlier version of this line said "no new
  listener" and survived the change that added one.
- **`withSyncOp` marker REMOVED from this path.** It previously wrapped the `gh`
  call so a blocking spawn would not read as a stuck event loop to the watchdogs —
  i.e. it made this freeze *invisible* rather than absent. With the spawn now async
  there is nothing to mask, so the marker went with its cause. Worth flagging as an
  interaction: any watchdog tuned on seeing in-flight-sync markers from this path
  will now see none, which is correct rather than a signal loss.

## 6. External surfaces

- **Route contract.** Both handlers are async, and status codes gain a last-resort
  `500` so a rejected promise can never become an unhandled rejection that takes the
  server down. `503`-when-unwired is unchanged.

  **Response bodies are NO LONGER byte-identical** — corrected in round five, which
  found that sentence still standing. The reaper's read gained `enumerationFailed`
  and `recentErrors`; the sentinel's gained `undeterminedCount` and
  `enumerationFailed`. All are ADDITIVE and no consumer asserts whole-body equality
  (checked: no schema, no contract test, no snapshot test), so nothing breaks — but
  "byte-identical" was this artifact's only claim about the external contract, and it
  was wrong. `recentErrors` carries error MESSAGES; every command on this path is
  local (`worktree list`, `status`, `rev-parse`, `cherry`, `worktree remove`), so no
  remote URL and therefore no embedded-credential class exists. Git's
  `worktree remove` stderr can name files INSIDE a worktree whose absolute path is
  already in the same Bearer-authed body — an incremental widening, stated rather
  than scrubbed.
- **Latency profile changes shape.** A bounded fan-out (default 4) is wall-clock
  slower than an unbounded one would be, but the route was never fast — and the whole
  server is no longer hostage to it. `snapshotConcurrency: 1` is the gentlest setting.
- **New config key** `snapshotConcurrency` with an inline default of 4. Absent config
  preserves shipped behaviour, so no `migrateConfig` entry is required.
- **No timing or conversation-state dependence**; no user-visible messaging; no
  dashboard surface change.
- **Agent Awareness — CORRECTED after independent review.** An earlier version said no
  CLAUDE.md template change was needed. That was right about the ROUTE and wrong about
  the KNOB, and it contradicted §8: §8 rates rollback LOW *because* `snapshotConcurrency`
  exists, while §6 left that key undocumented on every agent-facing surface. A lever
  nothing surfaces is not a lever anyone finds under pressure — the two sections could
  not both stand.
  Resolved in favour of documenting it: `snapshotConcurrency` is declared in the config
  type alongside its siblings, and a `PostUpdateMigrator` CLAUDE.md addendum bullet
  carries it to already-deployed agents (the same treatment `initialPassDelayMs` and
  `githubMergeCheck` received — both inline-defaulted and behaviour-preserving-when-
  absent, and both still got a bullet, for exactly this reason). Tuning the fan-out
  when that route is slow IS something an agent should newly do.
  No `migrateConfig` entry is required: the key is inline-defaulted, so its absence
  yields the shipped behaviour and writing `4` into every agent's config would freeze
  today's default.

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

**Low, and the lever is now discoverable** (it was not when this section was first
written — see §6). `snapshotConcurrency: 1` serialises the fan-out with no code change,
on BOTH routes: the sentinel's width was a hardcoded 4 until review caught it, and it
now reads the same key. A full back-out is NOT a plain revert, and this paragraph previously said it was —
making it the FOURTH disagreeing description across three documents. **The
authoritative list is the four numbered steps in the spec's Rollback section**, and
it is deliberately not restated here so the two cannot drift apart again. Its
load-bearing points: the new lint must come out of THREE places in `package.json`
plus the `REQUIRED_LINTS` ratchet, or the documented back-out leaves the suite RED;
the frozen chokepoint baseline key must be re-ADDED, against that file's
may-only-shrink contract; and the note this change writes into already-deployed
agents STAYS, because a source revert cannot un-write it — so "no migration, no
persisted state" was false, as §6 of this same artifact already said. The unrelated
test fixes kept green under the Zero-Failure Standard should NOT be reverted with it.

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

**Independent second-pass review (Phase 5): COMPLETE — CONCUR, with three findings, none
blocking.** Performed by the peer agent from a different machine (topic 37155, posted on
PR #1757). Not self-signed.

The reviewer independently verified two load-bearing claims against source rather than
accepting them, and both held: that `SafeGitExecutor.readStream` genuinely pre-exists
carrying the same destructive-verb and destructive-shape denials, and that the false
exemption was real and shipped — the comment asserting "ships dark + dry-run + reviewed" sat on a guard
that is armed on this machine.

**The reviewer's follow-up question, answered with the measurement rather than a
recollection.** They asked whether the existing `SafeGitExecutor` suite ran
UNCHANGED against the de-duplicated read preamble — the point being that if any of
it needed editing, that is the most important line in the change.

It ran unchanged. The diff against the branch base is **110 insertions and zero
deletions or modifications**: the 31 pre-existing tests (execSync source-tree
guard, readSync classification and bypass, readStream refusal and timeout) are
byte-identical, and the 5 additions are the new `readAsync` block. All 36 pass.

That is the evidence that extracting `prepareReadOnlySpawn` preserved the admission
decision rather than merely appearing to: the tests that pin destructive-verb
refusal, destructive-shape refusal, the `-C <dir>` target extraction, the
source-tree guard and the sourceTreeReadOk bypass were not touched and did not need
to be. Had any required editing, the refactor would have changed what the funnel
ADMITS, not just where the code lives — which is the one outcome that would make
this change unsafe.

**Round four: NOT converged, and the reason is worth stating precisely.** Six
internal reviewers plus the external pass produced roughly forty findings, about a
dozen design-class. The severe ones were all introduced by round three's own fixes:

1. **The pass ceiling could terminate the process.** It reports through an event
   channel with no listener in production — verified across the source tree AND the
   deployed build. In this runtime that throws, the drivers do not await, and the
   unhandled rejection meets a fatal policy. A fix for a hung guard became a crashed
   server. Closed by recording errors on a bounded ring surfaced on the read route,
   so the emission is structurally safe AND observable rather than swallowed.
2. **The sibling route had none of the ceilings** while the parity table claimed
   identical protections — and had no row for the ceiling, so the one dimension
   where parity failed was the one it did not mention. All five internal reviewers
   found it. Closed.
3. **The new lint was keyed on a type-alias SPELLING**, so the sibling module —
   widened by this same change using an inline union — was skipped entirely.
   Re-keyed on the shape; verified by reintroducing the defect there.
4. **Two of the seven round-three fixes were pinned by nothing**, while this
   artifact's discrimination section said "each fix reverted and re-run". Both now
   have tests verified to fail when the fix is removed.
5. **The stated reason for deleting a round-three test was wrong.** It was recorded
   as un-reproducible under the test runner; the adversarial reviewer rebuilt it and
   showed it reproduces exactly. The real defect was its own loose assertion. That
   misdiagnosis had been written in as durable methodology, which would have told
   the next person that writable coverage could not be written.

A process failure of the author's also belongs here: the code-executing reviewer ran
concurrently with five read-only ones on one tree, and three of them reported the
tree mutating under them. Separately, a shell working-directory change made for an
unrelated purpose silently rescoped a sequence of recovery commands onto a different
checkout — no work was lost, but ten files in that checkout were overwritten and had
to be restored. Both are the same shape as the defects under review: a measurement
taken through a changed environment, attributed to the thing being measured.

**Scope limit on that review, stated because it is a gate item.** It was performed
against the branch as it stood before round three. Its verification that the safety
checkpoint was left untouched no longer describes the current code: round three adds
`readAsync` to `SafeGitExecutor`. The reviewer's three findings are fixed and its
concurrence stands for what it read; it is NOT a review of the funnel change, and
nothing here should be read as though it were.

Its three findings, all now fixed in this artifact:
1. **§6 and §8 contradicted each other.** §8 rated rollback LOW *because*
   `snapshotConcurrency` exists, while §6 proposed no agent-facing documentation for it —
   so the entire rollback lever was an undocumented config key. "A lever nothing surfaces
   is not a lever anyone finds under pressure." Resolved by documenting it (config type +
   a `PostUpdateMigrator` CLAUDE.md addendum), not by weakening §8. Acting on this also
   exposed that the two routes read *different* keys, so the "one lever, both routes"
   claim was false until the sentinel was wired to inherit the reaper's.
2. **§4 carried the same paragraph twice, reworded** — a corrected paragraph added
   without removing the one it replaced. Worse in the authority section than elsewhere,
   because a reader cannot tell whether it describes one decision or two. Duplicate
   removed.
3. **§5 read as reassurance where §4 read as caveat.** §5 said the reclaim step was
   "unchanged and still race-guarded" while §4 said its behaviour changed. §5 is where a
   reviewer checks concurrency safety, so it now carries the correction and points at §4.

The reviewer deliberately did NOT re-run the adversarial pass on the central claim or the
foundation question, on the grounds that duplicating passes the author had already
directed produces agreement rather than independence. That is recorded as a scope choice,
not an omission.

**Convergence is still owed a genuinely quiet round; this review does not substitute for
one.** The round that produced these fixes contained many design-class findings, and the
rule is two consecutive rounds without them. The convergence tag is NOT written.

**The lesson worth carrying out of this review** (recorded because it generalises): every
one of the critical findings had the same shape — an interface was widened to allow
promises, and its consumers were never audited for it. TypeScript permits truthiness on
`boolean | Promise<boolean>`, this repo has no lint that rejects it, and every existing
test injected synchronous fakes so production's shape never appeared in the suite. The
defect class is not specific to this change.
