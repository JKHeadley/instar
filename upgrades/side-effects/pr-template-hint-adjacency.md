# Side-Effects Review — Pull-request template hint adjacency

**Version / slug:** `pr-template-hint-adjacency`
**Date:** `2026-07-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

Two existing template comments move below their respective headings, and the
template test now binds each hint to its section opening.

## Decision-point inventory

- PR author guidance — modified — each hint is locally scoped.
- CI gate implementations — unchanged.
- Pull-request description contents — unchanged until an author fills them.

## 1. Over-block

The test asserts only the two section openings. Authors remain free to write any
content that satisfies the real gates.

## 2. Under-block

Both required headings are covered. A hint elsewhere in the template no longer
satisfies the adjacency assertion.

## 3. Level-of-abstraction fit

The template owns author guidance, while the test imports the existing ELI16
gate for behavioral coupling and adds a structural template assertion.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Yes — template comments are guidance; CI gates retain authority.

## 4b. Judgment-point check

No heuristic or authority changes.

## 5. Interactions

- **Shadowing:** correct local hints reduce confusion without replacing gates.
- **Double-fire:** no runtime events.
- **Races:** static repository files only.
- **Feedback loops:** a future template rearrangement must update the paired
  section test intentionally.

## 6. External surfaces

PR authors see the right gate guidance immediately beneath the section they are
about to fill.

## 6b. Operator-surface quality

The UX hint now explicitly reaches the UX authoring location instead of being
visually attached to ELI16.

## 7. Multi-machine posture

Repository-wide template behavior is identical for every contributor.

## 8. Rollback cost

Two comment moves and one test helper; no state.

## Conclusion

Clear to ship as a bounded process-surface correction.

## Second-pass review

**Reviewer:** not required
**Independent read of the artifact:** Not required; documentation and tests
only, with no runtime or enforcement changes.

## Evidence pointers

- `.github/PULL_REQUEST_TEMPLATE.md`
- `tests/unit/pull-request-template-gates.test.ts`
- Mutation proof: placing the ELI16 hint above its heading fails the test.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
