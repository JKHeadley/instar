<!-- internal-only -->
<!-- bump: patch -->

## What Changed

`scripts/lint-machine-local-justification.js` — the deterministic marker floor for the multi-machine posture standard — located its section with an EXACT heading match, so any spec whose heading carried an ordinal or qualifier had no locatable section at all. The spec read as "no posture section", rules A1/A3 never fired, and it passed CLEAN without ever being checked.

Measured on this corpus: 91 of 129 posture-carrying specs were seen. The 38 skipped include the replicated-store foundation, the mesh self-heal spec, the secure agent-pairing spec, the silent-loss conservation spec, the self-heal gate and the standards-registry spec itself. Nobody had to make a mistake for this to happen — you only had to number your heading.

The matcher is now CONTAINMENT with a canonical-heading preference, covering every shape present in the corpus: bare, numeric ordinal (`8.`, `8.2`), section-mark ordinal (`§4.`), letter ordinal (`D.`), the phrase mid-title, and the phrase parenthesised. A first pass allowing only a numeric ordinal was not enough — a re-sweep found the other four shapes still invisible.

A second defect is fixed alongside, found by pointing the repaired gate at a real 196KB spec: a correction-heavy spec QUOTES markers, and ordinary paragraph wrapping puts the quotation at line-start where it read as a live out-of-section declaration (a false A3). The discriminator is the closing backtick — a declaration is the line's content; a quotation closes its span and continues into prose. No fixture had ever contained a spec that talks *about* markers.

This is a DETECTOR change and stays one. `skills/spec-converge/SKILL.md` names the split: the marker is "the cheap deterministic signal", the integration reviewer "holds the semantic authority". No blocking power is added, and `--strict` is invoked by no workflow, package script or shell script — so this removes a hole the gate would otherwise have graduated WITH, rather than fixing an active incident.

## Evidence

- Corpus effect: 91 → 129 specs actually checked; zero specs carrying a posture heading remain invisible. The remaining 20 mention the phrase only in prose with no heading, which is genuinely outside this gate's scope.
- Over-match risk measured rather than assumed: of 37 newly-visible specs, 2 matched on a non-canonical heading (`## Cross-Machine Coherence (multi-machine posture)`, `## 4. State and multi-machine posture`) and both are genuine posture sections. Zero false matches corpus-wide.
- The blind spot was verified by deleting the posture declaration from a numbered spec outright and running the gate: it passed clean.
- Tests: 20 passing, covering every heading shape found in the corpus, the prose-quotation case, and a guard proving the quotation fix did not open a hole for a genuine out-of-section declaration. The pre-existing tests all used the plain unnumbered heading, which is exactly why none of them caught this.
- Full unit suite green on the branch this was split from: 42,597 passing, 0 failures.

## Follow-up

Graduation of this gate to `--strict` now has to triage 90 findings across 85 specs, where the old matcher reported 71. That decision — for this lint and three siblings whose enforcing mode is invoked nowhere — is tracked as ACT-102 and belongs to the operator. Three constitutional standards currently cite one of those four lints as their guard. <!-- tracked: ACT-102 -->
