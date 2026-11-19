# Fix sessions see the review rules — Plain-English Overview

## The problem in one breath

Instar fixes some reported bugs on its own. A confined coding session writes the fix, and then two independent reviewers (one Claude, one from another model family) decide whether the change is safe to merge. The reviewers check six rules. The coding session was never told those rules: its instructions only said "you have no network and no credentials". So it kept writing fixes that broke a rule it had never seen, and the reviewers kept refusing them. Three recent refusals: a test that used token-looking values and replaced the home directory (PR 3261), a fix that widened an error catch beyond what the bug needed and had no test (PR 3252), and a fix that weakened existing tests by adding delays (PR 3292).

## What already exists

- The reviewer's instructions, with the six rules: Scope, Tooling, Secrets and reach, Tests, Injection, Breakage.
- The coding session's instructions, which describe the task and the result file but not the rules.

## What this adds

The six rules now live in one small module. The reviewer reads them from there, so its instructions are exactly what they were before, byte for byte (a test pins that). The coding session's instructions now include the same rules, introduced with "Your change will be refused by an independent reviewer if any of these hold:", followed by a few plain habits: change only what the bug needs; tests use temporary folders only, never the home folder or real paths; never put token-looking values in tests; never weaken, delay or delete existing checks; every behaviour change needs a test that fails without it. Because both sets of instructions read the same list, they cannot drift apart again.

## The new pieces

- One module holding the rules (a fix version and a design-draft version).
- A test that checks the coding session sees every rule, and that the reviewer's instructions did not change.

## The safeguards

Nothing about what gets merged changes: the reviewers apply the same rules with the same words. The coding session only learns more about them. If the new wording somehow made fixes worse, removing it is a one-line revert.

## What ships when

All of it ships in one patch release.

## What you actually need to decide

Nothing. This is a quality fix inside the automatic bug-fixing pipeline.
