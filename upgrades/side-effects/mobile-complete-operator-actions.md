# Side-Effects Review — Constitution: Mobile-Complete Operator Actions

**Version / slug:** `mobile-complete-operator-actions`
**Date:** `2026-06-12`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `not required (documentation + review-template change; no runtime surface, no decision points)`

## Summary of the change

Adds the operator-ratified **Mobile-Complete Operator Actions** standard to `docs/STANDARDS-REGISTRY.md` (Interaction section) and its review-time enforcement hook: an operator-surface bullet in the side-effects template's question 6 (`skills/instar-dev/templates/side-effects-artifact.md`). Earned from the 2026-06-12 floor-grant incident; ratified by operator directive (Justin, topic 22367). No runtime code changes.

## Decision-point inventory

No decision points touched. The registry is read by the spec-review conformance gate and the standards-enforcement auditor — both observe/classify; neither gains new blocking logic from this entry. The template change adds a QUESTION future authors must answer in writing; the pre-commit hook's artifact checks are unchanged (it verifies artifact existence/coverage, not per-question structure).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Nothing is blocked by this change. The new template question could be answered "No operator-facing actions" by any change without one — no legitimate change gains friction beyond one written sentence. No issue identified.

## 2. Under-block

**What failure modes does this still miss?**

The standard's enforcement is review-time prose (the template question) — an author can answer it wrongly and ship an API-only operator action anyway; the conformance audit will classify this standard as `spec-only` strength until a structural ratchet exists (the named candidate: a UI-surface map for PIN-class routes). That gap is the Standards Enforcement Coverage system working as designed — it surfaces which standards are wishes — and the registry entry names the intended ratchet honestly rather than claiming structural enforcement it doesn't have.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The 2026-06-12 incident proved a gate alone is the wrong layer: the outbound advisory fired and the substance still shipped laptop-bound. A constitutional entry is the layer that states substance; gates and ratchets grow toward it (and the spec-review conformance gate starts checking drafts against it immediately, since it reads the registry).

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic?**

No blocking authority is added anywhere. Reference reviewed: `docs/signal-vs-authority.md`. No issue identified.

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, race with adjacent cleanup?**

- Registry parsers verified green against the new entry: `standards-enforcement-auditor` (including the zero-dangling-refs canary — every guard the entry cites must exist on disk, which is why this PR lands AFTER the grant-form PR that contains `GET /permissions/users`), `standards-conformance-gate`, and the pre-commit deferral scan (the entry's known-open generalization carries a `tracked:` marker).
- The entry sits beside "No Manual Work (user *or* agent)" as a sibling, not a duplicate: that standard says interactions must be automatic/channel-borne; this one pins the DEVICE bar for the human half of those interactions.

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- The registry is read by the spec-review conformance gate, the runtime Usher, and the standards-enforcement auditor — all gain one more standard to surface/classify. That is the intended effect.
- The template change reaches future instar authors only (the template is copied at artifact-writing time; existing artifacts are untouched).
- **Operator surface (the new question, answered for this change itself):** this change adds no operator-facing actions. The standard it documents was applied to the incident's own surface in PR #1082.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Revert the docs commit. No state, no migrations, no runtime behavior. The conformance gate simply stops checking drafts against the entry. Trivial rollback.

---

## Second-pass review

Not required — documentation + review-template change with no runtime surface or decision points (per the skill's Phase 5 trigger list). The artifact's "documentation-level impact" conclusion is the valid outcome the skill explicitly names for this class of change.
