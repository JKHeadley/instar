# Side-Effects Review — Pre-push smoke tier (changed-files only)

**Version / slug:** `pre-push-smoke-tier`
**Date:** `2026-04-19`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

`.husky/pre-push` now runs `npm run test:smoke` (new script:
`vitest run --config vitest.push.config.ts --changed origin/main`) instead of
`npm run test:push`. The new script executes the same excluded/included set
and same `fileParallelism: false` isolation — the only difference is that
vitest's `--changed origin/main` filter restricts the run to tests whose
files (or transitive imports) are in the diff vs. origin/main. The
pre-push gate (`scripts/pre-push-gate.js` — NEXT.md / version / side-effects
artifact / contract-evidence / source-without-tests checks) runs first,
unchanged. Two escape hatches: `INSTAR_PRE_PUSH_FULL=1` (run full push
suite locally) and `INSTAR_PRE_PUSH_SKIP=1` (skip tests entirely; CI is
the only gate). Full suite continues to run in CI across 8 sharded
runners on every PR; CI remains the authority for merge.

Files touched:

- `package.json` — adds `test:smoke` script; bumps version 0.28.59 → 0.28.60.
- `.husky/pre-push` — switches to `test:smoke` by default, adds env-var
  escape hatches, keeps the 2-attempt retry loop and the pre-push gate
  exactly as before.
- `upgrades/NEXT.md` — upgrade guide (new file at release time).
- `upgrades/side-effects/pre-push-smoke-tier.md` — this review.

## Decision-point inventory

- `.husky/pre-push` — **modify** — chooses which test script runs based on
  env vars and falls back to smoke tier by default.
- `package.json scripts.test:smoke` — **add** — new script, thin wrapper
  over existing push config with `--changed origin/main`.

No runtime / agent-behavior decision points touched. Strictly contributor-side
git hook behavior.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

On the runtime / message surface: no block/allow change. The pre-push gate
is a contributor-side hook, not a runtime gate, so over-block doesn't apply
in the agent-behavior sense.

On the contributor surface: the smoke tier runs *fewer* tests than the full
push suite, so it will **accept pushes that the full suite would have
rejected** — the opposite of over-blocking. See Under-block below.

There is one narrow over-block possibility: if `origin/main` is stale (user
hasn't fetched recently), the `--changed` diff may include files that are
already merged, running more tests than strictly needed. We mitigate with
`git fetch --quiet origin main` inside the hook. If the fetch fails (offline
push), the diff falls back to whatever the local `origin/main` ref points
at — worst case runs a few extra tests, still fast.

---

## 2. Under-block

**What failure modes does this still miss?**

This is the real surface to review. Moving from "full suite" to "tests
affected by changed files" trades thoroughness for speed. Specifically:

1. **Regression in unchanged code** — if your change to file A breaks
   file B via some runtime-only coupling that vitest's module graph
   doesn't see (e.g., a serialization format that both sides implement
   independently), the smoke tier will miss it. CI's full suite on PR
   will catch it before merge. Net risk: the contributor experiences
   "passed locally, failed in CI" more often. Cost: one extra CI round
   trip. Benefit: ~9 minutes saved per push across all pushes that don't
   break anything (i.e., the vast majority).

2. **Config/global-state files** — if a change touches a file imported by
   most tests (e.g., a vitest global setup, a shared fixture builder),
   `--changed` will correctly include the full test set. No extra risk
   here; the mechanism is self-balancing.

3. **No-change pushes** — pure doc or comment changes produce 0 tests,
   which is correct. The pre-push gate still enforces NEXT.md presence
   and side-effects artifact presence independently, so doc pushes that
   claim a fix/feature still require the corresponding artifact.

4. **Stale local `origin/main`** — if the user hasn't fetched for days,
   the diff could be larger than reality, but never smaller. Under-block
   is bounded: you cannot *miss* a file this way, only over-include.
   We still proactively `git fetch --quiet origin main` inside the hook
   to keep it tight.

The accepted residual risk is (1). Mitigation: CI is the merge authority
(per `docs/signal-vs-authority.md`); the pre-push gate is downgraded from
"implicit authority" to "explicit signal" by this change, which matches
the architectural principle.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The correct layer is the pre-push hook itself (the boundary where
we trade speed for confidence on the contributor side). Alternatives:

- **Change vitest.push.config.ts to be smaller** — wrong layer. That
  config defines "the push suite"; the smoke tier is a *different use*
  of that same config, selected per-push based on diff size. Keeping
  two scripts that share one config is cleaner than two configs that
  overlap.
- **Change CI to run less** — wrong direction. CI is the authority; it
  must remain exhaustive or the invariant breaks.
- **Tag some tests as "smoke" and run only those** — brittle taxonomy
  that humans would have to maintain. Vitest's `--changed` computes
  affected tests from the module graph automatically; no taxonomy drift.

Signal-vs-authority reference: `docs/signal-vs-authority.md`. The new
pre-push hook is a signal consumed by the contributor (and, if they
push anyway via `INSTAR_PRE_PUSH_SKIP=1`, CI is the binding authority).
The old hook *was* acting as authority by blocking pushes that CI
would have caught anyway — same verdict, earlier but slower. Moving
the authority to CI and keeping a fast signal locally is the correct
decomposition.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface on message flow or agent behavior.
- [ ] Yes — but the logic is a smart gate with full conversational context.
- [ ] ⚠️ Yes, with brittle logic.

The pre-push hook is now explicitly a *signal* — it fails the push fast
when a clearly-affected test regressed, and otherwise lets CI act as
authority. The `INSTAR_PRE_PUSH_SKIP=1` escape hatch formalizes this:
contributors can bypass the signal; they cannot bypass CI on the PR.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Pre-push gate (NEXT.md / version / side-effects / contract evidence):**
  runs *before* the test tier and is unchanged. Smoke tier substitution
  happens after that gate passes. No interaction risk — orthogonal
  concerns.
- **Retry loop:** the 2-attempt retry is preserved, now wrapped around
  `test:smoke`. Same behavior on flaky failures; just shorter because
  the retry suite is smaller.
- **CI (`ci.yml`):** unchanged. Still runs 8 sharded unit-test matrix +
  integration + e2e + build + type-check on every PR. CI remains the
  authority on merge-readiness.
- **Shadowing:** does not exist. CI is not a `needs:` target of the
  pre-push hook or vice versa; they operate on different events
  (contributor push vs. GitHub Actions PR event).
- **Double-fire:** if a contributor has the smoke tier pass and pushes,
  CI re-runs the full suite — intentional double-gate (fast local
  signal, authoritative remote). Not wasted work; that's the design.
- **Races:** none. Contributor-side hook, synchronous, no shared state.
- **Feedback loops:** if `origin/main` ref moves mid-push, the diff
  window shifts but the push is a single event; the diff is snapshotted
  at hook-start time.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** no. The git hook runs only in
  the contributor's shell during `git push`.
- **Other users of the install base:** no runtime change. The shipped
  npm package is unchanged. Only the contributor-side hook installed
  by `npm install` is affected, and only for people working *in* the
  instar repo — not consumers of the `instar` package.
- **External systems:** no.
- **Persistent state:** none touched.
- **CI minutes consumption:** unchanged — CI runs the same matrix.
  If anything, fewer "contributor runs full suite locally, then CI
  runs it again" iterations means slightly less duplicated load on
  developer machines.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Trivial. Revert the commit that changes `.husky/pre-push` and
`package.json`. `test:push` is unchanged, so the pre-push hook
reverts to running the full suite exactly as it did before. No
migration, no state cleanup, no user-visible impact (since the
npm package is unaffected).

Partial rollback also available without reverting: set the env var
`INSTAR_PRE_PUSH_FULL=1` globally (e.g., in the user's shell rc) to
restore the old blocking behavior without changing any code.

---

## Conclusion

Moves the pre-push test gate from "implicit authority" (slow, exhaustive,
blocks every push) to "fast signal" (runs only tests affected by the
diff, CI remains the merge authority). Matches the signal-vs-authority
architectural principle. Preserves the exclude list, the isolation
invariant (`fileParallelism: false`), the NEXT.md / version / side-effects
gate, the retry loop, and the full suite in CI — all authorities stay
authoritative. Expected wall-clock on a typical small push: ~9 min → <1
min. Escape hatches for the edge cases. Rollback is one revert. Cleared
to ship.

---

## Evidence pointers

- `docs/signal-vs-authority.md` — the architectural principle this change
  aligns the hook with.
- Vitest `--changed` mode docs:
  <https://vitest.dev/guide/cli.html#changed> — deterministic, based on
  module graph, safe to compose with `--config`.
- CI authority chain: `.github/workflows/ci.yml` — 8-shard unit matrix
  + integration + e2e + build + type-check; required by branch
  protection on main (per the ruleset update landed with PR #69).
