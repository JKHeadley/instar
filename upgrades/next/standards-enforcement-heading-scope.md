<!-- bump: patch -->

## What Changed

The standards enforcement auditor now reads complete blocks under a closed set of
guard-naming headings, including `Enforced by (structure, not willpower)` and
`Full spec(s)`. It explicitly excludes provenance headings and publishes every
unrecognized article heading in `registry.enforcementScope` instead of silently
treating unread content as an absent guard. CI now holds that unknown-heading count at
zero and holds the improved named-reference ratio at a 0.70 floor.

## What to Tell Your User

- **The standards gap list is more accurate:** “The auditor can now see guards named under the registry’s alternate enforcement headings without counting postmortems as protection.”
- **Its reading boundary is visible:** “The coverage response says which headings it accepts, excludes, and did not recognize.”

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Inspect the parser trust boundary | Read `summary.registry.enforcementScope` from the conformance coverage report |
| Find unclassified registry sections | Review `enforcementScope.unrecognizedSections` |
| Audit alternate enforcement headings | Use `Enforced by (structure, not willpower)`, `Enforcement`, or `Full spec(s)` in a standards article |
| Prevent parser drift | The CI parser/library parity test and zero-unknown ceiling run automatically |

## Evidence

Parser-to-extractor tests prove multiline enforcement blocks are retained while
guard-shaped paths in provenance and unknown sections stay excluded. Real-registry
tests prove the four corrected classifications, zero dangling refs, and the exact
82-standard result: 17 gaps and a 0.7073 named-reference resolution ratio.
