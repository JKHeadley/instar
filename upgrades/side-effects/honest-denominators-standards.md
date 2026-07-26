# Side-Effects Review — honest denominators, part two: the standards-enforcement audit

## Summary of the change

Five honesty defects in ONE instrument — the standards enforcement-coverage audit — all found by
the convergence-towards-coherence audit (2026-07-25) while measuring the instrument that measures
our constitution. Live evidence: `GET /conformance/coverage/health` on this machine returned
`{converged: true, total: 22, enforcedRatio: 0.0455}` while `docs/STANDARDS-REGISTRY.md` in the
source repo carries **81** article headings. Re-run over the real registry: `total: 80`,
`enforcedRatio: 0.5375`. The reported figure was 12× more alarming than reality and was quoted to
the operator as fact.

**A. `enforcedRatio` fabricated a ratio with no denominator.** `total === 0 ? 0 : …` returned `0`
— "0% of standards enforced", a measurement nobody had taken. Now `number | null`, with the type
telling callers not to coerce.

**B. Family detection was a hardcoded five-name allowlist**
(`The Root|The Substrate|Building|Shipping|Interaction`). The registry has SIX standards families;
every article under `## The Fractal — the framework that develops itself` was silently dropped
(currently the Self-Hosting standard). Replaced with structural detection: a `##` section is a
family iff ≥1 `###` under it carries a `**Rule.**`. The prose sections (Why this exists, Genesis,
Two layers, How a new standard joins, The Stakes) carry no rule lines and are excluded
automatically — same exclusion the allowlist achieved, with no list to maintain.

**C. The parse canary's floor could not detect a fourfold collapse.**
`MIN_EXPECTED_ARTICLES = 15`, commented "far below the real ~21", never moved as the registry grew
to 81 — so it would pass while 65 of 81 articles vanished. Added a completeness check:
`droppedHeadings` (headings inside a detected family with no rule line) fails the canary and names
each loss. The floor is retained, documented as a coarse backstop only.

**D. `converged: true` sat bare beside the ratio.** It only ever meant "the deterministic pass is
stable on unchanged inputs". Added `convergedMeans` so the meaning travels with the field.

**E. An unreadable registry hashed identically to an empty one** in `computeInputHash`
(`catch { registry = '' }`) — absence and emptiness sharing a cache slot, the same shape one layer
down. Now distinguishable via an explicit marker.

Supporting surface: `parseStandardsRegistryDetailed` / `loadStandardsRegistryDetailed` return
`RegistryParseDiagnostics`; `runRegistryCanary(articles, diagnostics?)` reports `articleHeadings`
and `completenessAssessed`; `CoverageSummary` gains `assessmentTrustworthy` + a `registry`
provenance block.

## Decision-point inventory

- `computeCoverage` — an OBSERVE-ONLY reporter. Gates nothing, blocks nothing, has no authority
  over any pipeline. The change alters what it *reports*, never what anything *does*.
- `runRegistryCanary` — a state-detector whose verdict is returned as DATA. Both call sites
  (`specReviewRoutes` HTTP handler and `runConformanceCheck` for the CLI) attach it to the
  response; neither throws on it. A stricter canary therefore cannot newly block anything.
- `parseStandardsRegistry` — pure function. Behaviour change: it now returns MORE articles
  (the previously-dropped family).
- `GET /conformance/coverage/health` — read-only, dev-agent-gated, `X-Instar-Request` gated.
  Response gains fields; `enforcedRatio` changes type.

No gate, hook, reaper, sentinel, or scheduler path is touched.

## 1. Over-block

The audit has no blocking authority, so it cannot over-block. The two adjacent risks:

**The canary becoming stricter.** `runRegistryCanary` now fails when a heading inside a family
carries no `**Rule.**`. Verified against the REAL registry: 80 headings, 80 parsed, zero dropped —
so the live document passes. A future editor adding a non-article `###` inside a standards family
WOULD trip it. That is intended (the failure names the heading and is trivially resolved by adding
a rule or moving the subheading), and it is signal-only: the verdict rides in a response body,
where no consumer treats it as a block. Checked all call sites for a throw-on-canary — none.

**The conformance gate seeing more standards.** `StandardsConformanceReviewer` now receives the
previously-dropped family, so a spec review may raise findings against Self-Hosting that it
silently could not raise before. That is the defect being fixed, not a side effect to mitigate:
the article was always in the constitution. The reviewer is signal-only per its own spec.

## 2. Under-block

**The stale-copy defect is NOT fixed here and is deliberately not bundled.** The running server
reads `<projectDir>/docs/STANDARDS-REGISTRY.md` — the agent-home snapshot — and
`PostUpdateMigrator.migrateFeatureMaturationGate` only overwrites that file when its hash is in a
known `prior` set. Our copy has drifted out of that set, so it is classified "customized — left
untouched" and stays frozen at 22 articles forever. Fixing it is install-base migration work with
a real risk (overwriting a genuinely customised registry on someone's machine) and deserves its
own review rather than riding along here.

What this change buys in the meantime is that the stale read is no longer SILENT: the same
22-article read now returns `assessmentTrustworthy: false` with `registry.parsed: 22` and the
canary failures attached, instead of a bare confident `0.0455`.

Tracked, not deferred-and-forgotten: <!-- tracked: CMT-1035 --> (tier-one closeout commitment,
topic 29723) — the migration is the next item on the same tier and the completion condition of the
registered autonomous run `run-ms13zzrz-78576404` requires the LIVE figure to be computed over ≥80
standards, so this cannot be quietly dropped.

## 3. Blast radius

`enforcedRatio: number → number | null` is the one breaking-shaped change. Every consumer in the
repo was checked:

- `src/server/routes.ts` — spreads `report.summary` into the response; no arithmetic.
- `tests/unit/standards-enforcement-auditor.test.ts`, `tests/e2e/standards-coverage-lifecycle.test.ts`
  — assert on real (non-empty) registries where the value stays a number; both still pass.
- `grep -rn "enforcedRatio"` across `src/`, `scripts/`, `tests/` — no other reader, no CI ratchet,
  no dashboard tile consumes it.
- `docs/`/CLAUDE.md prose mentions it descriptively only.

`family` string values are unchanged for the five pre-existing families: the new
`familyName()` truncates at the first dash separator, so `## The Substrate — the model-level
truths …` still yields `The Substrate` (asserted in the updated unit test). `The Fractal` is
additive.

## 4. Rollback plan

Single-commit revert; no state migration, no persisted artifact, no config key. The audit is
recomputed from disk on every request behind an `inputHash` cache that lives in a route-local
variable, so a revert takes effect on the next server start with nothing to clean up. No dark flag
is needed: the change makes a read-only report more honest and cannot alter behaviour.

## 5. Test coverage (all three tiers, per the Testing Integrity Standard)

- **Unit** — `tests/unit/standards-conformance-gate.test.ts` (+4 cases): structural family
  detection incl. an invented family and `The Fractal` present; canary reports its denominator and
  says `completenessAssessed: false` when it cannot check; the silent-drop case that the old floor
  passed and the completeness check now names.
  `tests/unit/standards-enforcement-auditor.test.ts` (+3): `enforcedRatio` null over an empty
  registry; provenance + trustworthiness on a real pass vs a truncated fragment; unreadable ≠
  empty in `computeInputHash`.
- **Integration** — `tests/integration/conformance-dev-gate-route.test.ts` (+4): the HTTP response
  returns `null` not `0`, carries the registry provenance, never presents `converged` bare, and
  yields a real ratio with a visible denominator on a populated registry.
- **E2E** — `tests/e2e/standards-coverage-lifecycle.test.ts` (+2): the live route assesses the
  WHOLE constitution (denominator equals the document's own heading count, families include
  `The Fractal`), and a truncated registry cannot present itself as trustworthy.

Every one of the three "has it refused something?" demonstrations in the ELI16 is an assertion in
this set, not a manual check.

## 6. Two mistakes made while building this, recorded rather than tidied away

**The test that was protecting the bug.** `standards-conformance-gate.test.ts` asserted that every
parsed family is one of exactly five names. It failed the moment `The Fractal` started parsing —
the test existed to confirm the exclusion of prose sections, but it had frozen the bug in place as
a specification. Rewritten to assert the prose sections are excluded (the real intent) plus a
regression guard for the dropped family. This is the second time in one day a passing test was
found protecting the defect it sat next to.

**The alarming number was passed on unchecked.** Every other instrument found in this audit failed
by *flattering* us; this one failed by *damning* us, and it was relayed to the operator without
checking its denominator. A frightening figure is the one least likely to be questioned — which is
why the denominator now travels with the number rather than being available on request.
