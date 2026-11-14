# One shared 25,000-file fixture for the Codex rollout lookup test — Plain-English Overview

> The one-line version: four tests that each built and deleted the same 25,000 files now build them once and share them, so the slowest unit test file drops from about 35 seconds to about 3.5 when run alone, and from about 6 minutes inside a full, loaded test run.

## The problem in one breath

Every change to instar has to pass the whole unit test suite before it can merge. On 2026-11-12 one file, `tests/unit/codexRolloutLookup-bounded.test.ts`, took 363 seconds inside a full run. That was the slowest of 3,598 unit test files and more than a third of the whole stage's wall time on one worker. Four of its tests each created a pretend archive of 25,000 empty files, read it, and deleted it again.

## What already exists

- **The lookup being tested** — it finds one Codex session file in a very large archive without freezing the server. The tests prove both that a present file is found and that a missing one costs bounded work.
- **The fixture builder** — a helper that writes a dated archive of any size into a temporary folder.

## What this adds

The four tests that need the larger-than-budget archive now ask for one shared copy. The first test to ask builds it; the rest reuse it; it is deleted once at the end of the file. Nothing about the code under test changes, and every assertion is kept as it was.

## The safeguards

- The lookup's own remembered state is still reset before every test, as before.
- Two tests add one extra file to the shared archive. Each removes its file again in a `finally` block, so the next test sees the archive as built.
- The tests that need small or specially dated archives still build their own, in their own temporary folder.
- Test-only change: no product code, no settings, nothing a user or an agent can see.

## What you need to decide

Nothing. A revert restores the old file exactly.
