# Side-effects review — registry field classification for the Window-12 rulings

**Change.** Five new bold field headings appear in `docs/STANDARDS-REGISTRY.md` as a result of the
operator's 2026-08-12 rulings on the Window-12 decision package. Two closed classification lists —
one in `src/core/StandardsRegistryParser.ts`, one hand-mirrored in `scripts/standards-coverage.mjs`
— are extended so those headings are deliberately classified rather than counted unrecognized.

- `Grounded in`, `Articulated during`, `Ratified from operator policy`, `Provenance status` →
  **PROVENANCE** (rulings 4b/4c: an article that never had an incident stops claiming one).
- `Fails` → **NARRATIVE** (item 2: an article states which way it fails when its machinery is absent).

**Tier declared: 1.** The gate's size signal suggested 2 (46 LOC, 2 files); the risk floor is 1 and
most of that LOC is the comments explaining each classification. This adds no decision logic, no new
authority, and no runtime branch — it extends two enumerations so an existing scanner recognizes
headings that already exist in the document it scans. The substantive change in this commit is the
constitution text itself, and its authorization is the operator's recorded ruling set
(`.instar/decision-package-rulings.md`) plus the committed ruling-to-change matrix, not a spec.

---

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

Nothing is rejected. Both lists are *exclusion* sets: membership removes a section from enforcement
extraction. Adding a heading can only narrow what is scanned, never widen what is refused. The one
blocking surface involved — the ratchet's `unrecognized-sections <= 0` ceiling — becomes *less*
likely to fire, and only for headings that now have a stated classification.

## 2. Under-block — what failure modes does this still miss?

Two, both named rather than fixed here.

- **A misclassification is not detectable by these lists.** If a future heading that genuinely names
  a guard were filed as NARRATIVE, its refs would silently stop being scanned and the article could
  read as unenforced (or, worse, an enforcement claim could go unverified). The lists record intent;
  nothing checks that the intent matches the heading's content. The mitigation available today is
  that adding a heading is a reviewed diff — the same mitigation the exact-match enumerated list
  relies on, and the same limitation.
- **The duplication itself.** The two lists are hand-kept mirrors. Updating one and not the other is
  silent in one direction (parser classifies, ratchet counts unrecognized → caught by CI) and would
  be silent in the *other* direction too (ratchet classifies, parser reports an unrecognized role →
  a diagnostic warning, not a failure). This change was caught by the first direction. See §5.

## 3. Level-of-abstraction fit

Right layer, with a known wart. The classification belongs where the parse happens, and it is there.
The wart is that "where the parse happens" is two places: `StandardsRegistryParser.ts` is the
authority, and `standards-coverage.mjs` carries a self-contained copy because it runs pre-compile as
a plain `.mjs` script and cannot import the TypeScript module. That is a real constraint, not
laziness — but it means the registry's *own* rule about canonical migrations (every consumer must
read the new authority) is violated by the tooling that measures the registry. Recorded in a comment
at the mirror site, where the next person editing it will meet it.

## 4. Signal vs. authority compliance

Compliant, and in the conservative direction. `docs/signal-vs-authority.md` forbids brittle logic
holding blocking authority. This change:

- adds **no** blocking authority — the only authority in the area (the unrecognized-section ceiling)
  is untouched and still blocks;
- moves headings *out* of the enforcement-scanning path, which is the direction that prevents a
  false claim rather than creating one. Specifically, `Fails` describes what should happen when a
  guard is **missing** — the opposite of evidence that a guard exists. Filing it as enforcement
  would let an article's account of its own absence flip it to "enforced," which is exactly the
  over-claim the existing `Documented-only until` classification was added to prevent. The four
  provenance headings are the same shape: an origin story is not a live check.

## 5. Interactions

- **The ratchet caught this change's own defect**, which is the interaction worth recording. The
  parser was updated first; the ratchet's mirror was not, and `standards-coverage.mjs` reported 62
  unrecognized sections against a zero ceiling (54 `Fails` + 8 provenance instances — the arithmetic
  matches exactly). The gate did its job on the author.
- `lint-no-duplicate-definitions`, `lint-registry-tree-parentage`, `generate-standards-hierarchy`
  and `lint-documented-only-countdown` all parse the registry and all pass unchanged: the article
  count stays 87, no heading is renamed, and no declared relation is touched.
- `enforced-ratio` is unchanged at 0.7356 before and after — verified by stashing the change and
  re-running. A classification change that moved the enforcement ratio would mean it had leaked into
  enforcement extraction, so that equality is the check, not a coincidence.

## 6. External surfaces

None. No route, no message, no config, no agent-visible behavior. The registry text changes are
visible to any agent that reads the constitution, which is the intent of the rulings; the two list
edits are invisible except to CI.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN, and trivially so:** both files are source in the repository. They
replicate the way every other source file does — by being merged and released. There is no runtime
state, no per-machine record, no generated URL, and no notice. Nothing here can strand on a topic
transfer because nothing here is topic-scoped.

## 8. Rollback cost

Near zero, and no data migration. Reverting the two list edits restores the previous behavior
exactly; the ratchet would then report the new headings as unrecognized and fail CI, which is a loud
failure rather than a silent one. If only the registry text were reverted, the extra list entries
would be inert — an exclusion list entry for a heading that no longer appears matches nothing.

---

## Conclusion

No issue identified that blocks the change. Two are recorded rather than fixed: the parser/ratchet
list duplication (§3, §5) and the absence of any check that a heading's classification matches its
content (§2). Both are pre-existing properties of this design that this change makes one entry
larger; neither is created by it.
