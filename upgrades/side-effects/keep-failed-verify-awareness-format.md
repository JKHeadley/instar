# Side-Effects Review — Awareness Entry Format

## Summary
This Tier 1 correction adds the required front-matter delimiters to the new awareness entry. The complete retention implementation is unchanged. The malformed entry caused the awareness registry to report an error to migration consumers.

## Decision Points
No authority or runtime decision changes. This restores the existing deterministic file-format contract.

## Over-block
No new rejection rule. The entry now satisfies the existing registry parser.

## Under-block
The existing shipped-entry registry test verifies all entries. The direct reproduction failed before this correction and passed afterward.

## Layer
This corrects the authored data at its source, rather than relaxing its parser or migration checks.

## Signal versus Authority
See docs/signal-vs-authority.md. This is an existing enumerable format invariant, with no new gate or blocking authority.

## Judgment
No new heuristic or judgment point.

## Interactions
The awareness registry and all instruction-document migration consumers read the corrected entry. The retention implementation and its independent review remain unchanged.

## External Surfaces
The same agent-awareness text now renders correctly. No API, credential, or message-delivery behavior changes.

## Multi-Machine Posture
The existing packaged awareness loader installs the same entry on new and updated agents.

## Rollback
Revert the correction only together with removing the invalid entry. Reverting just its delimiters would restore the original error.

## Review and Evidence
Format-only correction checked against src/data/awareness/README.md. Separate independent review is not required for this correction. The earlier production-code review remains recorded in its unchanged original artifact.

Direct red reproduction: three failures across the registry and migration-consumer tests. Corrected result:185 tests passed across four files, including the retention checks. Complete normal LocalVerify remains pending.

## Class-Closure Declaration
defectClass: prompt-parser-contract-drift. closure: guard. Enforcement: ratchet. Citation: tests/unit/awareness-entry-registry.test.ts. The existing test rejects any shipped awareness file that its parser cannot render, including the missing front matter in this defect.
