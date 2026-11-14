# Faster lint checks — plain-English overview

## What this change is

Every time someone commits code to Instar, and in every CI run, about 50 of our own automatic checks run over the code. They look for things like unsafe file deletion, unattributed AI calls, or rules in our standards document that have quietly lost their enforcement. They ran strictly one after another, and the whole set took about two and a half minutes on our development machine.

This change makes them faster in two ways.

**Running them side by side.** The checks don't depend on each other, so there's no reason to wait for one to finish before starting the next. A new runner starts several at once (up to eight, depending on how many processors the machine has). It reads the list of checks from the same place as before, so the list can't drift. A bonus: if two checks fail, you now see both in one run instead of fixing one and discovering the next.

**Not asking the same question twice.** One check, which verifies our standards document against the code, was starting a separate `git` program 891 times in a single run. It asked for the same file up to 36 times. The answers come from one fixed version of the code, so they can't change; now each question is asked once. That check went from 53 seconds to 25, with exactly the same result.

## What we measured

- The standards check: 53 s → 25 s, identical output.
- The whole set of checks: 154 s one at a time → 106 s side by side. The longest remaining step is the type-check, which the separate TypeScript 7 change cuts from about 70 s to about 15 s, so together the set should land around one minute.

## Safeguards

- The list of checks is unchanged and still lives in one place; the runner reads it.
- We confirmed no check depends on another's output and that none writes files in the way lint runs them.
- Setting `INSTAR_LINT_CONCURRENCY=1` runs the checks one at a time again, without undoing anything.
- Nothing that running agents use changes; this is development tooling only.

## What a reader needs to decide

Nothing beyond whether faster commits are worth checks running at the same time on the developer's machine.
