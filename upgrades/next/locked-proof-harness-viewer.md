<!-- bump: patch -->

## What Changed

The locked-Mac proof scripts (test tooling, not shipped behaviour) now follow the desktop page when it opens the screen by itself, give each proof agent a dashboard PIN from the operator's vault without printing it, and name the required finalize step at every stage.

## What to Tell Your User

Nothing changes for you. This only affects the test scripts used to prove the locked-screen feature on a spare Mac.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Proof driver follows the viewer's auto-open | automatic in the locked-Mac proof driver |
| Proof agents get a dashboard PIN from the vault | stage-proof-agents.sh --agent-home DIR |

## Evidence

tests/unit/locked-proof-driver.test.ts (32 tests pass).
