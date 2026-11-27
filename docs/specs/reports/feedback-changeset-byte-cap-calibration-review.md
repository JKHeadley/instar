# Feedback change set cap: review record

2026-11-04. Review of `docs/specs/feedback-changeset-byte-cap-calibration.md` against main `0aa1391fdd7da425e1fe2e59b6c022830fc19069`.

## Evidence and disposition

The measured source pair is 4,356,054 bytes, above the 4 MiB ceiling before tests. This proves the existing gate mechanically rejects any fix changing both files. The rejected worker's total bytes were not recorded; 5 MiB is an eligibility calibration, not proof that its candidate would pass.

Standards-Conformance Gate ran on the draft: 94 standards checked, zero findings, registry canary passed. Internal decision-completeness, integration and security reviewers read the draft independently. The decision reviewer confirmed the measurement and identified stale parent-spec wording. The integration reviewer found no other 4 MiB transfer cap and warned that the failed attempt cannot be resurrected. The security reviewer identified opaque binary content that a PR diff might omit. Revision added an over-4 MiB UTF-8/NUL text condition, amended the parent spec and comments, and added boundary tests. Integration and security second passes found no blocking design issue; their two missing test boundaries (invalid UTF-8 and exactly 4 MiB binary) and the inaccurate decision-point sentence were corrected.

This is a narrow, reversible Tier 1 change. The spec and plain-English explanation are staged as supporting design records; no `approved: true` or convergence tag is asserted. The PR and exact-head verification remain publication gates.
