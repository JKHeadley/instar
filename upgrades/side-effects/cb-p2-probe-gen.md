# Side-Effects Review — Held-out probe question generation (context budget Phase 2 slice P2-2)

**Version / slug:** `cb-p2-probe-gen`
**Date:** `2026-11-20`
**Author:** `Echo (Opus 5.5)`
**Second-pass reviewer:** independent subagent (see the end of this file)
**Spec:** `docs/specs/context-budget-layered-summaries.md` (v9, converged, approved) §10 items 1–2, §6.5, §12 rows "Probe count" and "Sampler ceilings"
**Stacked on:** PR #3543 (P2-1)

## Summary of the change

`src/monitoring/foldProbe.ts` generates the probe questions a shadow fold is graded by. It is library code with no live call site: the shadow runner slice (P2-4) wires it behind `contextBudget.fold.shadow`.

- **`selectProbeMaterial`** (§10 item 2, §6.5) runs the folded spans through the one span sampler (`sampleSpan`) at its full 30K-token ceiling. The floor is every handoff-named decision, evolution and still-needed item: its message ids and the tool entry ids. An **independent sample**, sized at 20% of the sampler's ceiling and drawn in addition to it, comes only from entries the sampler excluded. It is stratified into contiguous strata across the folded span, with one entry per stratum at a fold-id-seeded offset. That makes it deterministic per fold, with no randomness and no clock. Entries are bounded with `boundedEnds` at the sampler's own per-entry cut. Coverage (entries represented over entries folded) is returned for the card.
- **`buildProbePrompt`**: every input is fenced as data, and a closing tag smuggled into the data is stripped. The prompt names the floor and the typed vocabulary.
- **`validateProbeQuestions`** is the code layer above the model (tier 1, enumerated output):
  - a bad type, bad source, oversize text, a reference to an entry the generator was not shown, or a source ref naming nothing drops the question, with the reason recorded;
  - `detail` on a ledger, still-needed or H1-next item is retyped to `constraint`, and the retype is recorded;
  - questions citing an independent entry are marked `independent`;
  - index refs must be canonical integers;
  - the floor (one question per finished span, per open thread, and one from the independent sample when it is not empty) is checked and gaps are named;
  - kept independent questions are counted (`independentQuestions`);
  - the ceiling is deterministic from the `FoldProbe` budget (40K tokens ÷ 2.5K per question = 16), and floor-serving questions are kept first.
- **`generateProbeQuestions`** makes one model call (component `FoldProbe`, `fast`, temperature 0, 120 s), plus at most one re-ask naming the floor gaps. A failed re-ask keeps the first attempt's questions. Outcomes: `ok`, `floor-unmet` (with what it has), `no-judge` (no model, no call), `unparseable`, `error`.

**Files.** New: `foldProbe.ts`, `tests/unit/fold-probe.test.ts` (20), `tests/integration/fold-probe-material.test.ts` (2).

**Size and effort.** Tier 2 (spec-driven), about 290 LOC of source and 220 of tests. No new spec round. One lint fix: the bounded-input rule, now `boundedEnds` instead of a bare slice. One test fix: my assertion used the wrong archive result shape.

## Decision-point inventory

- **Which questions grade a shadow fold** (add). The model proposes. Code drops, retypes and checks the floor and ceiling deterministically. The output is a question set plus named gaps. It blocks nothing.

## 1. Over-block
Nothing is blocked. A question can be dropped:
- **A question citing an entry the generator was not shown** is dropped. That is correct: the grader needs a reference span it can check.
- **A source ref out of range** is dropped. A real question with a sloppy ref is lost, and the floor re-ask covers the gap.

## 2. Under-block
- **The model can still write a weak question** that passes validation. The grader (P2-3) and the deterministic presence rule judge answers, not questions. Phase 2's measured would-be `lost` rate is what tells us the questions are useful.
- **The independent sample is at most 5 entries.** That is spec-sized (20% of the budget), not exhaustive.

## 3. Level-of-abstraction fit
It uses the existing sampler, not a second one, so chunk builds and probes select the same way, as §6.5 says ("One sampler for every raw-span read"). Validation sits in code above the model, the same split ChunkBuilder uses.

## 4. Signal vs authority compliance
Compliant. The generator's output is data for the grader. `no-judge` and `floor-unmet` are named outcomes the step runner reads (§9.3 "Judge availability"). This module decides nothing.

## 5. Interactions
- **Model spend** goes through the existing IntelligenceProvider funnel with `attribution.component: 'FoldProbe'`, so it appears in the usage ledger. Nothing calls it until P2-4, so this PR adds no spend.
- **Prompt injection from transcript text** is fenced as data. Any form of a fence's tag inside its data (any case, inner whitespace) is stripped. Questions are validated against shown entry ids, so a planted instruction cannot make the generator cite invented material.

## 6. External surfaces
None. No route, config key, message or agent text.

## 7. Multi-machine posture
Machine-local by design. Probes run on the topic's owner inside its fold (§9.3 owner-only). The material is read from the owner's own archive.

## 8. Rollback cost
A revert. No persisted state.

## Testing tiers
- **Unit** covers both sides of each rule.
- **Integration** runs a real transcript fixture through the production reader and the real TranscriptArchive. Only archived entry ids are citable, the archive re-read samples identically, and a floor entry survives a tiny ceiling.
- **E2E** (a production boot path) does not exist for this slice, because nothing in `server.ts` constructs it yet. The runner slice P2-4 carries the alive test for the whole shadow path.

---

## Second-pass review

(appended below by the reviewer)

Concern raised:

1. **A valid result is thrown away on the re-ask** (`src/monitoring/foldProbe.ts:270-274`). Suppose attempt 0 parses but leaves floor gaps, so `last` is set. If the gap-naming re-ask then returns unparseable text (line 274) or throws (line 271), the function returns `unparseable` or `error` and drops the attempt-0 question set. Line 279 expects to fall through to `floor-unmet` with what it has. That fall-through never runs after a failed second attempt, so a probe that had usable questions is reported as having none. The artifact's description, "`floor-unmet` (with what it has)", does not hold on this path, and no unit test covers it (tests cover unmet→unmet, error on the first call, and unparseable twice). The fix: on attempt 1, when `last` is set, return `floor-unmet` with `last` instead of `unparseable` or `error`.

2. **A loosely written open-thread ref gives a false floor gap** (`foldProbe.ts:215, 220, 234`). `sourceRef` is kept as the raw `String(r.sourceRef)`. The range check uses `Number(sourceRef)`, so `"00"`, `" 1"`, `"1.0"` and `""` (Number("") is 0) all pass as valid open-thread or still-needed refs. But `covers` compares strings exactly against `gap.slice(12)`, so a question with sourceRef `"00"` passes validation but does not cover `open-thread 0`. The result is a spurious floor gap, a wasted re-ask and possibly `floor-unmet`. Non-integers such as `"1.5"` also pass the range check. The fix: parse the ref to an integer, reject it if it is not one, and store the canonical `String(n)`.

3. **The budget split differs from the spec** (`foldProbe.ts:100, 106` against spec §10 item 2). The spec runs the folded spans through the 6.5 sampler at "default 30K tokens" and says that "In addition" an independent sample is drawn at "20% of the question budget". The code instead splits the one 30K-character budget, giving the named sampler 80% (24K tokens) and the independent sample 20% of sampler characters. So the named sampler runs below its specified 30K ceiling, and "question budget" is read as a character budget rather than the question count. Validation also never checks that any question actually comes from the independent sample: the prompt asks for at least one, but nothing in code enforces or reports it. Either follow the spec (named sampler at the full 30K, plus an independent share in addition), or record this reading as a deliberate deviation in the artifact. Either way, report how many questions came from the independent sample.

4. **The fence strip is narrower than the artifact says** (`foldProbe.ts:152`). The strip is case-sensitive and matches only that fence's own exact tag, so `</NAMED-SAMPLE>` and `</named-sample >` pass through. The artifact's line "Tag-close smuggling is stripped" overstates it. The exposure is low, because validating against the shown entry ids still bounds what a question can cite. A case-insensitive regex that allows whitespace inside the tag closes the gap.

Checked and sound: the strata arithmetic (contiguous, non-empty, fold-seeded, deterministic, within the independent budget), floor-first ceiling selection and the `overCeiling` count, the `never-detail` retype, `sample` computed in code rather than trusted from the model, and the signal-vs-authority posture (the module decides nothing). 17 unit and 2 integration tests pass.

### Disposition (author)

All four concerns verified and fixed:
1. **A failed re-ask threw away usable questions.** If the re-ask throws or is unparseable after a parseable first attempt, the result is now `floor-unmet` with the first attempt's questions. Tests cover both paths.
2. **Loose index refs.** `still-needed`, `open-thread` and `finished` refs must be canonical integers (`0` or `[1-9]\d{0,5}`) and are stored canonical. `"00"`, `"1.0"` and `""` are dropped. A test shows a numeric `0` covers `open-thread 0`.
3. **Budget reading against the spec.** The named sample now runs at the full ceiling, and the independent sample is drawn in addition, at 20% of it. The independent sample now has its own floor (one question when it is not empty), and `independentQuestions` is reported. I read "20% of the question budget" as the size of the extra material, because the question count is set by the ceiling. The floor makes sure that material is actually probed.
4. **Fence strip.** It is now case-insensitive and tolerates inner whitespace, with a test.


Reviewer re-check: Concur with the review. I verified all four fixes in `src/monitoring/foldProbe.ts`:
- **Re-ask:** a throw or unparseable answer on the re-ask now returns `floor-unmet` with the first attempt's questions (lines 285-291). A first-attempt failure still returns `error` or retries as before.
- **Index refs:** `still-needed`, `open-thread` and `finished` refs must match `^(0|[1-9]\d{0,5})$` after trim and are stored as `String(n)`, so `covers` cannot miss a real cover.
- **Budget:** the named sample runs at the full `sampleChars`. The independent sample is drawn in addition. An `independent sample` floor gap is required when that sample is not empty, and `independentQuestions` is reported. I accept the author's reading of "20% of the question budget" as the size of the extra material, given that floor.
- **Fence strip:** `<\s*/?\s*tag\s*>` with flags `gi` now matches case and whitespace variants.

20 unit and 2 integration tests pass. One non-blocking nit: the artifact's Files line still says `(17)` unit tests; it should say 20.
