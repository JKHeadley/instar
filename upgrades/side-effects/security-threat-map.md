# Side-Effects Review — docs/security/threat-map.md (Instar threat map)

## Summary of the change
Adds one documentation file, `docs/security/threat-map.md`, the attack-surface inventory for Instar's standing security program (operator, topic 141385, 2026-11-15). Ranks 12 areas by blast radius, names for each who reaches it, what authenticates it, existing controls, and what a reviewer checks, and states the public-repo disclosure rule (class-level only for unfixed issues). Plus its ELI16 companion. Tier 1, docs only, no runtime surface.

## Decision-point inventory
None. A documentation file; it makes no runtime decision.

## 1. Over-block / 2. Under-block
Not applicable (no gate).

## 3. Level-of-abstraction fit
A docs/security/ document, the natural home for a security overview; it complements SECURITY.md (which is the reporting policy).

## 4. Signal vs authority compliance
No authority; descriptive only.

## 5. Interactions
The recurring `security-review` job reads this file to choose which areas to review each pass. No code imports it.

## 6. External surfaces
Adds public documentation to a public repo. Written at class level: it names no specific unfixed vulnerability, only the shape of each area and what to check, per the disclosure rule stated in the file.

## 6b. Operator-surface quality
Not applicable.

## 7. Multi-machine posture
Not applicable: a document in the source repository, identical on every install.

## 8. Rollback cost
Revert the commit.

## Conclusion
Documentation of the security program's attack-surface map; no runtime effect. The one judgment was keeping every area description at class level so the public file hints at no unfixed weakness.

## Second-pass review
Not required (no gate, sentinel or runtime decision).

## Evidence pointers
- Built from a code read of the HTTP auth surface, the Threadline/A2A and mesh surfaces, and the inbound/execution paths (security program, 2026-11-15).
- Reviewed against the disclosure rule before commit: no area description names a specific unfixed finding.
