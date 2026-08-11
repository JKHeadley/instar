# External review pass 31 — reviewer's verbatim final answer — **REJECT, load-bearing 4, ALL 4 DESIGN**

**First half of the freeze pair, and the first reading whose question can be COMPARED to its
predecessor's** — `pass30-question.md` and `pass31-question.md` are both on disk, deliberately
near-identical so the pair measures the tree rather than the brief.

Run against `78eb54e13`. Exploration logs are NOT kept; only the final answer block.

---

```text
## FINDINGS

1. **DESIGN — the lint still accepts false-clean source states.**

   The replacement does not strip string literals despite saying it does ([lint:105](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:105)); it merely rejects an identifier immediately preceded by a quote ([lint:134](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:134)).

   In a frozen archive, I removed the Gemini sender’s real guard and substituted:

   ```ts
   void 'decoy assertTelegramPayloadVisible(';
   ```

   The lint exited 0 and reported all six senders guarded. The prefix separates the identifier from the quote, defeating the boundary rule.

   Independently, adding a real `this.apiCall("sendPhoto", …)` also exited clean because closed-world discovery recognizes only single-quoted calls ([lint:227](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:227), [lint:234](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:234)). These are one root finding: source-text grammar is still being presented as evidence of live calls and complete method classification. It directly violates the acceptance criterion that a decoyed guard must fail ([spec:420](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/telegram-egress-invisible-payload-guard.md:420)).

2. **DESIGN — the predicate repair generalizes Unicode category into advance width, but the claimed relationship is false.**

   The repair says `Mc` and `Me` carry advance width while `Mn` has zero advance, then implements that distinction solely through General Category ([predicate:44](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:44), [predicate:51](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:51), [predicate:57](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:57)).

   Execution against the host renderer at 40pt produced:

   - `Mn` U+20D0 COMBINING LEFT HARPOON ABOVE: advance `18.400`, visible glyph bounds `17.560 × 6.200`.
   - `Me` U+20DD, the repair’s own positive exemplar: advance `0.000`, though it has ink bounds.

   Injecting U+20D0 into the visible controls made the real guard test fail: `assertTelegramPayloadVisible` threw `InvisiblePayloadRefusedError`. Current fixtures pin only one selected `Mn`, U+0301, while admitting the selected `Mc`/`Me` examples ([test:270](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/telegram-send-funnel-invisible-payload.test.ts:270), [test:282](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/telegram-send-funnel-invisible-payload.test.ts:282)). General Category is not an advance-width predicate; the repair still over-refuses a rendered graphic mark.

3. **DESIGN — the refusal-arm measurement reports a valid-looking result and success when no measurement ran.**

   The runner distinguishes test failures from infrastructure errors by returning `red` versus `err` ([measure:49](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/measure-refusal-arm-coverage.mjs:49)), but error rows remain in the denominator and only `red` rows count as covered ([measure:59](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/measure-refusal-arm-coverage.mjs:59), [measure:74](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/measure-refusal-arm-coverage.mjs:74)).

   Controlled execution with one real guard and a deliberately missing test path produced four `err` markers, then:

   ```json
   {"total":4,"covered":0,"ratio":0}
   ```

   and exited `0`. Thus “tests could not run” becomes “0% covered.” The script also writes each mutation before running the test and restores it only afterward, without `finally` ([measure:57](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/measure-refusal-arm-coverage.mjs:57)), so interruption can leave the measurement subject mutated.

4. **DESIGN — the stale `23 of 90` statement remains live in a reader-facing artifact.**

   The ELI16 document still says “the true figure is 23 of 90” ([ELI16:1528](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/window10-deep-property-guards.eli16.md:1528)). Nine lines later it says the correct total is 91 ([ELI16:1539](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/window10-deep-property-guards.eli16.md:1539)), followed by “We deleted the number” ([ELI16:1548](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/window10-deep-property-guards.eli16.md:1548)). Unlike archived verdict quotations and the struck engineering-log occurrences, the earlier sentence is neither struck nor marked superseded.

## REGRESSION-CHECK

| Pass-30 repair | Result |
|---|---|
| Three lint escapes | **Partial.** Comment-only method declaration now fails, and `(fetch)(url)` is discovered. The exact quote-adjacent string is rejected, but a prefixed string still passes; double-quoted new methods also evade classification. Finding 1. |
| One operation / one record | **Pass.** Adapter `sendToTopic`, adapter `send`, and an added lifeline cardinality control each produced exactly one record and zero network calls. The three terminal branches are at [adapter:1404](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:1404), [adapter:1415](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:1415), and [lifeline:2860](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/lifeline/TelegramLifeline.ts:2860). |
| `Mc`/`Me` over-refusal | **Exact examples pass; rationale fails.** U+0903 and U+20DD are admitted, but category does not determine advance width and U+20D0 remains over-refused. Finding 2. |
| Archive parity assertion | **Pass.** Removing guard-cited-only `pass29-verdict.md` made the repaired assertion fail on the guard’s missing-verdict record ([parity:114](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/guard-population-parity.test.ts:114), [parity:135](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/guard-population-parity.test.ts:135)). |
| Stale denominator | **Fail.** The named engineering-log occurrence is struck, but the reader-facing ELI16 occurrence survives. Finding 4. |

Verification baseline:

- Full `npm run lint`: exit 0.
- Focused committed tests: 73/73 passed with exit 0.
- Added lifeline cardinality control: 70/70 passed in the isolated archive.
- Registry: 89 articles.
- Enforcement gaps: 7/7 swept.
- Workspace restored clean.

## FRESH-ATTACK-REPORT

The new angle was **instrument failure semantics**: what a measuring tool reports when its own dependency cannot run.

That exposed Finding 3. Previous readings mutated refusal arms and asked whether tests reddened; this reading removed the ability to answer. The tool converted “unknown” into a numerical zero and success.

This pass is also the first useful question comparison. Pass 30 and pass 31 ask the same fresh-soundness, repair-regression, and new-angle questions ([pass30:36](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/reports/window10-external-passes/pass30-question.md:36), [pass31:38](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/reports/window10-external-passes/pass31-question.md:38)). The new findings therefore cannot reasonably be attributed to a friendlier brief.

## MY-ACCOUNT-CHECK

The account is materially false.

- Current `HEAD` is `78eb54e13`, not `c0731d998`; its only descendant change is `pass31-question.md`. All substantive reviewed paths are byte-identical to the frozen commit.
- The worktree is clean.
- I could not independently re-verify `local == remote`: the checkout has no remote-tracking ref for this branch, and network DNS was unavailable. I neither affirm nor refute that prompt claim.
- “All five are repaired”: false.
- Finding 1: the three exact demonstrations were narrowed, but the live-call and method-classification guarantees remain false-clean.
- Finding 2: accurate; all three retry sites are terminal for this error.
- Finding 3: exact `Mc`/`Me` behavior changed, but “advance width” is not the category boundary the code implements.
- Finding 4: accurate and sabotage-proven.
- Finding 5: false as a repository-wide deletion claim; ELI16 retains the stale present-tense number.
- Article 89’s recorded-question move is present and its documented-only status is honest ([registry:679](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/STANDARDS-REGISTRY.md:679), [registry:684](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/STANDARDS-REGISTRY.md:684)).

## MAGNITUDE-METRIC

**Magnitude: 4 load-bearing root findings — 4 DESIGN, 0 PRECISION. None of the four is counted out.**

A root counts when execution demonstrates incorrect runtime behavior, an asserted protection accepts a mutation inside its stated class, a measuring tool returns a result without measuring, or a current artifact states a reproducibly false system fact.

Exclusions:

- The prefixed string and double-quoted method escapes count as one root because both are the lint’s source-text-as-semantics design.
- Exact repair controls that held are not findings.
- The question-only descendant commit is excluded from the frozen-tree magnitude.
- Unverified remote parity is excluded because this environment had neither a tracking ref nor network access.
- The initial package-manager network failure and Vitest cache `EPERM` are excluded; direct `vitest --cache=false` reruns passed.
- Existing named commitments such as CMT-1246/CMT-1248 are not recounted merely for remaining open.

## TRAJECTORY

The late sequence is now:

`1 → 4 → 7 → 6 → 6 → 5 → 4` for passes 25–31.

Unlike earlier comparisons, the last step was obtained under a near-frozen question, so the numerical decline is more comparable. It still does not establish convergence:

- Finding 1 is an incomplete repair of pass 30’s headline lint defect.
- Finding 2 is a surviving predicate boundary hidden by two selected positive controls.
- Finding 4 is another surviving copy of the stale denominator.
- Finding 3 is older measurement machinery reached by a new attack.

The count fell, but three of four roots were already present rather than introduced by these repairs.

## CONVERGENCE

**Not achieved.**

Two repairs—record cardinality and archive parity—now withstand direct sabotage. The tree nevertheless retains two pass-30 root classes, an over-refusal justified by a false mechanical boundary, and a measurement tool that returns success when it cannot measure. One comparable decline from five to four cannot outweigh four live DESIGN findings.

## COHERENCE

Article 89 is coherent and unusually honest about being documented-only. Its archived-question move works: this verdict can be compared with pass 30 without reconstructing the prompt.

The central Telegram runtime is also materially improved: tested invisible payloads are suppressed at all three agent funnels, ordinary payloads deliver, and refused operations now emit one record.

The surrounding assurance layer is not coherent:

- A function headed “strip … string literals” strips only comments.
- A “closed-world” method check recognizes one quote style.
- A category predicate is explained as an advance-width predicate.
- A document says both “23 of 90 is true” and “the total is 91; we deleted 90.”
- A coverage instrument converts runner failure into a successful zero.

That the full lint chain is green over all five contradictions is itself the practical coherence result.

## VERDICT

**REJECT.**

The runtime repair has real value, but the frozen tree is not sound. The lint remains false-clean, the predicate still over-refuses a rendered graphic mark under a factually wrong boundary, the coverage instrument can publish a number without running its tests, and the allegedly deleted stale denominator remains live.
```
