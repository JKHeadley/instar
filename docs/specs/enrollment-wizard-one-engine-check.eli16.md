# Main passes its own engine-name check again (plain-English overview)

## What this is

A two-line repair to the sign-in code so that the project's main line passes its own checks again.

## Why it matters

Instar has a rule that code naming one specific AI engine should live in that engine's adapter and nowhere else. There is a lot of older code that breaks the rule, so a check counts how many such places exist and fails if the number ever goes up. That check reached main at 3:42 PM Pacific on 2026-11-14.

Half an hour later a sign-in fix merged. It had been tested just before the check existed, and it added one more place that names the Claude engine. The count went from 1135 to 1136. From that moment main failed its own check, and so did every change tested on top of main: six changes failed in eight minutes on one test machine, each in about 90 seconds, none through any fault of its own.

## What already exists

The sign-in code has two steps that apply only to Claude sign-ins: closing a sign-in request when the account already works, and preparing the account's settings folder after a sign-in completes. Each step checked "is this a Claude sign-in?" by naming the engine itself.

## What is new

One small helper in the same file asks that question, and both steps call it. The file names the engine once instead of twice, which is the number the check has on record. Nothing about what the sign-in code does has changed: the same two steps run for exactly the same sign-ins.

The recorded count is not raised. Raising it would have been quicker, and it would have defeated the purpose of the check.

## Safeguards

- The check itself confirms the repair: it reports 1135 again.
- The existing tests for both steps still cover them, unchanged.
- Going back is a normal revert, though a revert would break main again.

## What it does not fix

How this got through: a change that passed its tests on a slightly older main was merged after main had moved, and nothing re-ran the quick checks against the new main. That gap is recorded separately and is the more important fix.

## What a reader needs to decide

Nothing.
