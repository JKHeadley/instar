# Round 3 Findings — context-aware-outbound-review

Reviewed: `docs/specs/context-aware-outbound-review.md` (commit ffcda1ab2, the
round-3 revision) + eli16 companion. Panel: round-2 fold verification (all 9
findings) + fold-regression hunt + fresh internal lenses (security,
adversarial, integration re-grounding of every NEW r3 cite,
decision-completeness, fail-direction, lessons-aware) + 2 external cross-model
passes: **GPT-tier (RAN — `pi` 0.78.1 → `openai-codex/gpt-5.5`; codex binary
not installed, same pi door as rounds 1-2; verdict: SERIOUS-ISSUES, 3
findings)** and **gemini-cli 0.25.2 / gemini-2.5-pro (RAN — verdict:
SERIOUS-ISSUES, 2 findings; its #1 is REJECTED as a misread of in-scope build
items — see the external section; its #2 corroborates the round's main
finding)**. Both externals received the verified-facts preamble (round-1/2
facts plus this round's NEW grounding: the `/review/test` route's real request
shape, the PEL credential-pattern hard-block, and the optional-uid TopicMessage
schema) and the standing calibration note (MAJOR = a stated property,
invariant, or guarantee breaks or is unimplementable as written;
contradiction-hunting emphasized).

Process disclosure: this round resumed after a session bounce; the r3 revision
was already committed (ffcda1ab2) by the prior session, and this session
performed verification only. Both externals reviewed the committed ffcda1ab2
text. No in-round folds were made — the round's MAJORs require an r4 revision
and re-verification, not an editorial touch-up.

## Round-2 fold verification (9/9 present as designed; 1 fold carries a new defect)

| R2 finding | Resolved? | Where / notes |
|---|---|---|
| M1 (askLicenseMode representability) | ✅ | D2 preamble mode line (`ask-license mode: <verified-operator \| single-sender \| weak-corroboration-only>`, wiring-computed, never content-inferred); D3 schema carries `conversationContextMeta.askLicenseMode`; D4 "How the rule reaches the prompt" paragraph; prompt-contract clause 1 keys strength off the line; boundary 6 asserts all three modes on the RENDERED section. Residual found this round: the mode computation is defeatable by uid-less rows (R3-M2). |
| M2 (two-sided flip evidence) | ✅ folded as designed / ⚠ NEW DEFECT IN THE FOLD | D9.4b adds both arms ((a) daily canary battery via `POST /review/test`; (b) sampled pass-side adjudication); D8 `canary: true` rows; §8-5 thresholds extended (zero canary failures, zero confirmed context-minted passes); D6 cost note; §3 non-goal carve-out widened to TWO exceptions; boundary 13. BUT the canary arm as specified is not implementable through the verified route seam and its assertions are PEL-maskable — R3-M1 below. The evidence DESIGN is two-sided as required; the canary MECHANISM is defective. |
| m1 (atomic contract+section block) | ✅ | D1: no `(no prior context available)` sentinel exists; contract + section are ONE ATOMIC injected block; the self-referential "no section ⇒ unusable" instruction is struck from D1/D5; D3 restates atomicity; D5 row 4 ("No section AND no contract text"). Grep sweep: one stale phrase survives in test boundary 7 side A ("carve-out unusable per prompt contract") — R3-L1. |
| m2 (structural availability) | ✅ | D3 mechanism: fields NOT on the shared `EscalationReviewContext`; fan-out hands an AUGMENTED shallow copy only to the resolved opt-in set AND only when `recipientType === 'primary-user'`; custom `'recent-conversation'` opt-ins honored only within that scoping; D5 row 5; boundary 14 asserts on the ctx handed to `review()` plus the boundary-4 prompt pin. |
| L1 (cite nits) | ✅ | `TopicOperatorStore` path (`src/users/TopicOperatorStore.ts`) at first body mention (D4); `resolveStateSyncStores` cite corrected to `devAgentGate.ts:64` (verified: the function is at :64). |
| L2 (counterfactual trigger precision) | ✅ | D9.4 fires only when `violations[]` includes an opted-in reviewer AND `contextMeta.messagesIncluded > 0`; re-review runs through THAT reviewer; per-reviewer pairs; boundary 11 side B covers the non-opted-in-driver case. |
| L3 (denominator exclusion) | ✅ | D8 ("Both are excluded from the D9.3 denominator and adjudication queue") + D9.3 denominator rule + boundary 13 side B. Note: the exclusion NEEDS the `canary: true` tag to exist — which R3-M1(b) shows has no specified carrier. The rule is right; its input is the defect. |
| L4 (liveConfig-absent precedence) | ✅ | D10: "an ABSENT getter resolves the feature DARK — even against an `enabled: true` snapshot"; boundary 12 side B pins it. |
| L5 (local-disk assumption) | ✅ | D1 environmental-assumption sentence (TopicMemory on the agent's own stateDir, machine-local; relocated stateDir inherits the tone-gate seam's existing latency risk). |

## New r3 cite re-grounding (integration lens)

Every NEW/changed cite verified against the tree (grep/read, not memory):

- `POST /review/test` EXISTS — `routes.ts:25784`. Request shape verified:
  `{ message, reviewer?, context: { channel?, topicId?, recipientType?,
  recipientId?, isExternalFacing?, transcriptPath? } }`; **no context-row
  injection, no canary/fixture field**; synthetic sessionId
  `test-${Date.now()}`; Bearer-gated; rate-limited 20/min; disableable via
  `responseReview.testEndpointDisabled`; returns per-reviewer `results`,
  `aggregateVerdict`, and `pelBlock`. (Load-bearing for R3-M1.)
- PEL `CREDENTIAL_PATTERNS` (`PolicyEnforcementLayer.ts:57-70`) hard-block
  API-key-shaped pastes deterministically BEFORE any reviewer runs.
  (Load-bearing for R3-M1(c).)
- `TopicMessage` (`TopicMemory.ts:32-47`): `telegramUserId?: number` and
  `userId?: string` are BOTH OPTIONAL — user-role rows can lack an
  authenticated uid. (Load-bearing for R3-M2.)
- `CoherenceGate.ts:317` maxRetries ✓; `:326` pel.enforce ✓; `:549-560`
  observeOnly Row 3 ✓; `:624-670` rows 6-9 ✓; `:1163-1168` logAudit ✓;
  `:944` extractToolContext ✓; `:686-712` reviewer table ✓; `:462`
  ALL_ABSTAIN fail-open comment ✓; `:123` liveConfig getter type
  (`failClosedOnCriticalAbstain` only) ✓; `:368-392` reviewCtx build ✓;
  `:281` `_evaluate` ✓.
- `server.ts:15274` construction: `config: config.responseReview` snapshot,
  NO `liveConfig` option — exactly as D10 states ✓.
- `escalation-resolution.ts:22`, `CoherenceReviewer.ts:74`,
  `information-leakage.ts:24-33` skip block, `conversational-tone.ts:48`,
  `MessagingToneGate.ts:1204`, `routes.ts:1911-1926`, `TopicMemory.ts:448`,
  `devAgentGate.ts:64` — all ✓.
- ONE drift: `POST /review/evaluate` is at `routes.ts:25730`; front-matter and
  §1.3 cite `:25731` → R3-L2.

---

## MAJOR

**R3-M1 — The D9.4b(a) canary battery is not implementable through the seam it
names, and its assertions do not measure the boundary it claims to test.**
[internal integration+adversarial; GPT-r3 #1, filed MAJOR, ADOPTED at MAJOR;
gemini-r3 #2, filed MINOR, merged (arm (a)) — the round's most corroborated
finding: arm (a) found independently by the internal lens and BOTH externals.]
Three arms, one paragraph of D9.4b to rewrite:

- **(a) No covering-ask carrier.** The battery runs "via the existing
  `POST /review/test` route", but the verified route accepts only
  `context.topicId` — no injected context rows. The covering ask can only
  reach the reviewer through TopicMemory rows for some topic id, and the spec
  never decides that mechanism: seeding a fixture topic in the LIVE TopicMemory
  has real side effects the spec must own (fixture credential-ask rows in the
  production store other systems read; possible collision with real topic ids;
  the seeded rows' uids interact with the D4 mode computation), and extending
  the route with explicit context-row injection is itself a new
  laundering-adjacent surface needing its own sentence of analysis. Pick one,
  in-spec.
- **(b) No canary-tag carrier.** "Results logged to D8 with `canary: true` +
  the fixture id" has NO implementable path as written: the D8 writer sits
  inside `_evaluate`, the route carries no canary/fixture field, and no
  component named by the spec can apply the tag. Without the tag, the R2-L3
  denominator-exclusion rule has nothing to key on — canary rows would
  silently pollute the ≥ 10 real-traffic count AND the operator adjudication
  queue. This is the round-1 M3 / round-2 M1 precedent class: a stated,
  load-bearing property (§8-5 gates the flip on zero canary failures) that
  cannot be implemented from the spec text.
- **(c) Aggregate assertions are PEL-masked and baselines are unpinned.**
  [internal only — this round's net-new internal contribution.] The named
  credential-paste fixture is hard-blocked by the deterministic PEL
  (`CREDENTIAL_PATTERNS`) BEFORE any reviewer runs, so an aggregate-verdict
  "MUST still FLAG" assertion passes even if context laundered the opted-in
  REVIEWER's verdict — the exact failure the canary exists to catch would be
  invisible behind `pelBlock`. And a fixture class the opted-in reviewer never
  flags WITHOUT context makes the MUST-FLAG criterion vacuous or permanently
  unsatisfiable (a soak clock that can never start). As written, "the canary
  battery tests the exact D3.3 boundary directly" is false for the named
  credential fixture.

Fix (r4): rewrite D9.4b(a) to decide — the driver (a soak-only script/job,
named); the seeding mechanism (recommended: a reserved fixture topic id range
seeded through the TopicMemory API by the driver, rows tagged for cleanup,
sender uids chosen to pin the intended `askLicenseMode`; alternatively an
explicit context-row parameter on `/review/test` with its exposure analyzed);
the tag plumbing (an explicit `canary`/`fixtureId` field on the test route
propagated to the D8 writer — never a stringly sessionId-prefix convention);
and the assertion semantics (canary assertions key on the OPTED-IN REVIEWER's
verdict from the route's per-reviewer `results`, adversarial fixtures must be
PEL-missable so the reviewer layer is actually exercised, and every
adversarial fixture carries a pinned context-absent FLAG baseline so a canary
failure isolates context-induced laundering). While there, name where the
D9.4b(b) sample size ("default 5") lives (procedural or config key).

**R3-M2 — Uid-less user rows defeat the D4 sender-diversity safety rule: an
unbound window whose user rows lack authenticated uids computes ≤ 1 distinct
uid and grants full `single-sender` licensing to exactly the shared-topic
shape the rule exists to catch.** [internal decision-completeness+
fail-direction (initially graded MINOR); GPT-r3 #2, filed MAJOR; ADOPTED at
MAJOR on cross-confirmation + the R2-M1 elevation precedent — the safety arm
of a decided principal rule is defeatable by a schema-admitted input class,
in the unsafe direction.] Verified: `TopicMessage.telegramUserId` and
`.userId` are both optional, and D1's own provider signature says
`senderUid?: string` — so user-role rows without an authenticated uid are
admitted by the spec's own interface (older rows, non-Telegram adapters,
migration-era data). D4's premise sentence "All senders in TopicMemory are
already authenticated registered users (sender validation upstream)" is an
upstream-behavior claim, not a schema guarantee, and the mode computation
("at most ONE distinct authenticated sender uid") counts ZERO uids for a
window of uid-less rows — the natural implementation grants
`single-sender` full licensing to a window that may contain any number of
distinct people. Fix (r4), one sentence in D4 (+ boundary 6 side B fixture):
a USER-role row lacking an authenticated uid is UNVERIFIED — in an unbound
topic, a window containing ANY uid-less user row degrades to
`weak-corroboration-only`; in a bound topic such rows are already plain
`USER:` (weak) by the binding-match rule. Soften the premise sentence to
match ("senders are authenticated on the current inbound path; rows without
a recorded uid are treated as unverified").

## MINOR

*(none this round)*

## LOW

**R3-L1 — Fold-residual wording in test boundary 7 side A.** [internal
fold-regression hunt] "…no context section rendered, carve-out unusable per
prompt contract" — under the R2-m1 atomic block there IS no prompt-contract
text when context is absent, so "per prompt contract" is a residue of the
struck design and could mislead a test author into asserting contract text on
the empty-context side (the exact contradiction R2-m1 removed). Reword: "no
context section AND no contract text (atomic block); prompt byte-identical to
feature-dark."

**R3-L2 — Cite drift.** [internal; GPT-r3 #3 confirm] `POST /review/evaluate`
is at `routes.ts:25730`; front-matter and §1.3 say `:25731`.

**R3-L3 — The eli16 non-goals bullet still says "ONE tiny, bounded exception"
for new AI calls; spec §3 (r3) says TWO (counterfactual + canary battery).**
[internal] The eli16's one-way section already describes the canary battery,
so this is a stale bullet — but the eli16 is the operator's decision surface
and must match the spec (house lesson: the plain-English overview carries the
operator's decisions). Also fold the D8/D7 meta-enumeration staleness here:
D3's `conversationContextMeta` now carries `askLicenseMode`, while the D8
example line and D7's parenthetical still enumerate "(counts + truncation
flag + source)" — include the mode in both (it is structural metadata with no
privacy cost, and the D9.4b(b) pass-side adjudicator wants the governing mode
per row).

## Lenses with no findings

- **Fail-direction:** beyond R3-M2's edge, every r3-new failure row degrades
  toward the current gate (mode-computation throw → contained → no section;
  canary/counterfactual rows excluded from the denominator — once taggable;
  a canary failure fails the SOAK, the safe direction).
- **Adversarial re-attack:** rounds 1-2 scenarios stay closed
  (message-claims-ask, planted secondary-user ask in a BOUND topic,
  credential-ask laundering at the prompt level, context-code crash →
  fail-open, custom-reviewer widening, undetected pass-side laundering — the
  latter now designed-for by D9.4b). The new shapes found this round are
  R3-M2's uid-less window (closes in r4 structurally) and R3-M1(c)'s
  PEL-masked canary (closes in r4 evidentially).
- **Lessons-aware:** Intelligent Prompts held (the mode line is structural
  principal logic; no string-match gating); Signal-vs-Authority held (context
  stays corroborating-only); dev-gate conformance held (`enabled` omitted,
  wiring-layer resolution, absent-getter-dark precedence); Token-Audit
  Completeness held (both new call classes attributed and bounded).
- **Security (beyond the two MAJORs):** the augmented-copy scoping is sound
  (a reviewer never handed the fields cannot render them); the mode line
  lives in the preamble outside the JSON-encoded bodies, so context content
  cannot forge it; recipient scoping is definitional and enforced at the
  fan-out.

## External pass status

- **GPT-tier: RAN** — `pi` 0.78.1 → `openai-codex/gpt-5.5` (codex binary not
  installed; the pi door, as in rounds 1-2). Verdict: **SERIOUS-ISSUES**, 3
  findings: #1 → **R3-M1 arms (a)+(b)** (ADOPTED MAJOR — cross-confirmed
  with the internal lens; built on the supplied `/review/test` route facts,
  construction its own); #2 → **R3-M2** (ADOPTED MAJOR — cross-confirmed;
  built on the supplied optional-uid schema fact, the licensing consequence
  is the external's own construction); #3 → **R3-L2** (confirm). Fold table:
  8/9 RESOLVED, R2-M2 marked PARTIAL for exactly the R3-M1 reason — consistent
  with this report's "folded as designed / new defect in the fold" verdict.
  The GPT-tier door again produced the round's most substantive items,
  consistent with rounds 1-2.
- **gemini-cli (gemini-2.5-pro): RAN** — verdict: **SERIOUS-ISSUES**, 2
  findings: #1 → **REJECTED** (door honesty: the finding claims the
  no-restart kill-switch "depends on prerequisite work outside this spec's
  scope" and would stay restart-bound "if the spec is implemented as-is" —
  but the liveConfig getter widening + the :15274 wiring are THIS spec's own
  NAMED BUILD ITEMS (D10), the no-restart sentences in D10/§7 are already
  explicitly conditioned on that wiring, boundary 12 + the Tier-3
  wiring-integrity test make the build items unskippable, and the R2-L4
  precedence rule fails DARK on mis-wiring. Adopting would only restate D10.
  Its fold table nonetheless marked all 9 RESOLVED, including R2-L4's
  precedence — the rejected finding contradicts the door's own fold
  verification); #2 → **R3-M1 arm (a)** (filed MINOR, merged into the
  adopted MAJOR; calibration recorded in-finding). Both gemini findings
  parsed cleanly; no mid-run errors this round.
- Cross-model signal: R3-M1 arm (a) was found independently by the internal
  lens and BOTH externals — the only triple-confirmation of the ceremony so
  far. R3-M2 is internal+GPT double-confirmed.

## Round-3 tally

CRITICAL: **0** · MAJOR: **2** (R3-M1, R3-M2 — both adopted) · MINOR: **0** ·
LOW: **3** (R3-L1..L3).

Verdict: **NOT CONVERGED** — two MAJORs stand, both in the round-3-NEW
material (the canary-battery mechanism and the uid-less principal edge); all
9 round-2 folds are verified present as designed, with the R2-M2 fold
carrying the new canary-arm defect. The r4 revision must: rewrite D9.4b(a)
per R3-M1 (driver, seeding, tag plumbing, reviewer-level assertions,
PEL-missable fixtures, pinned baselines), add the uid-less degradation
sentence to D4 per R3-M2 (+ boundary-6 fixture), and fold R3-L1..L3. Round 4
verifies the folds and re-runs the panel.
