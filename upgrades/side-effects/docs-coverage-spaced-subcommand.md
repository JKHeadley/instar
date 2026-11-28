# Side effects: docs-coverage matches spaced nested subcommands

Change: `scripts/docs-coverage.mjs` reads the nested command paths that `src/cli.ts` actually declares (commander chains such as `const mobileCmd = program.command('mobile')` and `mobileCmd.command('introducer')`) and keys each path of two or more words by its camelCase file name (`mobile introducer` is `mobileIntroducer`, `mobile add-phone` is `mobileAddPhone`). A command counts as documented by that exact spaced path, in addition to the two existing needles (raw name and kebab form). `site/src/content/docs/reference/cli.md` gains a Mobile pairing section with each introducer subcommand and its flags, replacing main's one-line summary of the same commands.

Who is affected: only the Docs Coverage CI check. No runtime code, no shipped package behaviour, no agent-facing surface changes.

Over-match risk: the first version of this change turned every hyphen into a space for every command. That would have counted "instar set claude key" as documentation for the one-word command `set-claude-key` (second-pass dissent on head ab6b13a48). The spaced needle now exists only for a path `src/cli.ts` really declares as nested, so a one-word hyphenated command never gains a spaced spelling.

Under-match risk: none added; the two existing needles are unchanged. A nested path declared in a shape the parser does not read (for example a command built in a loop) simply gets no spaced needle, which is today's behaviour.

Tests: `tests/unit/scripts/docs-coverage.test.ts` adds a mock-repo case with a real nested command (`mobile introducer`), a nested hyphenated subcommand (`mobile add-phone`), and a one-word hyphenated command written with spaces (`instar set claude key`). The first two count; the third stays undocumented. Run by hand on the M5 against a mock repo with the same files: mobileIntroducer PARTIAL, mobileAddPhone PARTIAL, setClaudeKey UNDOCUMENTED. On the real tree the command total stays at or above its floor.

Rollback: revert the needle change and the helper; the docs entry is harmless alone.

Decision: Design Standards session, as the owner of this detector, 2026-11-27 (Chief of Staff routing via Project Alignment).

## Second-pass review

**Reviewer:** independent second-pass subagent (general-purpose, fresh context, given the diff only), run by Echo on the Mac Mini against merged head bdc085b77, 2026-11-27. Verdict: concur.

Run against the real `src/cli.ts`, the parser finds 135 nested paths with no key collisions, and only six command files map to one. `set-claude-key` correctly gets no spaced spelling, the existing needles are unchanged, and a missing `cli.ts` just means no spaced needles. Tests pass, and `--check` passes (command 61% against a 60% floor). Minor nits, none blocking: chained `.command().command()` calls are not parsed (`telegram-origin enroll-browser`, harmless today because its kebab form already matches). The spaced needle is a substring match, as the existing needles are. Three CLI reference entries (`jobMigrate`, `ledgerCleanup`, `memoryBackfillEvidence`) still use camelCase names for commands that are really nested.
