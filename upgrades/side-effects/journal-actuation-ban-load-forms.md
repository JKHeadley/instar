# Side-Effects Review — journal-actuation-ban: every load form, and the staleness half of the population

**Version / slug:** `journal-actuation-ban-load-forms`
**Date:** `2026-08-14`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1 (classifyTier: suggestedTier 1, riskFloor 1, no reasons). No spec change: COHERENCE-JOURNAL-SPEC §3.9 is unmodified; this makes the existing ban see load forms it already forbade.`

## Summary of the change

`scripts/lint-journal-actuation-ban.js` enforced §3.9 with `/from\s+['"]…CoherenceJournalReader…['"]/`. That
requires the `from` keyword, which `await import(…)` and `require(…)` do not have, so both walked past the ban.
Reproduced against the shipped lint on a REAL listed actuator (`src/core/SessionManager.ts`): it reported
`clean`. Independently reproduced by instar-codey, who ranked this lint #1 of ~20 by consequence-of-defeat.

Now: all three load forms are matched; comments are stripped (quote-aware, length- and line-preserving) before
matching, so prose describing the ban is never a violation; a runtime-erased `import type` is correctly NOT a
violation; a curated actuator that has vanished from the tree is a violation instead of a skipped line; and a
root with no `src/` exits 2 rather than printing `clean`.

The declared-population gap ("grow this list when a new actuator class lands") is **left open deliberately** —
see §2.

## Decision-point inventory

- `LOADS_READER` — WIDEN — now matches `from` / `import(` / `require(`. CI-time only; never runtime.
- `TYPE_ONLY_IMPORT` — ADD — narrows: `import type` is exempt (erased at compile time).
- comment stripping — ADD — narrows: commented text cannot be a violation.
- missing curated file — CHANGE — was `continue` (silent), now a violation.
- root without `src/` — ADD — exit 2, no verdict.
- No runtime block/allow decisions added or modified. This script runs in `npm run lint` and CI only.

## 1. Over-block

The widened matcher can only fire on the eight curated actuator files, so the blast radius is those eight.
Verified against the real tree: none of the eight so much as mentions `CoherenceJournalReader`, and the lint
exits 0. Two narrowings actively REDUCE over-block versus the shipped version: `import type` (which the old
regex flagged — `src/core/WorkingSetPull.ts` is a live example of that shape) and comment stripping.

The one new way to fail a build that is not a §3.9 breach: renaming a curated actuator without updating
`ACTUATOR_FILES`. That is intended — a renamed actuator silently leaving the ban is the failure this closes —
and the message names the file and the fix.

## 2. Under-block

**Automatic discovery of actuators was built, measured against this tree, and REJECTED.** Inferring "is this an
actuator?" from declared names (functions, classes, filename) flagged nine sites across three files, and every
one was a part-of-speech or granularity error rather than a §3.9 breach:

- `src/server/routes.ts` — matched `readReaperPeerText`, `isReaperSnapshot`, `reaperPoolHealth`: "reaper" as a
  NOUN in code that REPORTS ON the reaper. A reporting surface reading the journal is correct code.
- `src/commands/server.ts` — the 22k-line composition root. Every module's authority is wired through it, so any
  file-level verdict on it is wrong in one direction or the other.
- `src/core/WorkingSetPull.ts` — a runtime-erased `import type`.

This lint blocks commits, so over-blocking correct code is the more expensive failure. The enumerated-list shape
is also the ORIGINAL converged design decision, stated in `upgrades/side-effects/coherence-journal-p1-2.md`:
"The enumerated-list shape is deliberate: growable, reviewable." Closing it needs an authoritative actuator
population, not a heuristic; `src/testing/selfActionRegistry.ts` (`modelsPath`, kept complete by
`lint-no-unregistered-self-action.js`) is the closest candidate but is a superset in KIND — spend-alert
emitters and sweeps are self-actions, not §3.9 session actuators. Left open, named in the header, and pinned by
a test that will fail if someone closes it.

Still evadable, unchanged from before: a hand-rolled JSONL read, or reaching the reader through a re-export.
The §3.9 duty remains the authority.

## 3. Level-of-abstraction fit

Line-level regex over comment-stripped source, on an enumerated file list. Same layer as the shipped check —
no AST, no type information, no new dependency. The comment stripper is the only added machinery, and it exists
so the matcher can widen without making §3.9 prose illegal.

## 4. Signal vs authority compliance

Unchanged and reinforced. The lint is a CI guard, not a runtime authority; it forbids actuators from HOLDING the
reader, which is what keeps replicated journal data signal rather than authority. Nothing here reads the journal
at runtime.

## 5. Interactions

- `npm run lint` chain (`package.json:31`) — position unchanged; `tests/unit/lint-chain-completeness.test.ts`
  passes (3/3).
- Husky pre-commit / CI run the same chain. Exit 2 on a rootless tree is new; the repo root always has `src/`,
  and the only caller passing `--root` is this test.
- No source module, route, config key, or state file is touched.

## 6. External surfaces

None. No HTTP route, no config key, no user-visible message, no CLAUDE.md template change (the lint is
developer-facing tooling, not an agent capability). Agent Awareness Standard does not apply.

## 7. Rollback cost

`git revert` of one script plus one test file. No migration, no state, no deployed artifact. The lint is
stateless and runs from source.

## Conclusion

Ship. One real evasion closed with a negative control proving each assertion fails without the fix; two
narrowings that reduce false positives below the shipped baseline; one silent-failure mode of my own making
(clean verdict over zero files) caught and closed before it shipped.

## Second-pass review (if required)

Not required at Tier 1. Independent corroboration of DEFECT 1 exists regardless: instar-codey reproduced the
dynamic-import evasion separately and ranked this lint first of ~20 by consequence-of-defeat, and recommended
exactly the scope taken here — "low FP risk if limited to actuator files and comment-stripped `import()`,
`require()`… Do not ban writer imports."

## Evidence pointers

- `tests/unit/journal-actuation-ban-lint.test.ts` — 13/13 green with the fix.
- Negative control: with the shipped lint restored, exactly 5 of the 13 fail (dynamic import, `require`,
  `import type`, vanished-curated-file, rootless-tree) and all 8 controls still pass — controls should pass
  both ways, which is what makes them controls.
- Real-tree verdict: `node scripts/lint-journal-actuation-ban.js` → `clean (8 actuator modules, none load the
  reader)`, exit 0.
- `upgrades/side-effects/coherence-journal-p1-2.md` — the original converged decision to enumerate.

## Finding raised separately (NOT fixed here)

Discovery, before it was rejected, surfaced five `await import('../core/CoherenceJournalReader.js')` sites in
`src/commands/server.ts`. One (`:20853`) wires `OwnershipApplier`, which materializes durable topic ownership
FROM the replicated placement journal — replicated data feeding an ownership decision that placement and
session routing then act on. It is deliberate and specified (`docs/specs/ownership-applier-meshself-ordering-fix.md`)
and validates `transferTo` against the live known-machine set before materializing. Whether §3.9 permits it is a
spec question with real consequence, and it is not mine to settle inside a lint change. Raised to the operator;
deliberately NOT actioned here, and the lint does not flag it.
