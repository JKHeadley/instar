# Structured Codex smoke result — Plain-English Overview

> The one-line version: make the last Phase 4 smoke check read a small machine result instead of depending on one presentation word.

## The problem in one breath

Two Phase 4 checks had already stopped deciding their result by searching human-readable output. The Codex smoke check was left behind: it still required the word `PASSED`. That old check failed closed, so it was not a security hole, but ordinary wording could block a good run and the three sibling checks no longer followed one consistent contract.

## What already exists

- **Process exit checks** — missing credentials, rejected credentials, empty output, and crashes already exit non-zero and therefore cannot pass acceptance.
- **A structured acceptance reader** — Phase 4 can already parse one JSON document and compare exact fields. R4 reuses that reader rather than adding another parser.
- **Human-readable smoke output** — developers can run the smoke command directly and see progress plus the familiar final success line.

## What this adds

Acceptance mode now asks the Codex smoke producer for one versioned JSON success record. The record exists only after a live provider response contains text. The Phase 4 manifest requires both the exact success status and the explicit non-empty-response field, in addition to exit code zero.

The ordinary human command is unchanged. Progress still goes to the terminal, and a successful run still ends with `PASSED`; that word is now presentation, not acceptance authority.

## The safeguards

**Old prose cannot impersonate success.** A controlled runner that prints the old success sentence and exits zero is rejected because it did not produce the structured record.

**A lying exit code is not enough.** A controlled runner that exits zero but reports failure is rejected. Conversely, a valid-looking record paired with a non-zero exit is also rejected.

**Nothing-to-run cannot pass.** Empty provider text creates no success record and exits non-zero. JSON mode keeps diagnostics on stderr so stdout contains exactly the one document the existing reader expects.

## What ships when

This pull request ships the typed result helper, the producer wiring, the Phase 4 manifest update, its both-direction tests, and the decision record together. It makes no live paid call and does not replace the historical live-provider evidence already in the manifest.

## What you actually need to decide

Approve whether the remaining Codex smoke sibling should use the same exact structured acceptance contract as the other Phase 4 checks while retaining its current human-facing output.
