<!-- internal-only -->

## What Changed

Added `scripts/generate-spec-contract.mjs` — a build-time generator that emits
`docs/specs/generated/<slug>.contract.md` from a spec: the normative sections
only, with review-history sections and inline round-annotations stripped.

**Why.** A spec that honestly records its review accumulates change logs
describing designs that were later *reversed*. On
`outbound-gate-advisory-override` (33 review rounds), both external reviewers —
`codex-cli:gpt-5.5` and `gemini-cli:gemini-3.1-pro-preview` — independently
identified the same risk and proposed the same fix: an implementer reading the
document top-to-bottom can follow a retired design, so publish the contract
separately from the history.

`--check` fails the build when the committed contract does not match a fresh
generation, so the history cannot drift back into the contract over time.

The transform is deliberately mechanical — heading shapes mark history,
everything else is contract. A generator that had to *understand* the document
would drift out of step with it exactly as the document drifted out of step with
itself.

No runtime surface: no `src/` change, nothing installed to agent homes, no hook,
job or template references it. Nothing at runtime reads a spec.

## Evidence

- Generated against the real 2,700-line spec: **36 history sections excluded,
  37% smaller output**.
- `--check` verified in both directions: exits 0 on a current contract, exits 1
  with a regenerate message on a stale one.
- A regex leak was found and fixed during verification — `## 24. Round-11
  external change log` was initially retained, because the heading text between
  `Round-11` and `change log` was not matched. Caught by inspecting the generated
  headings rather than trusting the run.
- Determinism confirmed by construction: no timestamps, no randomness, no
  environment reads beyond the input path — which is what makes `--check` usable
  in CI at all.
- Side-effects review: `upgrades/side-effects/spec-contract-generator.md`
  (Tier 1; no decision point, no blocking authority, rollback is deleting two
  files).
