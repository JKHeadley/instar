# A failed Jev check now records what kind of failure it was

<!-- bump: patch -->
## What Changed

When the shared Jev-first gateway (`src/core/JevFirstDecision.ts`) could not get an answer from Jev, it wrote a `jev-error` decision row with no cause and no timing, so the commitment-detect error rate (13 of 110 calls in the last week) could not be diagnosed. The catch now classifies the failure into a fixed code `jevFailureKind` (`timeout`, `http`, `invalid-body`, `transport`), records `jevHttpStatus` for an HTTP failure, and records `jevElapsedMs` measured with the gateway's injected clock, on failed and successful calls. The error message text is never written. Behaviour is unchanged: every failure still hands the decision to the incumbent exactly as before, and no stage, band, question or model changes.

## What to Tell Your User

Nothing changes for you. When the fast first check behind some small decisions fails, the record now says what kind of failure it was, so the failure rate can be fixed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| Failed Jev checks record a fixed failure kind, HTTP status and elapsed time | Automatic, in decision-provenance rows |

## Evidence

New unit tests in `tests/unit/JevFirstDecision.test.ts` classify an abort, `Jev HTTP 429`, a SyntaxError and an ECONNRESET-style error from an injected `askJev`, check the elapsed time comes from the injected clock, check the row holds none of the error text, and check success rows gain `jevElapsedMs`. Existing JevFirstDecision, PromptGate-jevFirst and CommitmentSentinel (JevFirstCommitment) tests pass unchanged.
