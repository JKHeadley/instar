# Convergence Report — Feature Maturation Discipline

## Cross-model review: codex-cli:gpt-5.5

Real GPT-tier and Gemini-tier external reviews ran. Codex completed every round; Gemini completed
rounds 2 and 3, timed out in the final round, and its earlier findings were incorporated.

## ELI10 Overview

New features often start turned off for safety. The failure is that “off for now” can quietly become
“off forever.” This design makes every staged feature write down a route from supervised testing,
to development use, to fleet use. The first shipped increment only warns when that plan is absent;
it deliberately gathers evidence before formatting mistakes can block development.

Instar already has rollout tracking, initiative tracking, live-test tooling, and a Maturation Path
standard. Review found that the draft would have duplicated the standard, so the converged design
strengthens that article in place and attaches each later arm to its named existing owner.

## Original vs Converged

The draft proposed a new constitutional standard and described a required-section gate as though it
would refuse convergence. The converged spec updates the existing Maturation Path article, makes v1
WARN-only, defines the exact three-class syntax, forbids per-agent allowlists, narrows the release
claim to warning visibility, and keeps D3/D4/D7 as named v2/v3 designs. It also replaces substring
customization detection with exact stock hashes and defines durable migration recovery.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|---|---|---:|---|
| 1 | D6 foundation audit, internal six-angle audit | 4 | Removed duplicate standard; clarified WARN honesty, accepted guard citations, adversarial parsing, and durable migration. Conformance gate unavailable: HTTP 403 invalid auth. |
| 2 | codex, gemini, internal audit | 6 | Added glossary, evidence schema, semantic-authority boundary, future scenario classes, dark-window policy, role and multi-machine boundaries. Conformance unavailable: HTTP 401. |
| 3 | codex, gemini | 5 | Narrowed v1 acceptance, added role/evidence constraints, corpus ratchet, and alternatives analysis. Conformance unavailable: HTTP 401. |
| 4 | codex; gemini degraded by timeout | 0 material | No body change. Remaining comments restated accepted operator constraints or future-arm risks already disclosed. Conformance unavailable: HTTP 401. |

## Full Findings Catalog

- **Duplicate standard (material, foundation audit):** D1 repeated the existing Maturation Path.
  Resolved by strengthening the existing article in place.
- **Guard classification (material, integration):** a skill-only citation would not be extracted.
  Resolved by citing a live `scripts/` guard and `tests/` ratchet under accepted prefixes.
- **Migration customization and recovery (material, adversarial/integration):** substring markers
  could overwrite custom files and “atomic” lacked a recovery contract. Resolved with stock hashes,
  symlink/root checks, durable backup/temp/fsync/rename/directory-sync, injected failure tests, and
  deterministic retry behavior.
- **WARN honesty and scope (material, decision completeness):** the draft implied v1 enforcement.
  Resolved by naming v1 maturation-plan warning visibility and explicitly stating that D4/D7 close
  the stuck-dark problem later.
- **Parser ambiguity (material, codex):** rows and labels were not exact. Resolved with canonical
  bullets, duplicate/quote/comment/fence resistance, and a pure exported seam. Markdown is retained
  because v1 mirrors existing spec-section gates and is WARN-only; corpus review precedes veto.
- **Evidence quality (material, codex):** soak samples and subjective authority were vague.
  Resolved with three required corpus cases, signed/digested evidence fields, replayable automated
  assertions as primary evidence, and independent review for risky subjective rows.
- **Role and machine authority (material, codex):** future runtime roles/state were treated as
  already unified. Resolved by limiting v1 to git artifacts, failing unknown roles fleet-disabled,
  requiring reuse of existing identity/apprenticeship owners, and requiring v2/v3 coherence audits.
- **Future anti-stale closure (material, gemini):** a notice alone could be ignored. Resolved by
  keeping dark-too-long active until advance, retirement, or owned re-plan and pairing D4's
  surfacing arm with D7's recurring driving arm.
- **Final-round minor comments:** requests to replace the operator-ratified three-rung ladder with
  equivalent rungs, pull v2/v3 runtime mechanics into v1, or choose schema storage immediately were
  not material. They conflict with approved scope or are explicitly guarded by the WARN corpus
  review and future foundation audits. Terminology comments are addressed by the glossary and ELI16.

## Convergence verdict

Converged at iteration 6. The final round produced no material new issue requiring a body change.
The constitutional gate was attempted every round but unavailable because local authentication was
not valid; this was signal-only and did not block convergence. The spec is operator-approved for
the v1 implementation scope.
