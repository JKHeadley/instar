# W3.8 live-artifact closure — plain-English overview

> The one-line version: a reusable execution artifact now proves that its visible result fields still match the signed observation that created it, while the report says plainly that canonical-main authority is not live until both required files are merged there.

## The problem in one breath

W3.7 correctly authenticated the structured test observation used by the immediate standards-measurement path, but its reusable artifact carried convenient copies of the test totals and failure classification. Those copies were mutable, and the exported validator did not recompute the artifact address or compare every copy back to the signed observation. Separately, test fixtures demonstrated the future protected-digest mechanism even though canonical main did not yet contain the protected runner or verdict ledger, leaving room for a reader to mistake a prospective mechanism for an operating one.

## What already exists

- **Protected execution runner** — a content-addressed Node test collector whose signed structured observation is linked to an authenticated child-exit receipt.
- **Three-run discrimination** — clean, deliberately violated, and pristine-confirmation executions distinguish a meaningful check from a hollow or stateful one.
- **Canonical snapshot resolver** — production measurement reads a content-addressed merge base derived from the server-advertised canonical main, never candidate-authored tracking state.

## What this adds

The returned artifact is recursively frozen, including its nested copied records. Reusable validation recomputes the artifact SHA-256 and rechecks all five copied observation fields—tests run, passed, failed, assertion failures, and deciding output—for each of the clean, mutated, and confirmation runs. It also retains the existing event, receipt, session, sequence, signature, process, and argv links.

The measurement record now carries an explicit execution-authority state. Test fixtures say they are stand-ins. A canonical snapshot says “operational” only when the admitted runner bytes are present and a structurally valid schema-v3 verdict record binds their exact SHA-256. Missing, malformed, empty, or mismatched inputs remain prospective, and the command-line report prints that state in plain language.

## The safeguards

**Prevents post-construction drift.** Recursive freezing stops a caller from changing nested copied totals or classifications after the artifact is minted.

**Prevents a new address from laundering a forged copy.** Even if an attacker clones the artifact, changes one copied field, recomputes the outer address, and freezes the result, validation compares the copy to the signed observation and rejects it.

**Prevents prospective evidence from reading as live authority.** The production record names both missing canonical admissions and refuses to call the protection operational until the runner and a valid digest-binding ledger record are actually present on canonical main.

## What ships when

This PR ships the validator closure and the explicit prospective-state record. It does not add the runner or verdict ledger to canonical main and does not make that merge decision. Operational authority begins only when a later admitted canonical state contains both required artifacts in the validated form.

## What you actually need to decide

Does this PR accurately close the reusable-artifact integrity gap and make the current prospective authority boundary impossible to misread, without claiming that canonical main has already admitted the protected inputs?
