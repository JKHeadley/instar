# instar-dev build-location re-grounding

<!-- bump: patch -->

## What Changed

The instar-dev workflow now requires a build-location re-grounding step during
Phase 2 planning. Before writing code, the agent must confirm it is building in
a fresh worktree off current `JKHeadley/main`, verify the git remote, and verify
the package version. PostUpdateMigrator backfills this updated skill text into
existing dev agents when their installed instar-dev skill still matches the
stock copy.

## What to Tell Your User

I added a structural checkpoint to the Instar development workflow so a restarted
agent is less likely to build from an old checkout. It now has to prove it is
working from current main before changing source.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| instar-dev build-location re-grounding | Automatic in the instar-dev workflow; existing stock dev-agent skill files are updated on the next agent update. |

## Evidence

The failure was reproduced operationally during mentor onboarding: a respawned
session built a fleet PR from an old agent-home checkout instead of current
`JKHeadley/instar`. The fix was dogfooded from a fresh current-main checkout.
Focused PostUpdateMigrator skill-migration tests verify stock update,
idempotency, customized-skill preservation, and missing-skill no-op behavior.
