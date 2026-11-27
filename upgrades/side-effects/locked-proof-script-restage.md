# Side-Effects Review — locked-Mac proof scripts: pack without prepare, re-stage over existing agents

**Version / slug:** `locked-proof-script-restage`
**Date:** `2026-11-20`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, 2 scripts + 2 test files, about 20 lines. `scripts/build-locked-proof.mjs` deletes `scripts.prepare` from the scratch copy's package.json, because npm 10.9.9 ran `prepare` (husky) on `npm pack --ignore-scripts` after the node_modules link was removed, failing the build. `scripts/locked-proof/stage-proof-agents.sh` runs `instar init --standalone` only for an agent with no `.instar/config.json`, because init exits 1 for an existing agent and aborted re-staging under `set -e`. Both were hit live building and staging 1.3.1942-lockedproof.6 on the Mac Mini. Effort: one commit attempt, no spec rounds.

## Decision-point inventory

No decision-point surface. These are developer test scripts. They don't gate, filter, or block anything an agent does at runtime.

## 1. Over-block

No block/allow surface. Over-block isn't applicable.

## 2. Under-block

No block/allow surface. Under-block isn't applicable. One known limit: if an existing agent dir has a corrupt config, init is skipped and configure then reports the problem itself. That's the same outcome as before, but with a clearer error.

## 3. Level-of-abstraction fit

This is fixed in the scripts that own the behavior. Changing `instar init` to tolerate existing agents would widen a user-facing command for a test-only need, so I didn't.

## 4. Signal vs authority compliance

Not applicable. No detector or authority is involved.

## 5. Interactions

The packed test tarball no longer lists a `prepare` script. npm never runs `prepare` when installing a tarball, so installs behave the same. The committed package.json is untouched.

## 6. External surfaces

None. The test build is never published. The scripts run only against the throwaway `instarproof` user.

## 7. Multi-machine posture

Machine-local by design. A developer runs the proof tooling by hand on the one proof Mac.

## 8. Rollback cost

A git revert. There's no state, migration, or fleet effect.
