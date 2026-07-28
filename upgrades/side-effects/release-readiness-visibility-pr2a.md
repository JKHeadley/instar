# Side-Effects Review — Release-Readiness Visibility, PR-2a (Layer A auto-draft + publish-gate amendment)

**Spec:** docs/specs/RELEASE-READINESS-VISIBILITY-SPEC.md §4.1 (converged + approved).
**Scope:** the auto-draft half of PR-2 — `analyze-release.js --draft-guide`, the `upgrade-guide-validator.mjs` review gate, and the `publish.yml` skip-predicate amendment. (Layer B — the ReleaseReadinessSentinel + routes + job — lands in a following commit on this same branch.)

## What changed

- **`scripts/analyze-release.js`** — new `--draft-guide` mode. Builds `upgrades/NEXT.md` from the already-computed `generateChangeDescriptions`, structured into the required sections + a seeded `<!-- bump: -->`. Every section carries an `auto-draft-unreviewed` marker. Commit-message text is sanitized (HTML comments stripped, length-capped, leading `#`/`---` escaped) so a crafted message can't forge markers or break section bounds. Two write modes: full draft when the guide is absent/pristine-template; additive uncovered-delta block (never clobbers human content) otherwise. Idempotent — coverage is measured against human content only, so the delta block doesn't oscillate. Race-guarded against publish-finalize via the `upgrades/{version}.md` existence check.
- **`scripts/upgrade-guide-validator.mjs`** — `autoDraftReviewIssues()` (wired into `validateGuideContent`): blocks while any `auto-draft-unreviewed` marker remains; validates `reviewed-by` receipts (required `:hash=<sha256>` matching the canonicalized section, ≤30-day window). `canonicalizeSectionForHash` / `sectionReviewHash` exported for reuse + tests.
- **`.github/workflows/publish.yml`** — skip predicate also sets `skip=true` when `auto-draft-unreviewed` is present (keeps silent-skip semantics for the unreviewed case; the sentinel surfaces it as a signal in Layer B).

## Side-effects analysis

**Over/under-reach.** The validator change adds block conditions that fire ONLY on content the auto-drafter produces (`auto-draft-unreviewed` markers) or on malformed `reviewed-by` receipts. A hand-written guide that never uses these markers is completely unaffected — existing guides and the existing finalization flow are untouched. `--draft-guide` is opt-in (no existing caller passes it); the default `analyze-release.js` behavior is byte-identical.

**Defeating-the-gate (the iter-1 adversarial finding).** The whole point: a fully auto-drafted guide PASSES every prior check (sections present, length, no template placeholders, evidence-section present) but is BLOCKED by the new unreviewed-marker rule. Verified: drafting then validating returns the unreviewed-marker issue; replacing markers with correct hash-locked receipts clears it; wrong-hash / missing-hash / stale receipts re-block. So auto-fill removes the blank-guide root cause without shipping un-reviewed notes.

**Signal vs authority.** The gate amendment teaches the EXISTING publish gate (which already has blocking authority) a new recognize-and-block condition; it introduces no new low-context detector with veto power. Consistent with §5.

**Spec deviation (documented).** §4.1.3 also describes an intra-host O_EXCL advisory lock. It is intentionally omitted: releasing it needs a destructive `fs.unlink`, forbidden by `lint-no-direct-destructive` in this dependency-free, test-copyable script, and the draft job is single-runner via the multi-machine lease so concurrent local drafters don't occur. The cross-host guarantee (the one §4.1.3 calls the real guarantee) is fully preserved via the `{version}.md` existence check. The full "marker stripped without a receipt" detection remains the tracked Phase-2 git-diff CI check per §4.1.1.

**Rollback.** Revert restores prior `analyze-release.js` / validator / workflow. No state, config, or migration introduced by PR-2a.

## Testing

- Unit (19 green): `analyze-release-draft-guide.test.ts` (8 — full draft, template overwrite, never-clobber merge, idempotency, fully-covered no-op, finalize-race skip, no stray lock, HTML-comment sanitization); `upgrade-guide-autodraft-review.test.ts` (7 — marker blocks, block-marker blocks, correct receipt passes, hash-mismatch/missing-hash/stale block, validateGuideContent surfaces it); `analyze-release-ref-flag.test.ts` (4, from PR-1).
- Integration/E2E for the readiness pipeline land with Layer B (the routes + the "feature is alive" E2E that reproduces the original stall).
