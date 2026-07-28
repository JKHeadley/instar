# Round 2 Findings — context-aware-outbound-review

Reviewed: `docs/specs/context-aware-outbound-review.md` (commit 127cff334, the
round-2 revision). Panel: round-1 fold verification (all 15 findings) +
fold-regression hunt + fresh internal lenses (security, adversarial,
integration re-grounding of every NEW r2 cite, decision-completeness,
fail-direction, lessons-aware) + 2 external cross-model passes: **GPT-tier
(RAN — `pi` 0.78.1 → `openai-codex/gpt-5.5`; codex binary not installed,
same pi door as round 1; verdict: SERIOUS-ISSUES, 3 findings)** and
**gemini-cli 0.25.2 / gemini-2.5-pro (RAN — verdict: MINOR-ISSUES, 1
finding; its stderr showed one internal generateJson retry-exhausted error
mid-run but the pass produced a complete, valid verdict + finding — disclosed
for door honesty)**. Both externals received the round-1 verified-facts
preamble plus a round-2 calibration note (MAJOR = a stated property,
invariant, or guarantee breaks; contradiction-hunting emphasized).

## Round-1 fold verification (15/15)

| R1 finding | Resolved? | Where / notes |
|---|---|---|
| M1 (info-leakage opt-in) | ✅ | D3 v1 set = `conversational-tone` ALONE with the three grounds pinned; §3 non-goal; D6 cost 1-of-9; D10 `injectReviewers` single entry; boundary 4 asserts info-leakage's prompt NEVER contains conversation; §8-4. Residual found this round: the availability mechanism + custom-reviewer opt-in path (R2-m2). |
| M2 (liveConfig / dev-gate wiring) | ✅ | D10 two named build items (widen getter shape + pass at :15274); wiring-layer resolution via the `resolveStateSyncStores` pattern; §7 rollback re-worded; boundary 12 + Tier-3 wiring-integrity. |
| M3 (one-way unmeasurable) | ✅ | D9.4 bounded counterfactual re-review (pairId rows in D8, soak-only); §3 exception named; D6 cost note; boundary 11. Residuals: trigger precision (R2-L2); and R2-M2 exposes that D9 measures only the BLOCK side — the PASS side is still unmeasured. |
| M4 (Stop-hook seam) | ✅ | New D5a: seam statement + two-sided harm model; summary honesty note; D9.5 ties "enforcement" to turn-revision authority; §3 bans pre-send relocation. |
| M5 (7 open questions) | ✅ | §8 rewritten as 7 DECIDED defaults with alternatives; status line updated; zero live "open question" references remain in the body. |
| M6 (containment vs fail-open seam) | ✅ | D5 total containment rule naming the route catch (~25778); expanded failure table; boundary 2 per-step throw fixtures. |
| m1 (sentinel contradiction) | ⚠️ RESOLVED WITH REGRESSION | The sentinel is gone everywhere — but the fix text introduced a NEW contradiction (R2-m1 below): D1/D5 keep a prompt-contract line "if no RECENT CONVERSATION section is present, the ask carve-out is unusable" (implies STATIC contract text in the prompt) while boundaries 1/3 demand prompts BYTE-IDENTICAL to feature-dark when context is absent. Exactly the fold-regression class this round hunts. |
| m2 (sync vs timeout) | ✅ | D1 decided sync; D5 table has no timeout row. (gemini this round adds the missing environmental assumption — R2-L5.) |
| m3 (reviewers name collision) | ✅ | Renamed `injectReviewers` with rationale comment in D10. |
| m4 (multi-sender unbound) | ✅ decided / ⚠️ under-specified | D4 sender-diversity rule decided + boundary 6 + §8-1 — but HOW the mode reaches the prompt is unspecified; elevated to R2-M1 this round (cross-confirmed). |
| m5 (CLAUDE.md dark honesty) | ✅ | §4.3 carries the 501/dark-honesty phrasing requirement. |
| L1 (self-echo) | ✅ | D1 note present. |
| L2 (textHead at-rest) | ✅ | D8 at-rest honesty paragraph. |
| L3 (opt-in mechanism) | ✅ stated / ⚠️ direction challenged | D3 mechanism paragraph exists — but its "no per-reviewer context copies" decision is challenged structurally by R2-m2 (GPT r2 #1); superseded in r3. |
| L4 (cite nits) | ⚠️ PARTIAL | `EscalationReviewContext` extension named ✅; `TopicOperatorStore` path still absent → folded into R2-L1. |

## New r2 cite re-grounding (integration lens)

All NEW cites the r2 revision introduced verify against the tree:
`information-leakage.ts:24-33` skip block ✓; `CoherenceGate.ts:317`
maxRetries ✓; rows 6-9 `:624-670` ✓; `CoherenceGate.ts:462` ALL_ABSTAIN
fail-open comment ✓; `CoherenceGate.ts:123` liveConfig type ✓; `routes.ts`
~25778 fail-open catch ✓; `devAgentGate.ts` `resolveStateSyncStores` — the
function is at **:64**, spec cites `:66-82` (off-by-2 nit → R2-L1).

---

## MAJOR

**R2-M1 — The D4 principal rule is not representable in the proposed
schema/rendering: the prompt cannot distinguish "plain USER counts fully"
from "plain USER is weak corroboration only."** [GPT-r2 #2, filed MAJOR,
ADOPTED at MAJOR; independently found by the internal decision-completeness
lens this round (initially graded MINOR as a "rendering detail") — elevated
on cross-confirmation + the round-1 M3 precedent class: a stated normative
rule that cannot be implemented from the spec text.] D4 requires four
different ask-license strengths (verified-operator / non-matching-user in a
bound topic / unbound-single-sender / unbound-multi-sender), but the schema
carries only `verifiedOperator?: boolean` and the rendering only
`USER(verified-operator):` vs `USER:` — the reviewer cannot count distinct
uids from labels, so the unbound modes are unenforceable as written. Fix
(r3): the wiring computes an explicit **`askLicenseMode`**
(`'verified-operator' | 'single-sender' | 'weak-corroboration-only'`) into
`conversationContextMeta`; the renderer emits it as ONE structural line in
the section preamble; prompt-contract clause 1 keys the carve-out's strength
off that line. Structural principal logic (authenticated uids), not
string-matching — Intelligent Prompts compliant.

**R2-M2 — The flip evidence is one-sided: D9 can prove reduced false
positives and no context-minted BLOCKS, but cannot detect context-minted
PASSES — including an over-applied carve-out suppressing a legitimate
credential/PII-class flag despite D3.3.** [GPT-r2 #3, independent
construction, ADOPTED at MAJOR.] D9.3 adjudicates only `llmVerdict: BLOCK`
lines; D9.4's counterfactual fires only on would-blocks. A pass that context
wrongly laundered never enters any adjudication queue — yet "context cannot
smuggle unsafe content past the gate" is precisely the security claim the
enforcement-readiness proposal rests on. Fix (r3), two bounded arms added to
D9: **(a) a daily adversarial canary battery** replayed against the LIVE
soak config via the existing `/review/test` route — fixed fixtures including
credential-paste-with-covering-ask and PII-with-covering-ask (must still
FLAG; any canary pass fails the soak and resets the clock) plus the two
veto-day messages as pass-side controls (must PASS); deterministic, zero
per-message cost; results logged to D8 with `canary: true`; **(b) sampled
pass-side adjudication** — the operator adjudicates a small daily sample of
`llmVerdict: PASS` lines with `contextMeta.messagesIncluded > 0` for
context-minted passes. The full reverse counterfactual (re-review every pass
without context) is REJECTED — it would double reviewer spend for a
low-yield signal; the canary battery tests the exact D3.3 boundary directly.

## MINOR

**R2-m1 — Fold-regression of round-1 m1: the "no section ⇒ carve-out
unusable" prompt-contract line contradicts the byte-identical-when-absent
property.** [internal fold-regression hunt; neither external raised it.]
D1/D5 imply the contract text is STATIC (it self-referentially instructs
about its own section's absence) while D1's fail-to-absent clause and
boundaries 1/3 require prompts byte-identical to feature-dark when context
is absent. Both cannot hold. Fix (r3): the carve-out contract and the
context section are ONE ATOMIC injected block — absent context ⇒ NOTHING
injected (the pre-existing static "Code the user explicitly asked to see"
exception stands exactly as today); the "no section ⇒ unusable" sentence is
struck from D1 and D5.

**R2-m2 — Context availability must be structural, not disciplinary:
`recentConversation` on the shared ctx passed to ALL reviewers relies on
reviewer implementation discipline, and the custom-`DynamicReviewer`
`'recent-conversation'` opt-in is a config-only widening path that partially
contradicts the M1 pin.** [GPT-r2 #1, filed MAJOR, calibrated MINOR +
internal security lens (custom-reviewer hole + recipient scoping) — merged.
Calibration honesty: no stated property is FALSE as written — built-in
reviewers' `buildPrompt` provably don't reference the new fields and
boundary 4 pins that byte-unchanged; the gap is future-drift structure and
the custom-reviewer path, i.e. the house Structure > Willpower principle
applied to our own mechanism. The external's structural instinct is adopted
even at the lower grade.] Fix (r3), one structural rule closing all three
arms: the fields are NOT placed on the shared ctx; the fan-out hands an
AUGMENTED shallow copy (base ctx + context fields) ONLY to reviewers in the
resolved opt-in set AND ONLY when `recipientType === 'primary-user'`; every
other reviewer receives the base ctx object, which never carries
conversation. A custom reviewer's `'recent-conversation'` requirement is
honored only within that same scoping — so a config-only opt-in can never
expand exposure beyond what M1 accepted (primary-user-recipient reviews of
the primary user's own conversation). Supersedes round-1 L3's "no
per-reviewer copies" decision (recorded).

## LOW

**R2-L1 — Cite nits (fold of round-1 L4 residual + one new).**
`TopicOperatorStore` path (`src/users/TopicOperatorStore.ts`) named at first
mention; `resolveStateSyncStores` cite corrected to `devAgentGate.ts:64`.

**R2-L2 — D9.4 trigger precision.** [internal] "Every `llmVerdict: BLOCK`
line with context present" fires the counterfactual even when the aggregate
BLOCK came solely from a reviewer that never saw context — pointless spend
and a muddied pair signal. Fix: trigger only when `violations[]` includes an
opted-in reviewer; compare that reviewer's paired verdicts, not the
aggregate.

**R2-L3 — Counterfactual/canary rows vs the D9.3 denominator.** [internal]
State that `counterfactual: true` and `canary: true` rows are excluded from
the "≥ 10 reviewed real messages" count and from adjudication scope.

**R2-L4 — liveConfig-absent precedence in normative text.** [internal]
Boundary 12 side B decides "getter absent → dark"; add the sentence to D10
so the normative text records that a missing getter darks the feature even
against an `enabled: true` snapshot.

**R2-L5 — The sync-provider decision assumes a local-disk SQLite file, and
the assumption is unstated.** [gemini-r2 #1, filed MINOR, calibrated LOW:
the identical synchronous call already runs inline at the always-on
tone-gate seam (`routes.ts:1913-1926`) — this spec adds no new exposure
class, and TopicMemory is constructed on the agent's own stateDir. Adopted
as a one-sentence environmental assumption in D1: the store is assumed
machine-local (the house layout); an install that relocates stateDir onto
network storage inherits the same latency risk the tone gate already has.]

## Lenses with no findings

- **Fail-direction:** D5 containment + D5a harm model hold; every new
  failure row degrades toward the current gate; R2-M2 is an evidence gap,
  not a failure-direction gap.
- **Adversarial re-attack:** round-1 scenarios stay closed
  (message-claims-ask, planted secondary-user ask, credential-ask
  laundering at the PROMPT level, context-code crash → fail-open). The new
  shapes found this round are R2-m2's custom-reviewer widening (closed
  structurally in r3) and R2-M2's undetected pass-side laundering (closed
  evidentially in r3).
- **Lessons-aware:** Intelligent Prompts, Signal-vs-Authority, and the
  fail-closed precedents all remain complied with; the `askLicenseMode`
  line is structural principal logic, not content string-matching.

## External pass status

- **GPT-tier: RAN** — `pi` 0.78.1 → `openai-codex/gpt-5.5`. Verdict:
  **SERIOUS-ISSUES**, 3 findings: #1 → **R2-m2** (MAJOR→MINOR, calibration
  recorded in-finding); #2 → **R2-M1** (ADOPTED MAJOR — cross-confirmed
  with the internal lens, the round's most material item); #3 → **R2-M2**
  (ADOPTED MAJOR — the external's own construction and the round's best
  catch). The GPT-tier door again produced the round's most substantive
  items, consistent with round 1.
- **gemini-cli (gemini-2.5-pro): RAN** — verdict: **MINOR-ISSUES**, 1
  finding: #1 → **R2-L5** (MINOR→LOW, calibration recorded in-finding).
  One internal retry error appeared on stderr mid-run; the final output was
  complete and well-formed.
- Cross-model signal: R2-M1 was found independently by the internal lens
  and the GPT-tier external (the only double-confirmation this round).

## Round-2 tally

CRITICAL: **0** · MAJOR: **2** (R2-M1, R2-M2 — both adopted) · MINOR: **2**
(R2-m1, R2-m2) · LOW: **5** (R2-L1..L5).

Verdict: **NOT CONVERGED** — two MAJORs stand (the D4 mode-representability
gap and the one-sided flip evidence). All 9 findings are folded into the
round-3 revision committed alongside this report; round 3 verifies the
folds and re-runs the panel.
