# Side-effects review — census-tracker-ref-kinds

**Change:** pending census tracker refs are typed by KIND; the 49 enrolment-backlog
entries move from a machine-local evolution-action id (`ACT-1193`) to a
fleet-stable key resolved against a shipped source constant
(`backlog:decision-quality-enrolment` → `BACKLOG_TRACKERS`).

**Spec:** `docs/specs/census-tracker-ref-kinds.md` (converged, 2 rounds)

---

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

**One, deliberately, at build time.** The format ratchet accepts exactly two ref
kinds and additionally resolves every `backlog:` key against the registry. A
census entry pointing at an unregistered key now fails CI rather than shipping.

That is the intent — a dangling ref is the whole defect — but it is a real new
way to redden a build, and the failure message names the entry and the missing
key so the fix is mechanical.

**Nothing at runtime.** The adjudicator's `ACT-<n>` path is behaviourally
identical, with one exception that strictly *widens* what is accepted: a null
(unreadable/absent) queue now yields `unverifiable` instead of the callsite
skipping adjudication silently. No input that previously produced a verdict
produces a different one.

## 2. Under-block — what failure modes does this still miss?

- **A registered key whose work is abandoned.** The check proves the tracker
  *resolves*, never that anyone is doing the work. Round-2 review named this;
  it is mitigated (a required `closureCondition`, and CI forbidding orphaned
  keys) but not solved — a human still has to read the registry and notice a key
  that should have been retired. Honest framing: this makes the debt *legible*,
  not *worked*.
- **The 49 are still not enrolled.** This change makes the counter meaningful; it
  enrols nothing. The backlog is unchanged at 49 by design, and the graduation
  criterion asserts that explicitly so "progress" cannot be faked by shrinking it.
- **A second backlog added carelessly.** CI pins the current distribution to one
  key, so a second key is a deliberate, reviewed act — but nothing judges whether
  the second backlog is a *good* division of the work.

## 3. Level-of-abstraction fit

Right layer, and it moved *down* during review. The first design put resolution
in the route (an injected `specExists` predicate over the filesystem); the final
one puts it in a pure function over a constant imported directly. Fewer seams,
no I/O, and `unverifiable` becomes unreachable for the new kind by construction
rather than by care.

The one deliberate cross-layer touch: `liveActs` became nullable so the *route*
no longer decides whether adjudication is possible. That decision belongs with
the kinds, which live in the adjudicator.

## 4. Signal vs authority compliance

`docs/signal-vs-authority.md`. Both decision points are `invariant`, argued in
the spec:

- **The adjudicator** holds no authority over agent behaviour. It computes a
  verdict for a read-only observability counter — it gates nothing, blocks
  nothing, and no code path branches on its output.
- **The format ratchet** is a closed-world format check over a two-member enum
  at a dev-process chokepoint — the documented exemption class ("the cost of a
  false pass is catastrophic and the cost of a false block is merely 'try again
  with the right arguments'"). Here even that overstates it: a false block is a
  named CI failure with the offending entry printed.

No brittle matcher gains blocking authority over a runtime path.

## 5. Interactions

- **The 2026-07-23 high-water fix** — preserved exactly, and the spec argues why
  it must be (this change is its second half, not its replacement). The ACT path
  keeps `unverifiable`-not-`dead` for a peer-minted id, and the new null-queue
  case extends the same principle rather than contradicting it.
- **The pending shrink-only ratchet** — identity-pinned, so repointing all 49
  changes 49 baseline lines. That is the designed "reviewed baseline change"
  behaviour, not a bypass: the diff is large and legible on purpose.
- **`GET /decision-quality?scope=pool`** — unaffected. `censusDebt` is built at a
  single local callsite and is not among the pool-merged fields (verified in
  source while adjudicating the mixed-version finding), so no peer's raw ref
  reaches another machine's adjudicator.
- **No shadowing or double-fire.** One adjudicator, one callsite, one loop.

## 6. External surfaces

- `GET /decision-quality` → `censusDebt` — **field shapes unchanged**; the
  `pendingRefUnverifiable` array simply becomes empty where it was 49 entries.
  No consumer sees a new or renamed field.
- No new route, config key, flag, env var, or CLI surface.
- No user-visible behaviour on any agent. This is instrumentation.
- **Timing/state dependence:** removed, not added. The new kind's verdict depends
  on nothing outside the shipped artifact — no clock, no queue, no filesystem,
  no network.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Unified**, and that is the entire point of the change.

- `BACKLOG_TRACKERS` — unified by construction: a source constant in `src/data/`
  (published in `package.json` `files[]`, compiled into `dist/`). There is no
  per-machine copy that can diverge.
- `adjudicatePendingTracker` — unified. Reads machine-local state *only* for the
  `ACT-<n>` kind, which is machine-local by design and already guarded.
- The evolution action queue stays **machine-local BY DESIGN**
  (`machine-local-justification: operator-ratified-exception`, citing the
  2026-07-23 high-water adjudication already in `src/server/routes.ts`).
  Inherited, not introduced — this change stops *depending* on that locality for
  a fleet-wide tracker rather than attempting to change it.
- No notices, no durable state, no generated URLs — nothing to strand on a topic
  transfer or to break across a machine boundary.

## 8. Rollback cost

**Revert the commit.** No flag, because there is no weakened state to return to;
no migration, because no durable state is written; no agent-state repair.

Stated plainly because the spec's first draft got it wrong: *before* a revert, a
`backlog:` ref pointing at an unregistered key reports **`dead`**, not
`unverifiable` — a loud false deletion rather than a quiet unknown. Two things
bound that: CI resolves every `backlog:` ref against the registry, so a dangling
key cannot reach a release; and reverting restores today's `unverifiable`.

## Second-pass review

**Not required** by the Phase-5 trigger list: no block/allow decision on
messaging or dispatch, no session lifecycle, no compaction path, no coherence
gate, trust level, or idempotency check, and nothing named sentinel/guard/gate/
watchdog. The change is a read-only observability counter plus a CI ratchet.

Substituting for it, and arguably stronger: the spec went through **two rounds of
external cross-model review**, the first of which returned SERIOUS ISSUES and
inverted the design (see the convergence report). The reviewer proved the
original anchor would have produced 49 fleet-wide false deletions — a defect no
internal pass caught.

---

## Addendum — an unrelated flake this change's own full-suite run surfaced

Running the full unit suite against this branch produced one failure:
`tests/unit/builtin-manifest.test.ts > is up-to-date with current source`. It
passed in isolation, so it is not caused by this change — but the Zero-Failure
Standard makes it mine on sight, so it is fixed in the same PR rather than
re-run away.

**The defect.** That test verified the committed manifest was current by
*regenerating over it* and diffing the file before/after — a verifier that
mutates the artifact it verifies. `tests/unit/package-completeness.test.ts` runs
a full `npx tsc` build which (per its own comment) regenerates the same
`src/data/builtin-manifest.json`. Under the parallel suite the two race, so a
perfectly good tree goes red at random.

**The fix.** `scripts/generate-builtin-manifest.cjs` honours an optional
`INSTAR_BUILTIN_MANIFEST_OUT` override (default path unchanged); the test
generates to a temp dir and diffs against the committed file, touching nothing
shared. The check is now read-only and order-independent, and its failure
message says how to fix a genuinely stale manifest.

**Side effects of the fix:** none beyond the test. The override is opt-in and
unset everywhere except this test, so the build and `prepublishOnly` paths are
byte-identical. No runtime code, no shipped surface.

This is the ninth instance in this run of the same shape — a check reporting a
result it did not actually establish. Here it reported failure it hadn't earned,
which is the less dangerous direction but the same root cause.
