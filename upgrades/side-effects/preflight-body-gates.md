# Side-Effects Review — dev:preflight PR-body gates

**Version / slug:** `preflight-body-gates`
**Date:** `2026-08-15`
**Author:** `Instar-echo`
**Tier:** 1 (additive optional flag; no behaviour change without it)

## Summary of the change

`instar dev:preflight` gains `--body <file>` and `--title <text>`. When a body is
supplied it additionally runs the gates whose subject is the PR description —
`scripts/eli16-pr-description-check.mjs` and `scripts/ux-impact-lint.mjs` — and
their worst exit code participates in the aggregate verdict. The runner interface
gains an optional `env` argument so the ELI16 gate can receive `PR_BODY`.

**Why:** preflight verified the DIFF and was structurally incapable of catching a
gate that reads the BODY, which does not exist until `gh pr create` runs. The
ELI16 gate consequently went red across three separate sessions on work whose
local lint was green throughout. This is the structural half of a failure that
three rounds of "remember to pre-flight" did not fix.

## Decision-point inventory

- **Aggregate preflight verdict** — *widened*. A new input can now fail the run.
  It can only fail it for a gate the caller explicitly asked to run.
- **Existing gates (lint, discoverability, route heuristic)** — *untouched*.
- **The body gates themselves** — *untouched*. This changes only *when* they can
  be run, never what they decide.

---

## 1. Over-block

The one new rejection is an **unreadable `--body` path**, which fails the run.
This is deliberate: the caller asked for these gates and we could not run them, so
passing would be a plausible-zero — the precise false confidence this change
exists to remove. It cannot fire unless `--body` is passed.

No legitimate existing invocation is newly rejected: without `--body`, behaviour
is byte-identical to before.

## 2. Under-block

- Only two body gates are wired. A future gate reading the PR body will not be
  picked up automatically; `BODY_GATE_SCRIPTS` is the one place to add it.
- Running preflight does not *force* anyone to pass `--body`. Someone can still
  skip the description gates by omitting it — the skip is printed, but it is a
  visible skip rather than an enforced check. Full enforcement would belong in a
  hook at `gh pr create` time, which this change does not attempt.

## 3. Level-of-abstraction fit

Correct layer: preflight already exists as "run the server's checks early", and
these are server checks it could not reach. The alternative — a separate script —
would create a second thing to remember, which is the failure mode being fixed.

## 4. Signal vs authority

Preflight is advisory by construction: it reports and exits non-zero; it blocks
nothing and gates no runtime path. This change adds no authority. The gates it
invokes hold whatever authority they already had in CI, unchanged.

## 5. Interactions

Does not shadow CI: the same gates still run server-side and remain
authoritative. A local pass does not mark anything as satisfied — it only tells
the author what CI will say. Scripts are existence-checked, so an older checkout
lacking them skips quietly rather than erroring.

## 6. Multi-machine posture

**Machine-local by design.** It is a developer command reading a local file and
spawning local scripts. No replication path, no cross-machine state, no user-
facing notice, no generated URL. Nothing to strand on topic transfer.

## 7. Failure modes

- Gate script absent → skipped quietly (older checkout).
- Body unreadable → run fails, reason printed to stderr.
- Gate spawn fails → surfaces as that gate's non-zero exit, same as any other step.

## 8. Rollback cost

Delete the flag handling; no data, no schema, no migration, no agent state. Users
who never pass `--body` are unaffected either way.

## Evidence

9 new unit tests plus the 5 existing preflight tests, all passing. They pin both
directions: supplying a body **runs** the gates (asserting `PR_BODY` is actually
threaded through the environment — untested, the gate would judge an empty string
and pass vacuously), a failing gate **fails** the run, and a control confirms an
all-green run still passes so the failure is the gate rather than the harness.
Omitting a body **skips** visibly rather than failing.

Validated against the real defect: the actual PR body I shipped earlier today —
before its ELI16 section was added — **fails** the real gate, and the corrected
body **passes** it. The control matters: it proves the failure is the missing
section rather than a broken gate.
