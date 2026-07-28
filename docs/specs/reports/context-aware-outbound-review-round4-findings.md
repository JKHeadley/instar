# Round 4 Findings — context-aware-outbound-review

Reviewed: `docs/specs/context-aware-outbound-review.md` (commit f85a455b6, the
round-4 revision) + eli16 companion. Panel: round-3 fold verification (all 5
findings) + fold-regression hunt + fresh internal lenses (security,
adversarial, integration re-grounding of every NEW r4 cite,
decision-completeness, fail-direction, lessons-aware) + 2 external cross-model
passes: **GPT-tier (RAN — `pi` 0.78.1 → `openai-codex/gpt-5.5`; codex binary
not installed, same pi door as rounds 1-3; verdict: MINOR-ISSUES, 3 findings +
1 LOW — the ceremony's FIRST non-SERIOUS GPT verdict)** and **gemini-cli
0.25.2 / gemini-2.5-pro (RAN — verdict: NO-SERIOUS-ISSUES, 1 LOW finding —
the ceremony's first NO-SERIOUS-ISSUES verdict)**. Both externals received the
verified-facts preamble (rounds 1-3 facts plus this round's NEW grounding: the
`/review/test` response shape incl. the violations-only `results` array and
observe-mode aggregate vacuity, `EvaluateRequest`, the TopicMemory
insert/delete/FTS/rebuildTopicMeta mechanics, PEL pattern shapes) and the
standing calibration note (MAJOR = a stated property, invariant, or guarantee
breaks or is unimplementable as written; contradiction-hunting emphasized),
plus the recorded round-3 rejection of the gemini kill-switch misread (not
re-litigated by either external; no new evidence offered).

Process disclosure: the SAME session performed the round-4 revision fold
(f85a455b6) and this verification. Both externals reviewed the COMMITTED
f85a455b6 text, not a working tree. The internal panel re-grounded every
code-facing claim against the worktree tree rather than trusting the fold's
own grounding. Verdict-relevant consequence: all round-4 findings are
sub-MAJOR with unambiguous fix directions; they are folded as a
POST-VERIFICATION EDITORIAL FOLD in the converged-tag commit (each fold
strictly aligns text with already-decided semantics — no new mechanism, no
re-opened decision; every fold is enumerated per-finding below with its exact
scope so the fold itself is auditable against this report).

## Round-3 fold verification (5/5 resolved; internal + BOTH externals concur)

| R3 finding | Resolved? | Where / notes |
|---|---|---|
| M1(a) (no covering-ask carrier) | ✅ | D9.4b(a) Seeding: reserved NEGATIVE topic-id range seeded via the public `TopicMemory.insertMessages` (`TopicMemory.ts:417` — verified) and replayed through the verified `/review/test` `context.topicId` seam; collision impossibility grounded (Telegram ids positive); side effects owned in-text (seconds-long FTS residency via `finally` cleanup; the stale `topic_meta` residue stated honestly — `rebuildTopicMeta` `:857` verified never to delete emptied-topic rows); the D4 mode interaction handled (uid-carrying rows MANDATORY, pinning `single-sender`); the alternative carrier (context-row injection param) explicitly REJECTED with the laundering-surface reason. |
| M1(b) (no canary-tag carrier) | ✅ | D9.4b(a) Tag plumbing: `/review/test` gains `canary`/`fixtureId`, forwarded via a new optional `telemetry` field on `EvaluateRequest` (`CoherenceGate.ts:43` — verified seam), stamped by the D8 writer (new code owned by this spec); explicitly never a sessionId-prefix convention; `/review/evaluate` NEVER accepts the tags (anti-self-tagging, pinned by boundary 13 side B + a Tier-2 test) — so the R2-L3 denominator exclusion now has a real key AND a real turn cannot dodge adjudication. |
| M1(c) (PEL-masked assertions, unpinned baselines) | ✅ | D9.4b(a) Assertion semantics: assertions key on the OPTED-IN REVIEWER's row in the per-reviewer `results` (verified: `_auditViolations` rows carry reviewer+severity), never the aggregate; `pelBlock: false` asserted per arm; fixtures required PEL-MISSABLE by construction (grounded on `CREDENTIAL_PATTERNS`/`PII_PATTERNS`, `PolicyEnforcementLayer.ts:58-82`); every adversarial fixture gets a context-ABSENT baseline arm; the invalid/inconclusive vs laundered/failure outcome table closes the vacuous-MUST-FLAG case. The r4 fold ALSO caught and closed a defect the r3 finding did not name: under `observeOnly: true` Row 3 returns `pass: true` unconditionally (`CoherenceGate.ts:549-560` — verified), so the route's `aggregateVerdict` is VACUOUS in watch mode — the pass-side CONTROLS are therefore also asserted reviewer-level (no opted-in-reviewer violation row). |
| M1 rider (where "default 5" lives) | ✅ | D9.4b(b): PROCEDURAL — the D9 soak runbook step; no config key, no code consumes it. |
| M2 (uid-less rows defeat D4) | ✅ | D4 mode-computation line (single-sender now requires EVERY user-role row uid-carrying + exactly one distinct uid) + the dedicated "Uid-less rows degrade AWAY from licensing" paragraph (schema-grounded, `TopicMemory.ts:32-47`); premise sentence softened; boundary 6 side B fixture added (a window of uid-less rows must NOT compute `single-sender`). One fold RESIDUAL found by the internal regression hunt: R4-L1 below. |
| L1 (boundary-7 residual wording) | ✅ | Boundary 7 side A: "no context section AND no contract text (the atomic block); prompt byte-identical to feature-dark". |
| L2 (cite drift) | ✅ | `:25730` in front-matter, §1.3, and the new D9.4b(a) text; grep-clean of `:25731`. |
| L3 (eli16 ONE-exception + meta enumeration) | ✅ | eli16 says TWO bounded exceptions; D7 enumeration and the D8 example line both carry `askLicenseMode`. |

## New r4 cite re-grounding (integration lens)

Every NEW/changed cite verified against the tree (grep/read, not memory):

- `TopicMemory.insertMessages` `:417` (public; `INSERT OR IGNORE` keyed on
  (message_id, topic_id) — load-bearing for R4-m4), `insertMessage` `:390`,
  `getRecentMessages` `:448`, `deleteMessagesByUser` `:548` (exists today for
  GDPR erasure; calls `rebuildTopicMeta`), `rebuildTopicMeta` `:857`
  (repopulates from a GROUP BY over REMAINING messages — never deletes an
  emptied topic's meta row; load-bearing for the owned-residue sentence and
  R4-L2), FTS5 insert/delete triggers in-schema, `TopicMessage` `:32-49`
  (both uid fields optional) — all ✓.
- `routes.ts:25730` (`/review/evaluate`), `:25784` (`/review/test`), `:25804`
  (the `__test__` 20/min bucket) — all ✓. The test route's `results` =
  `_auditViolations` (VIOLATIONS ONLY — a passing reviewer produces no row),
  `aggregateVerdict` = `result.pass` — verified, load-bearing for the
  reviewer-level assertion design and the observe-mode vacuity note.
- `CoherenceGate.ts:43-59` (`EvaluateRequest`), `:326-340` (PEL hard_block
  short-circuit before reviewers), `:549-560` (Row 3 observe returns
  `pass: true` unconditionally with `_auditViolations` populated) — all ✓.
- `PolicyEnforcementLayer.ts:58` (`CREDENTIAL_PATTERNS`, 15 regexes), `:78`
  (`PII_PATTERNS`) — ✓; a prose-stated secret with no assignment shape
  matches none of them (the PEL-missable fixture class exists).
- D2 renderer emits role labels + JSON-encoded `text` only — `sessionName` /
  `userId` columns are NOT rendered (load-bearing for the R4-m2 fix).

## MAJOR

*(none this round)*

## MINOR

**R4-m1 — D1's provider signature cannot carry the wiring-computed principal
values that D2/D3/D4 require it to deliver.** [internal integration —
pre-existing r2/r3-era text, unflagged by two prior rounds; neither external
found it] D1 declares `conversationContextProvider?: (topicId, limit) =>
Array<{ role; text; senderUid?: string }>`, while D3's `recentConversation`
rows carry `verifiedOperator?: boolean`, D2 says the mode line is "computed at
the WIRING layer … and passed in via `conversationContextMeta.askLicenseMode`",
and D4 says "the wiring layer tags each user message". The gate is explicitly
decoupled from `src/users/` (D1: it "sees only the function"), so it cannot
map `senderUid` → `verifiedOperator` or compute the mode itself — the
wiring-computed values have NO carrier through the interface as literally
written. Severity calibration recorded honestly: this is the R2-M1
carrier-gap CLASS, but unlike R2-M1/R3-M1 every semantic is already decided
in D4 and zero design questions are open — only the signature snippet lags
three decided paragraphs, and the type checker forces the resolution at
build. Graded MINOR; would have been adopted at MAJOR on cross-confirmation
(none occurred). Fix (folded in the tag commit): the provider returns
`{ messages: Array<{ role; text; verifiedOperator? }>, askLicenseMode }`;
the gate copies the mode into `conversationContextMeta`, never computes it.

**R4-m2 — The `[CANARY-FIXTURE]` body prefix is RENDERED into the reviewer's
context window — a test-awareness confound in the instrument.** [internal
adversarial+lessons-aware — a regression introduced by the r4 rewrite itself]
The seeded rows' `text` carries the marker, and the D2 renderer emits
JSON-encoded text — so the reviewer SEES that the covering ask is a fixture. A
reviewer that discounts marked asks makes the MUST-FLAG assertion pass for the
wrong reason: the exact context-laundering the canary exists to catch could
persist on unmarked real traffic while the battery stays green. Partially
self-detecting (the pass-side controls are marked too — wholesale discounting
would make THEM flag, failing the battery visibly), but class-specific
discounting of credential-asks is not bounded by benign-class controls. Fix
(folded): fixture identity is carried ONLY in non-rendered columns
(`userId: 'review-canary-fixture'` + `sessionName`) — the rendered text stays
live-shaped; verified that the D2 renderer never emits those columns.

**R4-m3 — The battery driver's invocation and auth seam are unnamed.**
[GPT-r4 #1, ADOPTED; merged with the internal decision-completeness note]
D9.4b(a) says the driver is "invoked by a new built-in scheduler job" and
makes "~10 route calls" against the Bearer-gated `/review/test`, but never
says how the job reaches `run()` or with what credential. The house precedent
(the `feedback-factory-process` job → `POST /feedback-factory/process`
pattern) makes the fix direction unambiguous. Fix (folded): a Bearer-gated
trigger route `POST /review/canary-battery/run` (503 when the feature is
dark) is part of the driver build item; the job curls it with the agent's own
authToken — the same credential every instar hook/script already holds — and
the driver's `/review/test` replays carry the same Bearer. No auth-less
bypass seam exists.

**R4-m4 — Seeding is not crash/idempotence-safe against `INSERT OR IGNORE`.**
[GPT-r4 #2, ADOPTED] Cleanup lives in a `finally`, but a process crash/kill
skips it and strands fixture rows; on the next run, stable `messageId`s make
`insertMessages` silently no-op against the strays (verified: INSERT OR
IGNORE on (message_id, topic_id)), so the battery could assert against stale
conversation rows from an older fixture version. Fix (folded): each run
PRE-CLEANS (`deleteMessagesByUser('review-canary-fixture')`) before seeding,
seeds with per-run-unique `messageId`s, and asserts the inserted row count
before replaying; a failed seed assertion ⇒ battery INCONCLUSIVE.

**R4-m5 — D8's "one line per `_evaluate` verdict" contract does not cover the
battery SUMMARY row.** [GPT-r4 #3, ADOPTED] D9.4b(a) requires "a per-run
battery summary verdict" logged to D8 — including on REFUSALS, where no
evaluation occurs — but D8 defines exactly one row class (per-`_evaluate`
verdict), leaving the summary row's schema and write seam unspecified. Fix
(folded): D8 names a second, additive row type
(`{ "batterySummary": true, "verdict": "passed|failed|inconclusive", … }`)
written directly by the driver through the same JSONL writer on EVERY run
outcome including refusals.

## LOW

**R4-L1 — Fold residual in D4's v1-rule paragraph.** [internal
fold-regression hunt — the same class as R3-L1] The paragraph still says "if
the fetched window contains asks from at most ONE distinct authenticated
sender uid, any USER-role ask counts" — a window of ALL-uid-less rows has
ZERO distinct uids ("at most one") and would read as licensed under this
sentence, in direct conflict with the adjacent r4 override paragraph (which
explicitly negates the zero-count reading). The override is explicit and
adjacent, so a builder cannot reasonably take the stale sentence over it —
but the two sentences should not disagree. Fix (folded): "if EVERY user-role
row in the window carries an authenticated uid and exactly ONE distinct uid
appears among them, any USER-role ask counts".

**R4-L2 — The topic_meta residue is real but CONSTANT-bounded, not
accumulating.** [gemini-r4 #1, PARTIALLY ADOPTED — door honesty: the residue
and the hygiene concern are real and already owned in the spec's own text;
the external's "permanent, accumulating data leak … each daily run adds"
claim is WRONG on the accumulation arm: the reserved topic ids are FIXED per
fixture and reused every run, so `rebuildTopicMeta`'s INSERT OR REPLACE
updates the SAME handful of meta rows — the residue is bounded by the
fixture-set size, O(1) across runs.] Fix (folded): the residue sentence now
states the constant bound explicitly so no reader mistakes it for growth.

## Rejections (recorded)

- **GPT-r4 LOW (eli16 "Round 3 added" attribution) — REJECTED.** The eli16's
  established convention attributes a change to the round that FOUND it, not
  the revision that folded it: the adjacent pre-existing sentence "Round 2
  added the missing plumbing" refers to the R2-M1 fix folded in the r3
  revision. "Round 3 added one more fail-safe" for the R3-M2 fix folded in r4
  is the same convention. Adopting would break the in-file precedent it sits
  next to. (Door honesty: a reasonable literal reading; the convention is
  in-file, not in the reviewer's packet — no calibration concern.)
- **gemini-r4 #1 accumulation arm — corrected, remainder adopted as R4-L2.**

## Lenses with no findings

- **Security:** the tag plumbing is additive-only (real traffic flows through
  `/review/evaluate`, which never accepts the tags — a real turn cannot be
  laundered out of the adjudication queue); the D8 file remains
  machine-local-plaintext, the pre-existing posture rounds 1-3 accepted;
  negative topic ids are consumed nowhere else in the tree (grounded); the
  fixture rows' seconds-long FTS residency is owned in-text.
- **Fail-direction:** every new battery failure mode degrades toward NOT
  flipping — fixture-invalid/endpoint-disabled/feature-dark ⇒ INCONCLUSIVE
  (the day cannot be the clean day, nothing weakens), laundering ⇒ soak
  failure + clock reset; a crash between seed and cleanup strands only inert
  reserved-id rows now pre-cleaned at the next run (R4-m4). The uid-less rule
  degrades strictly toward weaker licensing.
- **Adversarial re-attack:** rounds 1-3 scenarios stay closed
  (message-claims-ask; planted secondary-user ask in a bound topic;
  credential-ask laundering — now with a real instrument against it; context
  crash → fail-open; custom-reviewer widening; uid-less window — closed
  structurally in D4). New r4 shapes: self-tagging real traffic as canary
  (closed structurally), the marked-fixture confound (R4-m2, folded), stale
  seed reuse (R4-m4, folded).
- **Decision-completeness:** the fixture SET contents are a build item with
  spec-pinned properties (PEL-missable, baseline-validated per run) — the
  mechanism self-validates fixtures, so no open decision hides there; the
  D9.4b(b) sample size is explicitly procedural.
- **Lessons-aware:** Intelligent Prompts held (assertions are structural
  row-presence checks on the reviewer's OUTPUT, not string-matching of its
  reasoning; fixtures are meaning-class defined); dev-gate conformance
  untouched (`enabled` still omitted; the battery gates on the RESOLVED
  feature + observeOnly); Token-Audit Completeness held (battery replays ride
  the already-attributed reviewer callsites; D6's bound still covers ~10
  calls/day); Migration Parity extended honestly (§4 item 5: the job ships
  OFF, soak tooling, normal job-template path).

## External pass status

- **GPT-tier: RAN** — `pi` 0.78.1 → `openai-codex/gpt-5.5` (codex binary not
  installed; the pi door, as in rounds 1-3). Verdict: **MINOR-ISSUES, 3**
  (+1 LOW): #1 → **R4-m3** (ADOPTED — merged with the internal
  decision-completeness note); #2 → **R4-m4** (ADOPTED — built on the
  supplied INSERT-OR-IGNORE fact, construction its own); #3 → **R4-m5**
  (ADOPTED); LOW → REJECTED (eli16 attribution convention, recorded above).
  Fold table: 5/5 RESOLVED. All three adopted findings sit in the r4-NEW
  battery mechanism — the expected distribution (newest material, most
  findings), and the first round the GPT door returned no MAJOR.
- **gemini-cli (gemini-2.5-pro): RAN** — verdict: **NO-SERIOUS-ISSUES**, 1
  finding: #1 → **R4-L2** (PARTIALLY ADOPTED — the accumulation claim
  corrected against the verified fixed-reserved-id design; the hygiene
  remainder folded as the constant-bound clarification). Fold table: 5/5
  RESOLVED. Clean parse, no mid-run errors.
- Cross-model signal: ZERO MAJORs from all eight lenses (six internal + two
  external) — the first such round of the ceremony. No finding this round
  was found by more than one door independently except R4-m3
  (internal + GPT).

## Round-4 tally

CRITICAL: **0** · MAJOR: **0** · MINOR: **5** (R4-m1..m5 — all adopted, all
folded in the tag commit) · LOW: **2** (R4-L1..L2 — folded) · Rejections: 2
recorded.

Verdict: **CONVERGED** — zero CRITICAL, zero MAJOR, and every round-3 finding
verified resolved by the internal panel and BOTH externals (5/5 each). All
round-4 findings are sub-MAJOR with unambiguous, already-decided fix
directions; they are folded as a post-verification EDITORIAL fold in the
converged-tag commit (scopes enumerated per-finding above — no new mechanism,
no re-opened decision, no changed semantics). Convergence trajectory:
r1 6M/5m/4L → r2 2M/2m/5L → r3 2M/0m/3L → r4 0M/5m/2L. The spec is tagged
`review-convergence` and approved for build under the standing Session-A
preapproval (topic 29836); the enforcement flip itself remains gated on the
spec's own D9 evidence bar and is the operator's action alone.
