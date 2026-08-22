# Side-Effects Review — the posture gate could not see a numbered heading

**Version / slug:** `posture-gate-heading-blindspot`
**Date:** `2026-08-21`
**Author:** `echo`
**Second-pass reviewer:** `required (the word "gate" applies) — self-reviewed adversarially below, see §Second-pass`

## Summary of the change

`scripts/lint-machine-local-justification.js` locates the spec section it grades with a heading match. That match was EXACT (`/^#{1,6}\s+Multi-machine posture\b/`), so any spec whose heading carried an ordinal or qualifier had no locatable section at all — the spec read as "no posture section", rules A1/A3 never fired, and it passed CLEAN without ever being checked. Measured on this corpus: 91 of 129 posture-carrying specs were seen, and the 38 skipped include the replicated-store foundation, the mesh self-heal spec, the secure agent-pairing spec, the silent-loss conservation spec, the self-heal gate and the standards-registry spec itself.

The matcher becomes CONTAINMENT with a canonical-heading preference. A second defect, found by pointing the fixed gate at a real 196KB spec, is fixed alongside: a prose QUOTATION of a marker, wrapped so it begins a line, was read as a live out-of-section declaration (a false A3).

Files touched: `scripts/lint-machine-local-justification.js`, `tests/unit/lint-machine-local-justification.test.ts`, three new fixtures under `tests/fixtures/spec-lint/`.

## Decision-point inventory

- `lint-machine-local-justification` (Standard A marker floor) — **modify** — widens which specs the detector can see, and stops one class of false positive. No change to what it does once it sees a section.

This is a **detector**, not an authority. `skills/spec-converge/SKILL.md` states the split explicitly: "the `machine-local-justification` marker is the cheap deterministic signal; THIS reviewer holds the semantic authority." The change stays entirely on the detector side.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

The containment matcher can select a heading that merely *discusses* posture (e.g. `## Why the multi-machine posture check missed headings`) when a spec has no real posture section. That would grade a prose section as the posture section, and could emit a spurious A1 if that prose happens to contain the token `machine-local`.

**Measured rather than assumed:** of the 37 newly-visible specs, 2 matched on a non-canonical heading — `## Cross-Machine Coherence (multi-machine posture)` and `## 4. State and multi-machine posture` — and both are genuine posture sections. Zero false matches on discussion headings across the whole corpus.

Mitigations: (a) the canonical-heading preference means a spec carrying both a real section and an incidental heading resolves to the real one deterministically, not by document order; (b) the gate is report-first — a finding is exit 0 unless `--strict`, which is invoked nowhere.

The prose-quotation fix strictly REDUCES over-blocking: it removed a false A3 and, corpus-wide, dropped `A2-marker-outside-posture-section` from 1 to 0.

## 2. Under-block — what failure modes does this still miss?

- A spec that discusses posture only in prose with **no heading at all** is still invisible. 20 specs are in that state. This is deliberate and unchanged: the gate's own header says it "does NOT flag a spec that simply omits a posture section — §168's 'absence defaults to unified-required' is a semantic call the reviewer owns."
- A marker that is well-formed but **substantively wrong** is still passed. Also deliberate — correctness is the reviewer's authority, and the gate's header says so.
- A fully-backticked marker alone on its own line is still read as a declaration. That is intended (nothing follows the span), but it means a spec could quote a marker in a way that still trips A3 if the quotation is the entire line. Judged acceptable: that shape is indistinguishable from a declaration by construction, and erring toward *checking* is the correct direction here.

## 3. Level-of-abstraction fit

Correct layer. The alternative — teaching the spec-converge reviewer to find the section — moves deterministic text location into an LLM, which is the wrong direction. The section-finding belongs in the cheap deterministic layer; the semantic judgement stays with the reviewer.

Note that `scripts/generate-spec-contract.mjs` already tolerated a numeric ordinal in the same heading (`(?:\d+\.\s+)?`). Two tools reading the same heading disagreed about its shape; this closes that divergence in the stricter of the two.

## 4. Signal vs authority compliance

**Compliant, and the change does not move the boundary.** The lint is a detector producing findings; the spec-converge integration reviewer is the authority. No blocking power is added. `--strict` exists but is invoked by no workflow, package script or shell script — deliberately, per the SKILL's hard-sequencing note. The change makes the signal *more complete*, which is precisely what a detector improvement should do.

## 5. Interactions

- **Shadowing:** none. The reviewer's semantic posture check runs independently and reads whatever heading a human wrote; it was never affected by this blind spot. That is why declarations were still being reviewed — the human half worked, the automatic half did not.
- **Double-fire:** none. One finding per marker per rule; the quotation filter runs inside the single marker-parse loop.
- **Races / adjacent cleanup:** none. The script is a pure read over files passed on argv.
- **Newly surfaced findings:** the corpus goes from 71 to 90 findings, 20 of them newly visible. Because the gate is report-only and unwired, this changes no build outcome today. It WILL matter at graduation — see §8.

## 6. External surfaces

No runtime surface. Nothing in `src/` changes; no route, hook, job, template or config is touched. Nothing is visible to other agents, other users or other systems. No timing or conversation-state dependence.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN — and it carries no durable state at all.** This is a stateless CLI lint over files in the repo checkout, invoked per-run with paths on argv. It writes nothing, persists nothing, and generates no URLs or user-facing notices. There is no state to replicate, nothing to strand on topic transfer, and no read to merge. Every machine running it against the same checkout gets the same answer, because the answer is a pure function of the file bytes.

No `machine-local-justification` marker is declared, because this is not a machine-local *surface* — it is a stateless function with no locality at all. (Declaring `hardware-bound-resource` here would be the exact substantively-wrong-key mistake this very lint exists to catch.)

## 8. Rollback cost

**Near-zero.** Revert the commit; the matcher returns to the exact-match form and the gate returns to seeing 91 specs. No migration, no data, no agent state, no release required — the script is not shipped to agents and is not invoked by CI.

The one thing to know before graduating this gate to `--strict`: it now reports 90 findings across 85 specs, where the pre-change matcher reported 71. Turning `--strict` on without triaging that backlog would fail the build. That decision is tracked as **ACT-102** (the graduation call for this lint and three siblings), and it is the operator's, not mine. Three constitutional standards currently cite one of those four lints as their guard.

## Second-pass

The high-risk list includes "anything with the word … 'gate' … in it", so a second pass is required. The specific violation a second pass exists to catch is *brittle logic holding blocking authority*. Audited against that:

- The logic IS brittle (a regex over headings). That is acceptable **only** because it holds no authority — verified two ways: the script's default exit is 0 on findings, and `--strict` appears in no workflow, package script or shell script in the repo (independently documented in `docs/audits/phase-b/for-operator-enforcing-mode-never-invoked.md`).
- The change widens recall and narrows false positives. Both directions move the detector toward reporting the true state, which is the correct direction for a signal.
- The risk that a *future* graduation gives this brittle logic blocking authority is real, and is the reason §8 names the 90-finding backlog explicitly rather than leaving graduation to look free.

**Concur with the review**, with the §8 condition recorded: graduation is gated on triaging the backlog this change makes visible, and that is ACT-102's decision to make.
