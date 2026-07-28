# Side effects — spec round 10 (scanState vs row presence)

- **No code changes in this PR.** Spec text only; the feature is dark on every install.
- **Downstream obligation created:** the Increment-2 route (merged behavior) currently returns zero
  rows on a machine that has never scanned. Once this amendment lands, that behavior contradicts the
  spec and must be fixed — tracked for Increment 3, with the failing input stated in the spec so the
  fix is verifiable rather than asserted.
- **Risk if NOT amended:** on any machine whose doorway-scan job is disabled (the shipped default),
  the read surface would report nothing while holding a catalog it had already derived — the exact
  "empty reads as unknown" conflation the three-way `scanState` exists to prevent.
- **Rollback:** revert the spec paragraph; no deployed behavior changes either way.
- **Provenance note:** this ambiguity was mine as the converging reviewer, not a build defect — the
  implementation followed the spec as written. Recorded so the review history stays honest.
