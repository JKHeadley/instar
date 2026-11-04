# A test ran out of room reading the list of files

One test, `tests/unit/audit-convergence-reports.test.ts`, asks git for the list of every file in the repository and reads the answer into memory. Node gives that kind of read a fixed space of 1 MiB by default. On 2026-11-04 the list of files grew to just over that size (1,049,111 bytes), so git's answer no longer fit, and the test failed with "ENOBUFS" on main for every pull request. Nothing was wrong with the reports the test checks; it simply could not read the file list.

The fix gives both of the test's file-list reads an explicit 64 MiB space, the same size other scripts in this repository already use for full listings (`scripts/release-skip-annotate.mjs`). The test checks exactly what it checked before.

I looked for other places that read the whole file list. `scripts/release-skip-annotate.mjs` already uses 64 MiB, and `src/moltbridge/ProfileCompiler.ts` goes through SafeGitExecutor, which defaults to 10 MiB. The one in `src/core/PostUpdateMigrator.ts` lists an agent's own project folder, which is far smaller than this repository, so it is left alone.

Nothing in the product changes. This only makes main green again so other pull requests can be verified. The local-verify queue was holding three pull requests behind this failure.
