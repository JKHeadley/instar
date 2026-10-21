# Side-Effects Review — per-folder trust seed

**Slug:** `per-folder-trust-seed`
**Date:** `2026-10-20`
**Author:** Echo (autonomous, 24h run on topic 61449)
**Tier:** 1

## Summary of the change

`ensureInteractiveReady` seeded three top-level onboarding flags and returned
`already interactive-ready` on their presence alone. Claude Code gates "Do you
trust the files in this folder?" on the per-project entry
`projects[<agent dir>].hasTrustDialogAccepted`, whose default dialog option is
"No, exit". A pool home with the top-level flags and no project entry therefore
passed as ready and killed every session launched under it (Mac Mini, 2026-10-20:
three sessions, each dead in 16 seconds, 35 minutes of apparent silence).

The function now takes `projectDir`, seeds that entry, and treats its absence as
sufficient reason to patch. All three callers pass it.

## Decision-point inventory

No LLM decision points added or changed. Purely a deterministic config seed.

## Blast radius

- `ensureInteractiveReady` — one new optional option; one new key written inside
  one project entry, created only when missing. Without `projectDir` the function
  is byte-identical to before.
- `SessionManager` — passes its project dir; adds a public `agentProjectDir()`
  accessor because `SessionRefresh` holds only a `SessionManager`.
- `SessionRefresh` — passes it for the account-swap respawn target.
- `PostUpdateMigrator` — passes it in the pool-wide sweep. This is the Migration
  Parity surface: an already-deployed agent receives the fix through no other path.

## Reversibility

Reversible by revert. The written key is additive and is what a human accepting the
dialog would have produced, so a reverted build reads a config it already
understands. No schema change, no migration record, no new config option.

## Failure modes considered

- **Clobbering a login.** The write is scoped to one key in one project entry.
  Credentials and `oauthAccount` are untouched (test), other folders' entries and
  their `allowedTools` are preserved (test), the write stays atomic tmp+rename, and
  an unparseable file is still refused rather than rewritten.
- **A malformed `projects` value.** A non-object value is replaced rather than
  thrown on (test), so a corrupt-but-parseable config cannot wedge a launch.
- **Asserting trust the operator did not give.** This is a local trust
  acknowledgement for the agent's OWN directory, under a login the operator
  enrolled for that agent, and the same acknowledgement `init` and `setup` already
  write for the default home. It grants no new reach.
- **Silently doing nothing.** The old early-return was exactly that failure, so the
  regression test asserts a home with all top-level flags set and `projects: {}` is
  still patched, and the reason names folder trust.

## Verification

7 new unit tests (21 in the file, all passing) plus 4 wiring-integrity tests
asserting every live caller passes the directory — including the migrator. The
regression test was verified to FAIL without the fix. Full lint clean.
`tsc --noEmit` clean.
