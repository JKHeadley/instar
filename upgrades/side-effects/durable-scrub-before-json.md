# Scrub structured capture before JSON encoding

## Scope

This repair applies the existing durable credential scrubber to raw string fields before deep judgment context, job completion assessments, and script supervisor prompt input are encoded. These paths keep their existing storage and delivery formats and ownership. This change adds no blocking authority, feature flag, network access, dependency, or migration.

## Effects

- The affected fields may contain redaction markers where they previously contained credential-shaped text. Structured fields named for a credential have their string values replaced.
- Cyclic or excessively nested values become a fixed marker at the affected point.
- Judgment and completion data remain local under their existing retention and projection policies. Script supervisor input still goes through its existing model route, and its result log still records the result.
- The same code runs on each machine. There is no new cross-machine transfer or state to reconcile.
- Roll back by reverting the source change. Rolling back would restore the original serialization order, so retain existing operational holds until equivalent scrub behavior is restored.

## Verification

Synthetic labelled JSON and multiline private key blocks exercise both durable write paths and the outbound prompt. The checks also confirm that the field label survives while the synthetic value is masked.

Stop replay capture now masks private key blocks. Supervisor output is scrubbed before its length limit, and the existing supervisor patterns also run on raw strings.

## Release Note Review

The release note now describes the effect for people reviewing saved judgment and job diagnostics. The correction removes the internal-only classification and pairs the new note with this review. Pipeline Strategy concurred on the previous note-only commit `f8102767` in receipt `e1883976`. The wording now names the saved surfaces more precisely. Source and tests are unchanged from the prior independent and Chief reviews `251cb8af` and `8c3625a0`.
