<!-- bump: patch -->
## What Changed

Adds the engine checkpoint for the Context Budget work (`src/monitoring/engineCheckpoint.ts`): a byte-exact, hash-verified copy of a session's transcript taken before a fold, kept privately on this machine (0600 under `.instar/state/context-archive/<topic>/checkpoints/`, never served, never backed up, never replicated), and a restore that resumes the original session when it is unchanged or materialises the checkpoint as a new session transcript otherwise. It is a fold carrier: deleted when the fold commits, kept for 24 hours after a rollback, removed at boot if its fold has no record. Nothing takes a checkpoint yet.

## What to Tell Your User

Nothing changes for you yet. This is the safety copy that lets me put a conversation back exactly as it was if tidying its memory ever goes wrong.

## Summary of New Capabilities

- Byte-exact pre-fold transcript checkpoint with resume or materialise restore; not used yet.

## Evidence

- Unit `tests/unit/engine-checkpoint.test.ts`; integration `tests/integration/engine-checkpoint-fold-lifecycle.test.ts`; e2e `tests/e2e/engine-checkpoint-crash-lifecycle.test.ts`; L7 on real Claude Code 2.1.322: a materialised checkpoint resumed with `--resume` recalled a codeword only the checkpoint held (control session: NONE).
