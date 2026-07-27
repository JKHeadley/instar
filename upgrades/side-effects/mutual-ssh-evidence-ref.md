# Side-effects review — mutual-ssh rollout-evidence-ref correction

**Change:** one frontmatter line in `docs/specs/mutual-ssh-autobootstrap.md` —
`rollout-evidence-ref: /multi-machine/mutual-ssh` → `/machines/ssh-health`.

**Tier:** 0–1. Spec frontmatter only. No `src/` surface, no route, no config key, no persisted
state, no migration. Rollback is reverting one line.

## What reads this field

`scripts/lint-rollout-evidence-resolvable.js` (string-matches the ref against `src/`) and any
future rollout-graduation reader. Nothing at runtime dereferences it — the field is documentation
of where a human or a check should look, so a wrong value cannot cause a runtime fault. Its failure
mode is exactly what happened: silence.

## Blast radius

None at runtime. The one behavioural consequence is intended and desirable: the mutual-ssh rollout
becomes *measurable*, and the first honest measurement says **not ready** (`enrollmentState:
ssh-bootstrap-blocked`, `pairs[0].mutual: false`). A feature that previously could not be assessed
now reports a negative. That is the point; it is not a regression.

## Why not build `/multi-machine/mutual-ssh` instead

That was the first plan, and it was wrong. Adding an alias route to satisfy a spec that named a
non-existent path would have created a second address for one readout — two places to look, two
things to keep in sync, and a permanent invitation to the same confusion. The spec was wrong; the
spec was corrected.

## Verification

- `curl /multi-machine/mutual-ssh` → 404 (before and after — nothing was added).
- `curl /machines/ssh-health` → 200 with live pair state.
- `node scripts/lint-rollout-evidence-resolvable.js` → the corrected ref resolves.

## Rollback

`git revert` the one-line commit. The rollout returns to being unmeasurable, which is the state it
has been in since 2026-07-21.

## Known limitation, stated rather than hidden

The lint that guards this field is a **string match against `src/`**. A route that is written but
never mounted would still satisfy it. That limitation is documented in the lint's own header; the
live probe above is what actually establishes that this particular ref resolves.
