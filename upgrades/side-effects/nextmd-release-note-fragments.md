# Side-Effects Review — Per-PR release-note fragments

**Version / slug:** `nextmd-release-note-fragments`
**Date:** `2026-05-31`
**Author:** `echo`
**Second-pass reviewer:** `required` (release-pipeline blast radius — see §1, §7)

## Summary of the change

The release pipeline consumed a single shared `upgrades/NEXT.md` per merge. With
many agents merging concurrently, every PR rewrote NEXT.md, so every PR collided on
it within minutes — the release notes became an un-landable hot file. This change
introduces per-PR release-note FRAGMENTS (`upgrades/next/<slug>.md`): two PRs touch
different fragment files and never collide.

The mechanism is an ASSEMBLE PRE-STEP. A new pure script
(`scripts/assemble-next-md.mjs`) folds every fragment (deterministic filename sort)
plus any legacy `upgrades/NEXT.md` into a single `upgrades/NEXT.md`, merging by
section. The publish workflow runs it immediately BEFORE the existing
"Check if NEXT.md has content to publish" step; everything downstream is unchanged.
The pre-push gate validates the assembled result in-memory (never writing NEXT.md).

## Decision-point inventory

1. **No-fragments / no-legacy-NEXT.md → no-op (exit 0 quietly).** The existing skip
   logic then fires. This is the load-bearing backward-compat boundary.
2. **Malformed fragment (content but no parseable `## ` section, or only
   comments/whitespace) → loud non-zero exit.** Fails the workflow rather than
   shipping a broken guide.
3. **Idempotency guard:** an input carrying `GENERATED_MARKER` is dropped when any
   non-generated input is present; folded straight through (stable re-emit) when it
   is the sole input. Decides "is this a fresh fragment set or a re-run on prior
   output?"
4. **Bump tier = MAX(fragments).** A hint only; the real tier is
   `.instar/release-tier.json` (untouched).
5. **pre-push gate active-guide selection:** assembled in-flight notes win; else fall
   back to the versioned guide; else "no guide" error.

## 1. Over-block

**What legitimate inputs does this change reject?** A fragment with real prose but no
`## ` heading is rejected — intentional, because the assembler can't place headless
prose under a known section. An effectively-empty fragment (comments/whitespace only)
is rejected — intentional, an empty fragment file is a mistake. A hand-authored legacy
`upgrades/NEXT.md` is NOT rejected: it is folded in (backward compat). The
no-fragments-and-no-NEXT.md case is NOT an error — it is a clean exit-0 no-op, so the
existing "nothing to publish" skip is preserved exactly. **No legitimate current input
is newly rejected:** today's flow ships a NEXT.md, which still validates and publishes
unchanged.

## 2. Under-block

**What does this still miss?** The assembler does not deep-validate each fragment's
section CONTENT (camelCase keys, inline code, missing Evidence) — that remains the job
of `validateGuideContent`, which runs against the ASSEMBLED result in both the pre-push
gate and (post-rename) `check-upgrade-guide.js`. So a defect in a fragment is caught at
the assembled layer, not per-fragment; this is acceptable because the assembled doc is
exactly what publishes. It does not detect two fragments making contradictory claims —
out of scope (humans review notes). It does not garbage-collect stale fragments that
were never released; the publish path deletes only the fragments it just consumed.

## 3. Level-of-abstraction fit

**Right layer?** Yes. The assembler is a pure string→string function with a thin CLI
wrapper (same shape as `resolve-release-tier.mjs` / `resolve-publish-version.mjs`),
unit-tested in isolation. The workflow change is one additive step plus one `rm` in the
existing consumption path — it does not touch the tier gate, version resolution, rename,
guide check, publish, or commit logic. The pre-push gate reuses the SAME assemble
function (single source of truth), so pre-push and publish can never diverge on how
fragments fold.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No new blocking AUTHORITY over releases is added. The assembler is a transform, not a
gate: its only failure mode is a malformation (exit non-zero), which is the same loud
behavior the publish workflow already wants. The real publish AUTHORITY is unchanged —
`.instar/release-tier.json` (Layer 2) and `validateGuideContent` (the section/content
gate) still decide what ships. The emitted bump comment is explicitly a documentation
SIGNAL, not authority (the code comment and the artifact both say so).

## 5. Interactions

- **UpgradeGuideProcessor**: scans `upgrades/` for files matching
  `^(\d+\.\d+\.\d+)\.md$`. `readdirSync` returns the subdir name `next` (no `.md`
  suffix) → not matched → ignored. Verified by reading `getAvailableGuides`. The
  `upgrades/next/` directory is invisible to guide delivery.
- **check-upgrade-guide.js**: iterates `upgrades/*.md` files (skips `NEXT.md`); the
  `next/` subdir is not a `.md` file → skipped. By publish time fragments are already
  deleted and NEXT.md renamed, so it validates the assembled+renamed guide. Verified
  end-to-end in a scratch dir (assemble → rename → check → exit 0).
- **pre-push-gate.js**: now imports the assembler; assembles in-memory; the side-effects
  artifact check (§5 of the gate) reads the assembled "What Changed" instead of raw
  NEXT.md. No NEXT.md is written during pre-push.
- **Idempotency / re-runs**: the `GENERATED_MARKER` guard prevents a re-run from
  double-folding prior output back over still-present fragments.
- No interaction with SessionReaper, sentinels, recovery, or any runtime path — this is
  build/CI tooling only.

## 6. External surfaces

- New directory `upgrades/next/` and new file convention `upgrades/next/<slug>.md`.
- New script `scripts/assemble-next-md.mjs` (build-time only; never shipped to agent
  runtime paths).
- One new publish workflow step + one `rm` in the existing rename step.
- New CLAUDE.md / build-skill guidance instructing fragment authoring; a
  `PostUpdateMigrator` CLAUDE.md backfill for deployed agents.
- No HTTP routes, no config keys, no Telegram, no agent runtime behavior change.

## 7. Rollback cost

**Low and clean.** Three independent revert points, each safe on its own:
- Remove the "Assemble release-note fragments" workflow step + the `rm` line → publish
  reverts to consuming NEXT.md directly (NEXT.md authoring still works).
- Revert the pre-push gate to validating NEXT.md directly.
- Delete `scripts/assemble-next-md.mjs` + its test.
Because the no-fragments path is a byte-for-byte no-op, a half-rollback (e.g. removing
only the workflow step while authors still write fragments) degrades gracefully: the
release simply skips (no NEXT.md), which the release-readiness sentinel surfaces — it
never ships a wrong or partial guide. No state, no schema, no irreversible op, no data
migration. Fragments are plain markdown files.

## Conclusion

Additive, backward-compatible, pure-function-at-the-core change to build/CI tooling.
The release-critical invariant — "the no-fragments path reproduces exact current
behavior" — is enforced by code (clean exit-0 no-op) and covered by tests (CLI exits 0
and writes nothing; pre-push accepts a fragment-only push and rejects a malformed one).
Blast radius is contained to the assemble pre-step; the tier gate, version resolution,
and content validation that actually authorize a release are untouched.

## Second-pass review (if required)

Required (release-pipeline). Reviewer focus: confirm the publish.yml diff is additive
(the assemble step precedes the unchanged skip-check; the `rm` rides the existing
`if:` guard and the existing `git add upgrades/`), and that the no-fragments path still
skips cleanly. Pending.

## Evidence pointers

- `tests/unit/assemble-next-md.test.ts` — 25 tests: section merge, deterministic order,
  max bump tier, single fragment, legacy fold, no-op/quiet, malformed→loud, idempotent
  (in-memory + on-disk CLI), WTTYU backtick-free.
- `tests/unit/pre-push-gate.test.ts` — fragment-aware integration: accepts fragment-only
  push (writes no NEXT.md), rejects WTTYU inline code via assembled validation, rejects
  malformed fragment loudly.
- Manual end-to-end (scratch dir): fragment → `assemble-next-md.mjs` →
  `mv NEXT.md <version>.md` + `rm next/*.md` → `check-upgrade-guide.js` exit 0.
- `upgrades/next/release-note-fragments.md` — this PR's own release note (dogfoods the
  mechanism; the PR does not touch `upgrades/NEXT.md`).
