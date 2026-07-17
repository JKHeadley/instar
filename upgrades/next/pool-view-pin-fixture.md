# Pool-view PIN leak fixture hardening

## What Changed

The pool-view proxy security test now uses a distinctive high-entropy PIN fixture instead of the short string `1234`.

## Evidence

The focused eight-test pool-view proxy integration suite passes.

## What to Tell Your User

The test can no longer pass or fail accidentally because an unrelated value happens to contain the common sequence 1234.

## Summary of New Capabilities

No runtime capability changes; this makes the existing raw-PIN boundary proof more precise.
