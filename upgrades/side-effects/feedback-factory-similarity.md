# Side-Effects Review — feedback-factory similarity primitives (Phase 1, increment 2)

**Slug:** `feedback-factory-similarity`
**Date:** `2026-05-26`
**Author:** Echo
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26)
**Scope:** The fuzzy title-similarity primitives — `_tokenize` (:1389) and `_jaccard_similarity` (:1394) of the reference processor — which sit on top of the exact-match fingerprint (increment 1) and underpin scar (c)'s false-merge guard. The threshold-application/clustering driver and the other scars are subsequent increments.

## Summary of the change

Ports `_tokenize` + `_jaccard_similarity` from `the-portal/.claude/scripts/feedback-processor.py` to `src/feedback-factory/processor/similarity.ts`. Pure functions, no I/O. **Not wired into any route/job yet** — no behavioral change. Adds the similarity parity harness (`scripts/feedback-factory/similarity-parity.mjs` + `_py_similarity_ref.py` + `similarity-corpus.json`) and Tier-1 unit tests.

## Equivalence verification

- **20/20 title pairs match the reference Python** — both the raw similarity value (1e-12 tolerance for float-string serialization only; the math is bit-identical IEEE-754 division) AND the threshold decisions (`≥0.55` fixed-merge, `≥0.35` merge, else no-merge), which are what actually drive clustering.
- The tokenizer is ASCII-only in the reference (`re.findall(r'[a-z0-9]+', text.lower())`), so the JS port uses the identical ASCII class `/[a-z0-9]+/g` (no `u`, no `i`). Non-ASCII letters and Unicode digits are separators in both — verified by corpus entries (café→{caf}, arabic digits dropped, Straße→{stra,e}).

## Seven-dimension review

1. **Over/under-reach** — Pure deterministic functions, no I/O, no global state, not imported by any runtime path. Cannot affect existing behavior. Risk is equivalence-to-reference, addressed above.
2. **Level-of-abstraction fit** — Processor-logic layer (`src/feedback-factory/processor/`), alongside the fingerprint port. Correct home.
3. **Signal vs Authority** — N/A; pure computation. The threshold constants that turn a similarity score into a merge decision live in the (later) clustering driver, where the curated-lifecycle authority also lives.
4. **Interactions** — None. New isolated module; nothing imports it yet. Parity scripts are LOCAL-only (external reference path via `PORTAL_PROCESSOR`), no CI dependency on the reference checkout.
5. **Rollback cost** — Trivial: delete the module + tests + scripts. No data, no migration, no wiring.
6. **Migration parity** — N/A. New internal library code; touches no agent-installed file.
7. **Failure modes** — (a) Port diverges from reference → caught by the parity harness (20/20) + golden-shaped unit assertions in CI. (b) Float boundary divergence at exactly 0.35/0.55 → mitigated by identical IEEE-754 division + the parity harness asserting threshold DECISIONS, not just values. (c) Reference path absent → harness exits 2 with a clear message (local gate, not CI).

## Tests

- Tier-1 unit (CI): `tests/unit/feedback-factory/similarity.test.ts` — `tokenize` (lowercase/split/dedup, ASCII-only behavior, empty/punctuation), `jaccardSimilarity` (identical=1.0, disjoint=0.0, empty-guard=0.0, exact ∩/∪ ratios, threshold ordering). 8 tests.
- Parity (local gate, evidence): `scripts/feedback-factory/similarity-parity.mjs` → **20/20** values + threshold decisions identical to the reference Python.
- No integration/E2E this increment: not yet wired to a route/job; those tiers attach when the clustering driver + receiver land. Reasoned decision, documented.
