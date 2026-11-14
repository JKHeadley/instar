# Side-Effects Review — standards back-references: baseline emptied, expired countdown resolved

**Version / slug:** `standards-backreference-completion`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see the end)`

## Summary of the change

Tier 1. Header comments in 27 files (11 scripts, 1 skill script, 15 under `src/`) naming the registry article(s) that cite each as enforcement; `docs/standards-backreference-baseline.json` emptied; `scripts/lint-standard-code-backreference.mjs` accepts a title of 12 characters or fewer in emphasised form only; one line of `docs/STANDARDS-REGISTRY.md` restated and its sub-obligation countdown re-dated from 2026-11-13 to 2026-11-27 for the half that remains.

Why: the countdown expired and `lint-documented-only-countdown` has failed every tree since 2026-11-14 00:00 UTC, which fails `dev:preflight` and so every Local Verify run.

## Decision-point inventory

- `lint-standard-code-backreference` (blocks a commit/PR whose registry-cited file names no standard): its accept rule gains short titles in emphasised form; its grandfather list is empty, so it now blocks any cited file with no back-reference.
- `lint-documented-only-countdown`: unchanged. Its input (the date) changes, by a code-owner-reviewed edit.

---

## 1. Over-block

With an empty baseline, a future registry edit that cites a new enforcement file fails lint until that file names the article. That is the article's stated requirement, now without an escape list.

## 2. Under-block

The lint still checks that a file names *a* real article, not the right one; the registry line keeps saying so. Infrastructure the registry has never cited is still outside the check: that is the half of the sub-obligation that remains, with the new date.

## 3. Level-of-abstraction fit

The references are written where the article says they belong (the file header), and derived from the registry's own enforcement fields, which is the only source that states the relation.

## 4. Signal vs authority compliance

The lint is a deterministic structural check with blocking authority over a structural property (a string naming a real article is present). The change does not give it judgment; the one loosening (short titles) is bounded by requiring the registry's own emphasised form.

## 5. Interactions

- **Line-1 markers:** headers are inserted after a shebang and after first-line allow-markers, never above them.
- **Comments only** in the 27 files; no runtime behaviour changes. Any of them that sits in the Local Verify verifier import graph changes the verifier version, as every release that touches such a file does; it changes identically on every machine that installs the release.
- **Registry-derived artifacts:** the article count and titles are unchanged, so title-keyed generated data is unaffected.
- **Spawn/kill:** none. Class `unbounded-self-action`: not applicable.

## 6. External surfaces

None at run time. The registry text changes (operator-visible, code-owner reviewed).

## 7. Multi-machine posture

Not applicable: source comments, a lint and a document; nothing runs per machine.

## 8. Rollback cost

Revert the commit. The lint chain then fails again on the expired date until it is re-dated.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose), read-only, 2026-11-13.

It re-derived the file-to-article mapping and confirmed all 27 headers name only articles whose enforcement field cites that path, spelled as the headings, with none missing; shebangs and `safe-git-allow` markers intact; the lint change only widens acceptance and no passing file relied on a short title; the new registry sentences are true of the diff.

Two concerns raised, both resolved in this change: (1) the Building area audit was stale: `docs/audits/standards-backreference-completion-building-family-2026-11-13.json`, its report under `docs/specs/reports/`, and the ledger entry are added (floor unchanged, 34 of 40); `tests/unit/standards-coverage-ratchet.test.ts` failed the first Local Verify run on exactly this and passes now; (2) the header split a multi-line `safe-git-allow` comment in two scripts: moved below it. Its remaining note (no unit test for the lint's short-title branch) is tracked as CMT-1748.

`node scripts/standards-coverage.mjs --check` now reports only the direction guard for this article, which the operator's approving review clears by design.

**Reviewer concurred:** yes, once the two concerns were resolved.
