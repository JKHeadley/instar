# Convergence Report — Account safety and development releases

## Cross-model review

A real external codex-cli gpt-6-astra pass was invoked through cross-model-review.mjs. The first pass timed out after 180 seconds and is **degraded**, not a clean external opinion. Gemini was detected inactive (not authenticated); no Gemini verdict is claimed. The final revised body was retried with a 120-second bound and also timed out. External posture is degraded-all-rounds; no external clean verdict is claimed.

## ELI10 Overview

Echo offered too little help with an account task, then took a risky shortcut when asked to do it itself. It used a backup code after reading only the start of a warning page, suspending npm publishing for three days. This change helps agents offer useful safe work and makes account warnings harder to miss. The browser reads the full visible page for risk observations, supplies every page chunk, and makes the agent explicitly review a flagged current page before continuing. That review is the agent's judgment, not user approval to use recovery codes. Recovery still needs specific informed user consent.

During the npm hold, development packages can be published on GitHub and explicitly installed on development/test agents. The installer uses the same native checks and safe replacement path as normal updates. It verifies the checksum before npm reads the package, records the target agent's actual prior version, and retains a published stable rollback target. The next normal npm patch supersedes the development build.

## Original vs Converged

- Hidden recovery dialogs initially interrupted ordinary sign-in; visible-only control inspection fixes that.
- A full-page read initially lacked content identity; fingerprints now detect changing pages across chunks.
- Initial generic regex veto followed an outdated architectural document. Independent lessons-aware review found the stricter canonical registry. The final design surfaces an advisory and gives the session agent full-context judgment and explicit reviewed continuation.
- Release review found real npm pack JSON exceeded the default 1 MiB process buffer; capture is now bounded at 64 MiB.
- The external installer initially reported checkout version as prior agent version; it now reads the target shadow and aligns native rebuilding with the target Node runtime.
- Repeated dev installs could make rollback request an unpublished version; it now targets the prior published stable base. Packaging requires source version equal npm stable.

## Iteration Summary

| Round | Review | DESIGN findings | Resolution |
|---|---|---:|---|
| 1 | independent safety and release agents; conformance gate; external CLI | 7 | hidden forms, fingerprint, mandate wording, pack output buffer, target prior version/runtime, stable rollback base |
| 2 | consolidated security/adversarial/scalability/integration/decision-completeness/lessons review | 1 | canonical registry disallows regex veto; redesigned as advisory plus agent judgment |
| 3 | independent consolidated final review | 0 | DESIGN 0, PRECISION 0; convergence recommended |

Standards-Conformance Gate: ran, checked 97 standards, 2 advisory flags (Signal vs Authority and Judgment Within Floors). Those flags led to the round-2 design correction; they were not waived on the basis of the legacy exception. Initial path-based attempt returned HTTP400; the markdown-based request succeeded.

## Full Findings Catalog

Each design finding listed above is resolved in code/spec and covered by tests or explicit structural packaging checks. The independently reviewed release pipeline uses real npm installation and a real native SQLite query, not an install-result mock. Browser tests execute the installed wrapper against page fixtures. Migration and fresh initialization tests cover delivery to existing and new agents.

## Fixed-limit contest

The independent reviewer cleared 6000-character output pagination (all remaining text is available), exact digest/source/version shapes (structural protocol constraints), and the 64 MiB JSON capture limit (resource failure is visible, never silently truncated). No action-count or behavioral throttle was added. Machine-local native shadow installations are hardware-bound; artifacts and policy source are shared.

## Decision completeness and lessons

Four frontloaded decisions: browser judgment mechanism, explicit release opt-in, artifact admission, stable return. Cheap-tags 0, contested-rejected 0, open-user-decisions 0. Applicable principles/lessons are cited in spec frontmatter. Canonical principles-and-lessons catalog reviewed; docs/EVOLUTION-LOG.md is absent. User authorization is the explicit topic instruction to build both and merge green; no constitution edits are proposed.

## Left behind

No unresolved design or precision findings. Residual limitations are explicit product boundaries: top-level visible DOM detection is not universal browser mediation, an agent review is not operator consent, GitHub provenance must be trusted, and public dependency installation must remain available.

## Convergence verdict

Converged at round 3 based on independent final review: DESIGN 0, PRECISION 0, no unresolved user decisions. External review posture is disclosed separately and is not substituted with an internal clean verdict.
