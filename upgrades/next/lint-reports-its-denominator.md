---
change_type: fix
---

<!-- internal-only -->

## What Changed

`scripts/lint-machine-local-justification.js` reports its population beside its verdict — specs scanned, specs carrying a posture section, and unreadable files — on the clean path, the findings path, and as `population` in `--json`. Unreadable files are counted rather than skipped silently.

Zero behaviour change: no verdict, threshold or exit code moves.

## Evidence

On 2026-08-21 this gate was found matching its section heading by exact text while authors had begun numbering theirs. It saw 91 of 149 posture-carrying specs, silently skipped 58 — including the replicated-store foundation, the mesh self-heal spec, the secure-pairing spec and the standards-registry spec — and printed `clean` about a corpus it had never read. Widening the matcher fixed that drift; this fixes the reading, which is the part that generalises to the next drift.

40 tests, including the property the incident turned on: a one-file run and a two-file run must not print the same sentence. Also pinned: the denominator on the FINDINGS path (where a shrunken population is most dangerous — a reader sees findings and assumes the sweep was whole), and an unreadable file counted rather than swallowed.

First live output: `135 finding(s) — 1818 spec(s) scanned, 133 carrying a posture section`.

## Known Limits

A denominator does not DETECT drift; it makes drift legible to a human reading the output. If nobody reads it, it buys nothing. An automated ratchet on the population would be the stronger control and is not built here.

The historical comment says 149 posture-carrying specs; this measures 133. **Drift is ruled out** — three independent methods (this lint, a peer's `git grep`, and a third regex pass) all return 133, including at `c465a94ef`, the widening commit itself, with the count unmoved across the two commits since. The population is not shrinking under the gate. What produced 149 remains unmeasured and no claim is made between the candidates.

No other gate in this repository was audited for the same defect, and nothing enumerates the gates that print a reassuring word with no scale.
