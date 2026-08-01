# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

A spec whose approval was documented on the `approved:` line was silently unapproved. The frontmatter parser did not strip YAML inline comments, so

```yaml
approved: true  # operator authenticated preapproval, topic 11960, 2026-07-11
```

parsed as the **string** `"true  # operator authenticated preapproval, topic 11960, 2026-07-11"`. Every consumer testing `data.approved === true` — `StageTransitionValidator` above all — correctly concluded the flag was not `true` and refused the transition with `APPROVED_FLAG_MISSING`, on a file that visibly reads `approved: true`. The comment that recorded the approval was what voided it.

This adds `stripInlineComment()` in `src/core/SafeYaml.ts`, applied at **both** sites that interpret a scalar: `parseInlineValue` (`key: value  # note`) and the block-sequence item path (`- item  # note`). The identical defect existed in both; fixing only the one that surfaced would have left the class half-open.

The stripping is deliberately conservative, following the YAML rule rather than a looser one: a `#` begins a comment only at value-start or when preceded by whitespace, and never inside quotes. So `url: http://host/page#section` and `title: "sharp # sign"` are untouched. An earlier sketch cut at the first `#` unconditionally, which would have silently truncated URLs — that boundary is now the explicitly-tested half of the change.

Ordering note: the strip runs *before* the tag / anchor / flow-sequence checks in `parseInlineValue`, so `tags: [a, b]  # note` no longer fails the `endsWith(']')` test and fall through to being read as a plain string. It cannot shadow the security rejections, because a value that *starts* with `!`, `&` or `*` is unaffected by comment-stripping.

Measured on `main` (53c2140b): 559 specs carry frontmatter, 522 carry an `approved:` line, and **9 of those carry an inline comment on it** — 1.7%. Those nine are not a random sample; they are the specs whose approvals were documented most carefully, which is what makes the failure mode worth closing at the parser rather than by hand-editing nine files.

## Evidence

- **The bug, reproduced against the shipped parser before fixing:** loading `parseSafeYaml` from the installed dist and parsing `docs/specs/audit-convergence-enforcement.md` returned `approved` as `typeof string`, with `=== true` false, so the gate's verdict was `APPROVED_FLAG_MISSING`.
- **The fix, proved end-to-end on that same real file:** `approved` now parses as `true` (`typeof boolean`), with `approved-by` and `approved-date` intact — it passes the approved-flag gate it previously failed.
- **Test falsification, not assumption:** 13 new cases in `tests/unit/SafeYaml-inline-comments.test.ts`. Reverting `src/core/SafeYaml.ts` to its pre-change state and re-running gives **8 failed / 5 passed**. The 5 that pass either way are the conservative guards (URL fragment, `#` in double quotes, `#` in single quotes, `#` with no preceding space, no-comment values) — they prove existing behaviour is unchanged, and a test that passed without the fix would have proved nothing.
- **Every downstream consumer re-run green:** `StageTransitionValidator` (53), `ProjectRoundRunner` (27), `PlanDocParser` (9), `ProjectAutoAdvancePoller` (10), `convergence-gate-consistency` (23), `projects-advance-mergebase-wiring` (5), `spec-review-publish` (11) — **138 passed, 0 failed**.
- **`npx tsc --noEmit`** — clean.

Known limitation, flagged rather than fixed: escaped quotes inside a quoted scalar (`desc: 'it''s # here'`) would mis-track quote state. `parseScalar` already does no escape processing — it slices the outer quotes verbatim — so this is a pre-existing property of the deliberately narrow schema, not a regression, and no spec in the tree uses that shape.
