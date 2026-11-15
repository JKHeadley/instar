# Two small checker fixes for transcript copies — Plain-English Overview

> The one-line version: two automatic code checks flagged the new transcript-copy code; one answer now goes through the standard error wrapper and one error path now says why it is not silent.

## The problem in one breath

The project has a check that every error message a server route sends back passes through a shared wrapper first, and a check that counts places that catch an error and carry on quietly. After catching up with the main line, the new transcript-copy code tripped both: one "that page cannot be read" answer skipped the wrapper, and one place that catches a failed copy looked quiet to the checker.

## What this changes

The answer now goes through the wrapper. For this kind of error the wrapper returns the same text, so what the caller sees does not change. The failed-copy path already records the failure and retries on the next round; it now carries a note saying so.

## The safeguards

No behaviour, interface or limit changes. Reverting the commit undoes it completely.

**Update (2026-11-14):** two more lists needed the new transcript copies: the list of stores only the server writes to, and the list of internal addresses that agents learn about from their instructions rather than the capability list. Nothing behaves differently.

**Update (2026-11-14, later):** the count of hard-coded engine names was updated to follow two names that moved into a new file. Nothing behaves differently.
