# Local vs CI test parity — measurement

**Date:** 2026-08-15 · **Window 16 parallel lane** · **Status:** measured, not yet fixed
**Repo state:** `origin/main` @ v1.3.1161

## The question

Do `npm test` (local) and CI execute the same set of test files? If not, "passes
locally" and "passes in CI" are answers to different questions, and the gap
between them is where the Zero-Failure Standard silently stops applying.

## My hypothesis was WRONG — recorded because that is the useful part

I predicted local runs a **subset** of CI: that `npm test` used the default
config and covered only `tests/unit/**` (~2,275 of 3,086 files), while CI ran
more.

**The opposite is true.** The default `vitest.config.ts` include is:

```
tests/unit/**/*.test.ts
tests/integration/**/*.test.ts
tests/e2e/**/*.test.ts
```

So `npm test` runs **all three tiers with no exclusions**. My "2,275 unit" figure
was a count of *files in a directory*, never a count of *what the default config
runs* — a scope error, not an arithmetic one.

## What CI actually runs (read from workflow YAML, not job names)

| CI job | Command | Config |
|---|---|---|
| unit shards ×4 | `npm run test:push -- --shard=N/4` | `vitest.push.config.ts` |
| integration | `npm run test:integration` | `vitest.integration.config.ts` |
| e2e | `npm run test:e2e` | `vitest.e2e.config.ts` |

`vitest.push.config.ts` includes the **same three tiers** as the default config,
then applies `exclude: FLAKY_TESTS`.

## The gap, measured

`FLAKY_TESTS` holds **91 entries**:

| Tier | Entries | Covered elsewhere in CI? |
|---|---|---|
| integration | 30 | **yes** — `test:integration` runs `tests/integration/**` with no exclude |
| e2e | 28 | **yes** — `test:e2e` runs `tests/e2e/**` with no exclude |
| unit | 33 | **NO** — no CI job runs `tests/unit/**` outside the push gate |

Expanding globs and dropping stale entries, those 33 unit entries resolve to:

> ### 97 real unit test files that run locally and are executed by no CI job at all
> 4.3% of the 2,278 unit test files.

Two details inside that number:

- **One line accounts for 66 of the 97**: `tests/unit/threadline/**` excludes an
  entire directory. A single glob is doing most of the damage.
- **One entry is stale**: `tests/unit/slack-stall-active-gate.test.ts` no longer
  exists. An exclusion nobody revisits outlives the file it excluded.

## Predictions, stated and checked

Per the control discipline — a diff with no prediction is unfalsifiable:

- **Predicted present in the gap:** `tests/unit/server.test.ts`. It is core, and
  core files are the ones bulk-excluded when a gate is made green under time
  pressure. **Confirmed** — it is in the list. (I ran it during this window; it
  passes, 18 tests. So it is excluded from CI while being green, which is worse
  than excluded-because-broken: nothing will ever prompt its return.)
- **Predicted absent from the gap:** `tests/unit/agent-signature-provenance.test.ts`,
  written today. **Confirmed absent** — new tests are not born excluded.

## Why this matters

The Zero-Failure Standard says the suite must be green and names `npm test` as
the command. But CI cannot observe 97 unit files. Consequences:

1. A regression in any of those 97 is invisible to CI. It surfaces only when a
   developer runs the full local suite.
2. "CI is green" is therefore **not** equivalent to "the suite is green" — the
   standard's enforcement mechanism has a 4.3% blind spot in the unit tier.
3. The direction is counter-intuitive and worth stating plainly: **local is the
   stricter runner.** Anyone reasoning "CI passed, so my local failure is
   environmental" has it backwards.

## The exclusion's own history condemns it

The push config carries this comment, already in the repo, about two of its
entries:

> "Both arrived here in f193df789 ('exclude pre-existing flaky tests from push
> gate') — a BULK exclusion, not an individual diagnosis. That is the actual
> defect: the label was applied to a batch and then read, forever after, as a
> finding about each member."

That is exactly right, and the measurement above shows the pattern did not stop
at two: 97 files now inherit a batch label as though each had been diagnosed.

## Not done here

This is a **measurement**, deliberately. No exclusions were removed — each of the
97 needs an individual verdict (genuinely flaky / green and restorable / stale
entry), and doing that in bulk would repeat the exact defect that created the
list. The stale entry and the 66-file glob are the two highest-value places to
start, in that order.
