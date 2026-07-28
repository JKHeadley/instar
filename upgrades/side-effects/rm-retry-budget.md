# Side-effects review — recursive-delete retry budget

**Change:** one constant in `SafeFsExecutor.withRmRetryDefaults` (`maxRetries: 3` → `10`, delay
unchanged at 100ms), plus a doc block and two new tests.

| Surface | Effect |
|---|---|
| Callers passing `recursive` + `force`, no `maxRetries` | Budget ~300ms → ~1s. **The only behavioural change.** |
| Callers passing an explicit `maxRetries` | **Unchanged** — the default only applies when it is `undefined`. Asserted by a new test. |
| Callers not passing `recursive` + `force` | **Unchanged** — the guard requires both. |
| A delete that would have succeeded | Unchanged; retries only run after a failure. |
| A delete that will never succeed | Fails after ~1s instead of ~300ms. |

Node applies `retryDelay` only for `recursive` removals and retries on the transient errors this
targets (`EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`, `EPERM`), so a widened budget cannot mask a
different class of failure — it retries exactly the races it was already retrying.

## What this does NOT establish

**It does not prove ~1s is sufficient.** No budget can be proven sufficient; it depends on machine
load. This makes the race much less likely to be lost, not impossible. I would rather state that than
imply the flake is closed.

The deeper fix for the observed case is ensuring the git child process has exited before teardown,
which belongs in the tests, not in a filesystem helper.

## Blast radius

`safeRm`/`safeRmSync` have **2,116 call sites**, so this is a wide change — but strictly in the
direction of more patience, and only on a path that has already failed once. The worst case is a
doomed delete taking 700ms longer to report.

## About the new tests — read this before crediting them

They cover behaviour that had **no coverage at all**: that a budget is applied when absent, and that an
explicit caller value is never overridden. That gap is how the defaults reached a state where they were
in force and simply too small.

**They would also pass on `main`** — the property predates this change. They guard the mechanism, not
the tuning. The tuning itself is a judgement no unit test can settle, and I am not going to present
green tests as evidence for it.

## Verification

- `tests/unit/SafeFsExecutor.test.ts` 22/22 (20 before + 2 new); `SafeFsExecutor-atomicWrite` 9/9;
  `handoff-manager` (the test that failed on main) 71/71.
- `tsc --noEmit` clean — after fixing a self-inflicted break: the first draft of the doc block
  contained a literal path with `*/` in it, which closed the comment early. The compiler caught it.
