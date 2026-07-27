# Side-effects review — rollout-evidence ratchet widened to `composed`

## What this changes

`scripts/lint-rollout-evidence-resolvable.js` guarded `rollout-disposition: active` only.
It now guards `active` AND `composed`. Guarded endpoint specs go from 5 to 8.

## Blast radius

The lint runs in the `npm run lint` chain, so it gates every commit and every CI run.
Widening it can, in principle, fail a build that previously passed.

**Measured, not assumed: it cannot do so today.** All eight guarded refs resolve; the lint
exits 0 with an EMPTY accepted-baseline. The three newly-covered specs are
`self-heal-gate.md` (`/feedback-factory/drain/status`), `context-wedge-detection-completeness.md`
(`/health`), and `slack-considered-acknowledgment-v1.md` (`/permissions/ambient-stats`).
Two were already transitively covered — one shares its ref with an active spec, one names a
path that trivially exists. Exactly one was genuinely unguarded.

## The failure mode this could introduce, and why it does not

The obvious risk of widening a guard is forcing unrelated work on whoever trips it next: a
`composed` spec whose owner feature was abandoned may legitimately carry a stale ref, and
such a person should not be conscripted into building a route they do not want.

They are not. Assertion C's shrink-only baseline is the escape hatch, and it was designed
before this change: an accepted entry requires a written reason and is auto-deleted the
moment its ref starts resolving. So the widened guard forces a DECLARATION, never a fix.
Entry needs evidence; exit happens by itself.

## What is NOT weakened

Assertions A (every guarded ref resolves unless accepted), B (baseline reasons must be
substantive), and C (baseline shrinks only) are unchanged. No threshold moved. The
refusal message now names which disposition fired, which is strictly more information.

## Verification

- Live run: `clean — 8 guarded endpoint spec(s) (5 active, 3 composed), 8 resolving, 0 accepted-unresolved`, exit 0.
- Falsified against the real subject: breaking the COMPOSED spec's ref → exit 1 with a
  refusal naming `rollout-disposition:composed`. Spec restored byte-identical; exit 0 again.
- Falsified against the tests: narrowing the filter back to active-only → `2 failed | 7 passed`.
  Restored → `9 passed`.
- Two pre-existing tests asserted the OLD summary wording and correctly broke. Their
  PROPERTY — that the guard must report its denominator, since "clean" alone cannot be told
  from "scanned nothing" — is preserved, with the pattern updated rather than the assertion
  dropped.

## Reviewer's note

This is a correction to my own work from earlier the same day. The lint's header claimed a
sweep of "all 5 rollout-active specs" — accurate for its scope, and the scope was narrower
than the class it names. Recorded in the source comment rather than quietly widened, because
a guard that silently grew is indistinguishable from one that was always right.
