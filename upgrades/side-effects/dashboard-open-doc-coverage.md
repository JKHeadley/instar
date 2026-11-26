# Dashboard Open Documentation Coverage

## Summary

Tier 1. The command reference documents the shipped dashboard subcommand. The coverage check accepts its exact multiword spelling for the corresponding source file.

## Review

- Over-block and under-block. The additional spelling can only add a match for the dashboard command. The existing substring matching behavior still applies.
- Abstraction and authority. The existing coverage check owns command-to-document matching and applies the existing floor. This adds one concrete spelling and no competing-signal decision or runtime authority. See [Signal vs authority](../../docs/signal-vs-authority.md).
- Interactions. The existing file-name and kebab-case matches retain their meaning. A document is counted once regardless of how many spellings it contains.
- External surfaces. The CLI reference gains an example for an existing command. Runtime commands, authorization, and persisted state have no changes.
- Multi-machine posture. CI computes coverage from its checkout. The check has no state to replicate.
- Rollback. Revert the documentation and matcher together. No migration or state repair is needed.

## Evidence

The repository coverage check and all eight tests in the coverage script unit file passed. The new test exercises the exact command shown in the reference.
