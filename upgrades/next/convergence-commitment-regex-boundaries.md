# Pre-messaging commitment check stops flagging innocent words

## What Changed

The pre-messaging quality gate's "commitment overreach" pattern matched the
bare sequence `i (promise|...)` anywhere in a message — including INSIDE other
words. "the Mini promises" (a word ending in *i* followed by a plural noun) and
"everything I promised" (past-tense narration) both tripped it; in one day it
blocked five legitimate status reports that contained no promise at all.

The pattern (all three copies: the shipped shell template, the migrator's
inline fallback, and the TypeScript ConvergenceChecker) now requires the
leading *i* to start a word and refuses to match when "promise" continues into
promised/promises. Real first-person commitments ("I promise to…",
"I'll make sure…", "you can count on me to…") still trip exactly as before.

## What to Tell Your User

Nothing — fewer spurious "message blocked" interruptions when the agent
mentions promises as a topic rather than making one.

- audience: agent-only
- maturity: stable

## Summary of New Capabilities

- Word-boundary guards on the commitment_overreach pattern in
  `templates/scripts/convergence-check.sh`, the PostUpdateMigrator inline
  fallback, and `ConvergenceChecker.ts` — kept in lockstep.
- Existing agents receive the fixed script automatically (convergence-check.sh
  is always-overwritten from the template on every migration pass).

## Evidence

- `tests/unit/convergence-check.test.ts` (+6): the five live false positives
  pass; real present-tense promises, sentence-final "I promise.", and the
  other commitment phrasings still flag. 61/61 in file (runs the REAL script).
- `tests/unit/convergence-checker-commitment-boundary.test.ts` (new): the same
  both-sides matrix against the TS checker.
- Pattern verified on macOS (BSD) grep -E with 12 probe strings before patching.
