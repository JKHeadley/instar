# External review pass 30 — reviewer's verbatim final answer — **REJECT, load-bearing 5, ALL 5 DESIGN**

**The first reading in thirty whose QUESTION was archived before it ran** (`pass30-question.md`), which is
move (A) of article 89, applied to itself. It followed both new requirements: every finding DECLARES its
class, and the magnitude metric states its own exclusions beside the number.

Run against `12c6aab19`. Exploration logs are NOT kept; only the final answer block.

---

```text
## FINDINGS

1. **DESIGN — major: the new Telegram lint accepts three false-clean states, so its population and “closed-world” claims do not hold.**

   - Replacing the Gemini sender’s guard with the string expression `void 'assertTelegramPayloadVisible(';` still produced “clean — 6 … all invoking”. The matcher strips comments but does not lex string literals ([lint:105](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:105)).
   - Adding `'sendPhoto'` only inside a comment in the bodyless set, then making a real `apiCall('sendPhoto')`, also passed. `readDeclaredSet` extracts every quoted word, including comments ([lint:76](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:76)).
   - A seventh unguarded direct sender using the semantically identical `(fetch)(url)` was invisible because sender discovery requires textual `fetch(` ([lint:152](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:152)). The baseline stayed six because additions cannot shrink it ([lint:180](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:180)).

   These are one root finding, not three independent counts: source-text presence is being used as evidence of live calls, classified methods, and sender membership.

2. **DESIGN — major: one refused operation emits two structured refusal records.**

   Both `sendToTopic` implementations catch every first-attempt error as though it were a Markdown failure and call the guarded funnel again ([TelegramAdapter.ts:1404](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:1404), [TelegramLifeline.ts:2860](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/lifeline/TelegramLifeline.ts:2860)). An invisible-payload refusal is therefore logged, caught, retried, and logged again.

   Executing one attempted adapter send and one lifeline send independently produced `STRUCTURED_RECORDS=2` each, with zero network calls. Existing tests assert network suppression but never assert one decision record per operation ([test:108](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/telegram-send-funnel-invisible-payload.test.ts:108), [test:214](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/telegram-send-funnel-invisible-payload.test.ts:214)). This doubles refusal metrics and makes the new observability stream an operation-counting instrument that counts attempts instead.

3. **DESIGN — major: the positive predicate refuses visibly graphic category-`M` input.**

   The predicate admits only `L/N/P/S`, deliberately excluding every mark ([invisible-payload.ts:41](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:41)). Execution confirmed that both visible `ः` (U+0903 DEVANAGARI SIGN VISARGA, `Mc`) and `⃝` (U+20DD COMBINING ENCLOSING CIRCLE, `Me`) return `hasNoVisibleCharacters=true`.

   Unicode defines category `M` as graphic and permits isolated combining characters to be presented graphically as base characters; representative charts show them visibly. [Unicode Standard, Chapter 3](https://www.unicode.org/versions/Unicode17.0.0/core-spec/chapter-3/). The spec honestly narrows its guarantee to “mechanically-visible” ([spec:196](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/telegram-egress-invisible-payload-guard.md:196)), but its product intent remains reader visibility. The new definition over-refuses real graphic content.

4. **DESIGN — major: one of the four new population-parity assertions is tautological.**

   The archive test compares `json.archivedVerdicts` with a second count of the same directory ([guard-population-parity.test.ts:103](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/guard-population-parity.test.ts:103)); it never compares cited passes with filed verdicts.

   In an isolated frozen-tree copy, I removed `pass29-verdict.md`. The authority correctly reported `citedPasses: 29`, `archivedVerdicts: 28`, and a missing-verdict failure ([lint-account-matches-tree.mjs:450](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-account-matches-tree.mjs:450)). The test titled “archive holds a verdict for every review pass the tree cites” still passed. The underlying lint holds; this new parity arm adds no protection.

5. **DESIGN — major: the stale `90`-arm figure was not deleted from the artifact.**

   A live, unstruck sentence still states **“23 of 90 arms (26%)”** at [window10-deep-property-guards.md:2104](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/upgrades/side-effects/window10-deep-property-guards.md:2104). Later occurrences were struck at [line 2530](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/upgrades/side-effects/window10-deep-property-guards.md:2530), but this earlier claim was missed.

   Re-deriving the denominator with the measurement script’s exact two rules produced `12+39+17+7+12+4 = 91`; those rules are at [measure-refusal-arm-coverage.mjs:43](/Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/measure-refusal-arm-coverage.mjs:43). Thus the repair’s own sweep account is false.

## REGRESSION-CHECK

| Change | Result |
|---|---|
| Positive predicate and five blank glyphs | The five fixtures hold, but category-`M` over-refusal is a regression: Finding 3. |
| Third egress/standby relay | Delivery safety holds: invisible input never relays or fetches; visible input still relays. |
| Closed-world method classification | Current literals are classified; adversarial comment syntax defeats the claimed closure: Finding 1. |
| Structured records | Fields, engine, and payload omission hold; record cardinality does not: Finding 2. |
| Mechanism-derived lint and shrink ratchet | Baseline six holds; string, method-comment, and seventh-sender mutations pass clean: Finding 1. |
| Article 89 and seven gap sweeps | Holds. Registry reports 89 articles; all seven gap sweeps are current. |
| Stale-figure deletion | Does not hold: Finding 5. |
| New population-parity commit | Three useful arms pass; the archive arm is inert: Finding 4. |

`npm run lint` completed successfully. The two focused files passed 68/68 tests. A wider run passed 120 cases; six route cases could not start because this sandbox forbids binding `0.0.0.0`, so those are execution exclusions, not attributed regressions.

## FRESH-ATTACK-REPORT

The new angle was **measurement cardinality and instrument grammar**, not another search for an unguarded named route.

That found what passes 1–29 could not see:

- Structured refusal records did not exist before this increment, so earlier readings could not observe that one operation becomes two records.
- The lint was attacked as a parser: strings, comments, and semantically equivalent call syntax, rather than deleting one of the known guards.
- The Unicode predicate was tested against graphic marks rather than additional “blank” code points.
- The new parity test was sabotaged at its stated boundary—citation population versus archive population.

## MY-ACCOUNT-CHECK

The account is only partly accurate.

- The live checkout is clean at `12c6aab19`; `00fad0bfb` is its parent. The sole descendant change is the archived pass-30 question, so substantive target surfaces equal the frozen commit.
- Predicate rewrite and five blank exceptions: accurate, except “eight non-printing classes” conflates eight fixtures with six listed classes and wrongly treats all combining marks as nonprinting.
- Third egress: accurate.
- Closed-world classification: refuted by Finding 1.
- Structured records: accurate in shape and privacy, false as one-record-per-refusal observability because of Finding 2.
- Mechanism-derived population: accurate for the current six literal shapes, not for future direct senders generally.
- Article 89 and seven re-reached sweeps: accurate.
- “Two stale figures were deleted”: false. Git contains twelve commits after pass 29 and the artifact contains five numbered increments, not seven under either mechanical count. Three distinct stale figure repairs landed, and one live `23/90` occurrence remains.

The commit/increment-count discrepancy is not separately counted below because it belongs to the prompt-only descendant, not the frozen target.

## MAGNITUDE-METRIC

**Magnitude: 5 load-bearing root findings — 5 DESIGN, 0 PRECISION.**

A root counts when it demonstrates current incorrect runtime behavior, a claimed protection passing a mutation inside its stated class, or a committed artifact asserting a reproducibly false fact about the machinery.

Exclusions:

- The three lint exploits count as **one** root finding because all arise from the same source-text-as-semantics design.
- Prompt-only commit/increment bookkeeping is excluded from the frozen-tree count.
- The six `EPERM` route-test failures are excluded because the sandbox prevented test setup.
- Known and explicitly tracked centralized-client/runtime-path limits are not recounted merely for existing.
- No finding is excluded for being “only” documentation: Finding 5 is included because the supplied classification explicitly makes factual system errors DESIGN.

## TRAJECTORY

Only after reaching the independent result did I read the prior verdicts. Their late load-bearing sequence is:

`1 → 4 → 7 → 6 → 6 → 5` for passes 25–30.

That last decline is not convergence evidence by itself. Four of this pass’s five roots arise in the new predicate, lint, parity test, or structured-record interaction; one is an older stale statement the repair sweep missed. The changed question also recovered a carried defect after pass 29 reported pre-existing yield at zero. That demonstrates article 89’s point: the earlier zero was about the prior search, not a census of the tree.

## CONVERGENCE

**Not achieved.**

The numerical magnitude moved from six to five, but four findings are supplied by the latest repair machinery itself, two new safeguards pass direct negative controls, and a repaired stale figure remains live. A one-step decline under a changed instrument is insufficient, especially when the composition remains predominantly repair-induced.

## COHERENCE

Article 89 itself is coherent and honestly documented-only. The question was archived before this reading, its enforcement absence is stated, and the seven gap sweeps are current.

The Telegram change is less coherent:

- The spec carefully says the lint proves file presence, yet the lint’s header says every class is protected.
- The observability addition records attempts while presenting them as refusal decisions.
- Reader visibility is the product intent, while all category-`M` graphics are refused.
- The artifact teaches that derived figures must replace transcription while leaving the stale transcription live.

The central runtime safety property is materially improved: the three named agent funnels do refuse the tested invisible payloads without network egress. The repository’s claims about the surrounding enforcement and measurement are not yet sound.

## VERDICT

**REJECT.**

The runtime egress repair largely works, article 89 holds, and the full lint chain is green. But the tree is not sound: the new lint accepts false guards, hidden methods, and hidden senders; one operation produces two refusal records; valid graphic marks are rejected; one new parity assertion cannot fail at its named boundary; and the stale denominator remains live after its claimed deletion.
```
