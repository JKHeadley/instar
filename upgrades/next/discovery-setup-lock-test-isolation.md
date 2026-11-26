# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Discovery marker tests load the real marker functions under private temporary homes. They preserve the original missing, corrupt, CRUD and persistence checks, and a new two-home regression verifies independent marker files and deletion. Production discovery and normal runner admission are unchanged.

## What to Tell Your User

Running discovery tests no longer touches the computer’s in-progress setup marker. No user action is needed.

## Summary of New Capabilities

No new product capability or setting. This repairs ownership of test state.

## Evidence

The production module captures its marker path before the original tests substitute a temporary home. No unsafe historical baseline was executed. The sole authorized sequence passed 53 unit tests and 30 integration tests, with zero failures, skips or recorded unhandled errors and zero exits. Raw results and independent review are preserved with the candidate. Complete verification remains coordinator-owned.
