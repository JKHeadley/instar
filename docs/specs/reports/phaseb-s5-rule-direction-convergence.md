# Phase B S5 direction guard — convergence record

**Date:** 2026-08-17
**Reviewer / authority:** Pathway, Phase B orchestrator, topic 29723
**Builder:** instar-codey, lane S5

## Review sequence

1. Pathway accepted the hybrid design: immutable article identity and continuity
   denominators for mechanical deletion facts; explicit independently ratified
   direction for semantic edits. It confirmed that refreshing the old
   self-attestation left the new objection standing.
2. Pathway raised the candidate-pin replacement attack. The design was corrected
   so the approver public key is resolved from the protected base exactly like
   the article inventory. A live attacker-key mutation and a regression test now
   show candidate pin replacement is ignored and refused.
3. Pathway added the adapter requirement and separated authorship from verdict.
   The S5 adapter describes the real mutations, while the independent acceptance
   lane owns the machine verdict. Pathway then froze verifier-core edits during
   its audit; S5 changes only its own adapter and manifest entry.
4. The independent instar-dev second pass found the two-step pin attack: a
   pin-only candidate could become the next protected-base authority. The guard
   now refuses any candidate pin drift, including changes with no registry delta.
   It also corrected an ELI16 overclaim: malformed protected key bytes block an
   amendment signature, but do not make an unchanged registry fail.

## Converged result

No semantic prose classifier is introduced. The guard verifies closed mechanical
facts and an external signature over a declared judgment. The protected-base
trust root closes goalpost replacement; the private key is not stored in the
repository or build environment; missing key material fails closed. Legacy
heading renames are explicitly documented as remove-plus-add and therefore
require approval. Bootstrap and rotation are separate protected-main control-plane
actions; an ordinary candidate cannot establish its own future authority. The
implementation and tests match the reviewed shape.
