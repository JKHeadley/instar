# Side effects: docs-coverage matches spaced nested subcommands

Change: `scripts/docs-coverage.mjs` `findMentions` adds a third needle for CLI
capabilities, the kebab name with hyphens replaced by spaces, so a nested
subcommand registered as `mobileIntroducer` counts as documented when the docs
write `instar mobile introducer`. `site/src/content/docs/reference/cli.md` gains
the entry for that command, which is what turned main's Docs Coverage red.

Who is affected: only the Docs Coverage CI check. No runtime code, no shipped
package behaviour, no agent-facing surface changes.

Over-match risk: a spaced needle could count an unrelated prose phrase such as
"instar mobile introducer" as documentation. That phrase only appears when
someone is in fact documenting the command, so the false-pass risk is negligible
and the check stays a presence check, not a quality check.

Under-match risk: none added; the two existing needles are unchanged.

Rollback: revert the one-line needle change; the docs entry is harmless alone.

Second pass: not required (CI-only script, one-line widening, no runtime path).
