# Tests build Instar with the faster compiler too — plain-English overview

## What this change is

Before the tests can run, Instar's code has to be compiled from TypeScript into JavaScript. On our automatic test servers (CI), every test job starts from a clean copy, so every job compiles everything first. We measured this taking about 39 seconds per job before a single test starts, and a CI run has about ten such jobs.

The previous change switched our normal build to TypeScript 7, the natively compiled version of the compiler, which produces exactly the same JavaScript about four times faster. But the test setup still asked for "whichever TypeScript is installed", and with both versions installed that could be either one. This change makes the test setup use TypeScript 7 explicitly, the same as the normal build.

## What it saves

About 25–30 seconds at the start of every CI test job, and on any local test run that needs a fresh build.

## Safeguards

- The JavaScript produced is byte-for-byte the same as before; this was checked across every file when TypeScript 7 was introduced.
- An independent reviewer checks it, because it changes how tests are set up.
- Undoing it is a one-commit revert.

## What a reader needs to decide

Nothing; it finishes the TypeScript 7 switch for the test setup.
