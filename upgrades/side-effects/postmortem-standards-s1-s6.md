# Side-Effects Review — Six constitutional standards from the 2026-07-01 silent-message-loss postmortem

**Version / slug:** `postmortem-standards-s1-s6`
**Date:** `2026-07-01`
**Author:** `Echo (agent), operator-ratified by Justin (topic 29836)`
**Second-pass reviewer:** `not required (docs-only constitutional amendment; each entry operator-ratified verbatim by decision scope)`

## Summary of the change

Docs-only. Adds six operator-ratified standards to `docs/STANDARDS-REGISTRY.md`, each with its earned-from story per the registry's amendment loop ("proposed by the agent with its story, ratified by the operator" — ratification recorded 2026-07-01, topic 29836): **A Refusal Stays a Refusal** (Building), **Cross-Store Coherence Is an Invariant** (Building), **Test Identity Never Enters Production State** (Building), **A Dark Feature Guards Nothing** (Shipping), **Runtime End-to-End Proof** (Building), **Session Input Is a Principal** (Substrate, extends Know Your Principal). Also adds the in-repo postmortem the entries cite (`docs/postmortems/2026-07-01-silent-telegram-message-loss.md`). No source, config, template, hook, or test files are touched.

## Decision-point inventory

No runtime decision point is added, modified, removed, or passed through. The change is constitutional text. Two READ consumers gain input: the Standards-Conformance Gate and the conformance-coverage audit read this registry — both are signal-only surfaces (findings feed reviewers; nothing blocks). The new entries will be classified by the coverage audit as `spec-only`/`documented-only` until their named guards land upstream (the U1/U2/G3 tracked filings) — that classification is the honest, intended state and is exactly the gap-surfacing that audit exists to do.

---

## 1. Over-block

No block/allow surface — over-block not applicable. (The conformance gate that reads this registry is signal-only by the Signal vs. Authority standard; a new standard cannot block a spec.)

---

## 2. Under-block

No block/allow surface — under-block not applicable. The standards' enforcement arms (test ratchet on ack-mappings, registry-level fixture validation, dark-but-load-bearing classification, canary coverage tracking) land in tracked upstream work (fb-1e751537-655, fb-b15ac10b-85c, fb-dd043916-28f); until then the entries are deliberately prose-with-named-guards, and the coverage audit will report them as gaps rather than silently claiming enforcement.

---

## 3. Level of abstraction

Correct level: these are constitutional standards (family-level rules with earned-from stories), not operational runbooks. Each entry names its operational machinery in **Applied through** rather than embedding procedure. S6 extends an existing standard (Know Your Principal) rather than duplicating it; S2/S5 cross-reference their sibling standards (Verify the State Not Its Symbol; The User Experience Is the Product) rather than restating them.

## 4. Signal vs. authority

Compliant. The registry is read by signal-only surfaces (spec-converge conformance check, coverage audit). Nothing in this change grants any gate blocking authority.

## 5. Interactions with adjacent systems

- The Standards-Conformance Gate will start checking future specs against six more rules — intended effect; signal-only.
- The conformance-coverage audit (`/conformance/coverage`) will list six new standards, initially as documented-only gaps — intended gap-surfacing.
- The registry's own "Two layers" and amendment-loop sections are untouched; the entries follow the existing family structure (Substrate / Building / Shipping).

## 6. Rollback cost

Trivial: `git revert` of one commit removes both files cleanly. No config, no state, no migration, no deployed-agent impact.
