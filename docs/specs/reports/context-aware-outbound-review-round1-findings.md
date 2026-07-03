# Round 1 Findings — context-aware-outbound-review

Reviewed: `docs/specs/context-aware-outbound-review.md` (commit 41edf6c05 draft)
+ eli16 companion. Panel: 7 internal lenses (security, adversarial,
integration, decision-completeness, fail-direction, lessons-aware,
code-grounding) + 2 external cross-model passes: **GPT-tier (RAN — `pi` 0.78.1
→ `openai-codex/gpt-5.5`; codex binary not installed on this machine, same pi
door as prior ceremonies; verdict: SERIOUS-ISSUES, 6 findings)** and
**gemini-cli 0.25.2 (see external section for run status)**. Door honesty:
both externals received a verified-facts preamble that included the
information-leakage data-minimization contract, the route-level fail-open
catch, the boot-snapshot config fact, and the Stop-hook-after-relay seam — so
external confirmations of those items are corroboration of internally-grounded
facts, not independent discovery; anything an external built ON TOP of those
facts is its own contribution and is attributed.

Code-grounding method: every named module/route/line verified against the real
tree in this worktree (v1.3.728 + draft commit), grep/read, not memory.

## Code-grounding results (integration lens)

All load-bearing cites VERIFY:

- `CoherenceGate._evaluate` (:281), reviewCtx build (:368-392), observeOnly
  Row 3 (:548-558), `logAudit` push+prune (:1163-1168), `extractToolContext`
  (:944), built-in reviewer table (:686-712, default mode 'block'),
  `pel.enforce` (:326, hard_block absolute at :329).
- `ReviewContext` at `src/core/CoherenceReviewer.ts:74` — carries no
  conversation. (Nuance: `_evaluate` builds an `EscalationReviewContext`,
  which `extends ReviewContext` — `src/core/reviewers/escalation-resolution.ts:22`
  — so adding fields to `ReviewContext` reaches all reviewers; see L3.)
- `conversational-tone.ts:48` — "Code the user explicitly asked to see"
  exception, with no conversational input anywhere in its prompt. Confirmed.
- `POST /review/evaluate` at `src/server/routes.ts:25731`; passes
  `context.topicId` + `transcriptPath` through (:25760-25766). `GET
  /review/history` at :25841. Confirmed.
- **Route-level fail-open confirmed**: the route's outer catch returns
  `res.json({ pass: true, ... })` on pipeline error ("Fail-open: if the
  pipeline crashes, let the message through", routes.ts ~25778) — load-bearing
  for M6.
- Tone-gate prior art confirmed: `renderRecentMessages`
  (`MessagingToneGate.ts:1204-1224`, per-call `CTX_BOUNDARY_<hex>`,
  JSON-encoded bodies, last-6/500-char, corroborating-only label) wired at
  `routes.ts:1913-1926` via `topicMemory.getRecentMessages(topicId, 10)`.
- `TopicMemory.getRecentMessages` (:448) — sync (better-sqlite3), rows carry
  `fromUser`, `telegramUserId`, `userId`. Confirmed.
- Stop hook (`PostUpdateMigrator.getResponseReviewHook`, :12855) derives
  `topicId` from `INSTAR_TELEGRAM_TOPIC`, sends `transcriptPath`, sets
  `channel = topicId ? 'telegram' : 'direct'`; block = `exit(2)` → revision.
- `resolveDevAgentGate` funnel (`src/core/devAgentGate.ts:40`),
  `CredentialAuditEmit.scrubString` (:50), DynamicReviewer
  `contextRequirements` (CoherenceGate.ts:1468ff + CustomReviewerLoader).
  Confirmed.
- OQ-7's claim "internal channels are fail-open on ALL_ABSTAIN today" —
  confirmed by the in-code comment at CoherenceGate.ts:462.
- `TopicOperatorStore` lives at `src/users/TopicOperatorStore.ts` (spec's
  front-matter names it without a path — fine).

Facts discovered that the spec does NOT account for (they drive the findings):

- `information-leakage` reviewer **skips entirely when
  `recipientType === 'primary-user'`** (`information-leakage.ts:24-33`) and
  carries an explicit **data-minimization contract** in its header: "receives
  only recipientType + trustLevel (no tool output, no value documents, no
  relationship context)". It is also in `HIGH_STAKES_REVIEWERS` (:151-156).
- The response-review `CoherenceGate` is constructed at
  `src/commands/server.ts:15274` with a **boot-time config snapshot**
  (`config: config.responseReview`) and **without** the `liveConfig` option;
  the existing `liveConfig` getter type covers only
  `failClosedOnCriticalAbstain` (CoherenceGate.ts:123, :819).
- Under enforcement, a BLOCK with retries remaining forces revision (Row 6,
  :624); retry-exhausted → `pass-exhausted` DELIVERY for low-stakes categories
  or HOLD only for external+high-stakes (Rows 7-9, :644-670). `maxRetries`
  defaults to 2.

---

## MAJOR

**M1 — `information-leakage` must be dropped from the v1 opt-in set (or the
opt-in redesigned); as specced it is a privacy regression and a laundering
lever on the third-party leak gate.** [internal security+integration;
externally confirmed: GPT#1 (fact supplied, construction confirmed)]
Three independent grounds: (a) the reviewer NEVER runs on primary-user
recipients, so it fired on zero of the veto-day messages — including it buys
nothing against the problem this spec exists to fix; (b) feeding it recent
conversation violates its own explicit data-minimization contract — the
operator's private chat history would ride into the one reviewer whose job is
guarding messages to OTHER agents, secondary users, and external contacts;
(c) the carve-out's semantics do not transfer: for a non-primary recipient,
"the user asked for this" is ambiguous between the topic's USER-role asks and
the RECIPIENT's asks, and a one-way PASS-ward lever on precisely the
third-party-leakage gate is the exact "context-awareness abused to smuggle
content past the gate" attack the security lens exists to catch (an in-topic
secondary user's ask must never license leaking the operator's context to
them). v1 opt-in set should be `conversational-tone` alone; any future
widening to information-leakage needs its own principal analysis (whose ask,
which recipient) and its own OQ — not a listing in the default array. D6's
"≤ ~2k tokens per turn worst-case (2 of 9 reviewers)" and the D10 default
`reviewers` array revise accordingly.

**M2 — The no-restart kill switch is falsely specified: the gate reads a
boot-time config snapshot and `liveConfig` is not wired at the response-review
construction site.** [internal integration; externally confirmed: GPT#3 (fact
supplied, consequence confirmed)] D10 claims `conversationalContext.enabled:
false` is "read at next evaluate — no restart", and §7 repeats it. Reality:
`server.ts:15274` passes `config: config.responseReview` (snapshot) and omits
`liveConfig`; the getter's type covers only `failClosedOnCriticalAbstain`.
Additionally `resolveDevAgentGate` needs the TOP-LEVEL `developmentAgent`
flag, which `CoherenceGate` never receives — so even the initial gate
resolution cannot happen inside the gate as implied. The spec must specify:
(1) widen the `liveConfig` getter shape to carry `conversationalContext` (and
wire the option at :15274 — a named build item), with the dev-gate resolution
performed against the live top-level config at the wiring layer (or
`developmentAgent` passed through); or (2) drop the no-restart claim and
state the restart requirement honestly (the weaker fix — the house precedent
is live-read kill switches for gates). Either way, decide in-spec.

**M3 — D9.4 ("no new block classes") is unmeasurable from the soak as
designed: the one-way property needs a counterfactual the pipeline never
computes.** [internal fail-direction+measurement; externally confirmed: GPT#5
(independent construction — the "paired shadow evaluation" framing is the
external's)] Verifying "no message that passes without context was
would-blocked with it" requires reviewing the SAME message twice (with and
without context), but §3 forbids new LLM calls and D9 describes only
single-run soak data. As written, the flip criterion cannot be evaluated —
the D9 gate would either be silently skipped or improvised. Decide one: (a)
a bounded, soak-only counterfactual re-review — every `llmVerdict: BLOCK`
line whose `contextMeta.messagesIncluded > 0` triggers ONE context-stripped
re-review of the same message for the opted-in reviewers, logged beside the
original (explicit, bounded carve-out from the no-new-calls non-goal:
would-blocks are rare — 2/12 on the veto day); or (b) downgrade D9.4 to
operator adjudication ("no would-block whose stated issue depends on context
content"), accepting it is a weaker, judgment-based check. Recommended: (a) —
it pins the property on data and the volume bound is tiny.

**M4 — The spec never states what enforcement DOES at this seam — and for the
exact channel that produced the veto data, a Stop-hook block cannot un-send
the already-relayed Telegram reply.** [internal fail-direction; externally
confirmed and sharpened: GPT#2 (fact supplied; the "not an effective outbound
gate for already-relayed replies" framing is the external's)] Telegram
replies go out mid-turn via the relay script (through the MessagingToneGate
authority); the response-review Stop hook evaluates the turn's final text
AFTERWARD, and a block (`exit(2)`) forces the agent to revise the turn — it
cannot recall delivered content. Under enforcement the harm model of a wrong
block is therefore: forced revision churn (≤ `maxRetries`=2), then
`pass-exhausted` delivery for low-stakes categories or HOLD for
external+high-stakes (CoherenceGate rows 6-9) — NOT message loss; and the
protection model of a right block is "the turn's final text is revised,
already-relayed content stands." D5's direction analysis argues only
"strict = safe" and never argues the operator-channel side (The Operator
Channel Is Sacred is cited in front-matter, unused in the body). The spec
must add the seam statement + the two-sided harm model to D5/D9: what a
block does, what it cannot do, and why the flip is still worth gating on
this data (the reviewer's verdict quality is the same signal the tone gate /
future pre-send seams consume; a wrong block still costs churn and
degraded-revision delivery). Without this, "blocking power" throughout the
spec overstates what flips.

**M5 — Decision-completeness: the status line claims "decision-complete" while
§8 leaves SEVEN open questions to the builder/operator, several load-bearing.**
[internal decision-completeness lens; ceremony precedent:
standby-write-reconciliation round-1 M4 — "decision-completeness requires
zero"] OQ-1 (principal scope) is the security posture of the carve-out; OQ-5
(flip thresholds) parameterizes the D9 gate itself; OQ-2 (freshness) changes
the attack/miss window. Each has a recommended default — promote every
recommendation to a DECIDED default in the design body (operator may override
in convergence; a decided-default-with-named-override is decision-complete,
an open question is not), and rewrite §8 as "decisions taken, with
alternatives considered". OQ-6/OQ-7 resolve cleanly as named non-goals with
follow-up filings (they already lean that way). Fold: OQ-1's decision should
ALSO absorb finding m5 (multi-sender unbound topics) rather than deciding
"any USER counts" in isolation.

**M6 — D5's invariant ("no failure of the context machinery may weaken the
gate") is violated by any uncontained throw AFTER acquisition, because the
route's outer catch fails OPEN.** [internal fail-direction; externally filed
as MAJOR: GPT#4 (fail-open fact supplied; the enumeration of uncontained
paths is the external's) — adopted at MAJOR since a claimed §D5 property is
breakable in the unsafe direction] `/review/evaluate` delivers
(`pass: true`) on any pipeline crash. D5 contains ACQUISITION in a try/catch
and D8 swallows writer failures, but the render step (D2), the principal
tagging (D4), the `conversationContextMeta` construction, and the opt-in
injection at prompt-build time are new per-evaluate code with no specified
containment — a bug there crashes `_evaluate` and the unreviewed message
ships. Required: (1) a stated containment rule — ALL new context code paths
(fetch, tag, render, meta, inject, log) are individually contained; any
failure degrades to no-section, never to a throw; (2) D5's direction analysis
names the pre-existing route-level fail-open seam explicitly (it is the
reason containment is load-bearing, and it is itself a pre-existing posture
worth an honest sentence — an outbound "fail-closed" pipeline whose HTTP
wrapper fails open); (3) test boundary #2 widens from provider-throw to
render-time-throw and tag-time-throw fixtures.

## MINOR

**m1 — D1 and D5/D2 contradict on empty history: "empty result ⇒
`recentConversation` stays `undefined` ⇒ byte-identical current behavior"
(D1) vs "Empty history → `(no prior context available)` sentinel" (D2, D5
table row 4, test boundary #1 side B).** [GPT#6 — external's own catch,
adopted] These are different prompts (a sentinel section is not
byte-identical) and different carve-out semantics (sentinel instructs
"carve-out unusable"). Decide one: recommended — empty fetch result ⇒ NO
section (byte-identical), reserving the sentinel for the case where the
feature is live and the fetch SUCCEEDED with zero rows in a topic-bound
review... which is the same case. In practice: pick `undefined`/no-section
for ALL absent/empty/failed paths (simplest, matches D1's fail-to-absent
name), and drop the sentinel from the response-review side entirely (it is
tone-gate prior art, but the tone gate always injects its section; here
opt-in injection makes "absent section" expressible). Align tests.

**m2 — Provider signature is sync but D5 handles "timeout"; a sync call
cannot time out.** [internal] `getRecentMessages` is synchronous
(better-sqlite3, indexed LIMIT query — the tone-gate wiring calls it inline).
Decide: keep the sync signature and strike "timeout" from D5 (recommended;
add "a slow query delays the review like any sync store read — bounded by
SQLite on an indexed key"), or make the provider async with a bounded await.
Do not leave both.

**m3 — `responseReview.conversationalContext.reviewers` (array) collides
with sibling `responseReview.reviewers` (object map) one nesting level up.**
[internal] Same field name, different shape and meaning. Rename to
`injectReviewers` (or `optInReviewers`).

**m4 — Unbound multi-sender topics: "any USER-role ask counts" licenses a
secondary user's ask in a shared unbound topic.** [internal adversarial]
All senders are authenticated registered users (sender validation) and the
credential/PII classes are excluded, so the residual is bounded — but the
spec can tighten structurally for free: when the fetched window contains >1
distinct authenticated sender uid AND the topic has no operator binding,
degrade non-binding asks to weak corroboration (the single-operator install
keeps the full carve-out; the shared-unbound topic — the risky shape — does
not). Fold into the OQ-1 decision (M5). Also note: operator bindings are
AUTO-created from authenticated senders on current agents, so "binding often
absent on healthy single-operator installs" may overstate absence on the
updated fleet — worth verifying against fleet state before resting the
default on it.

**m5 — Migration parity §4.3 references `GET /review/history` and the JSONL
in the CLAUDE.md template but the pipeline is fleet-dark-by-config
(`responseReview.enabled` is an ordinary boolean, currently false on most
installs) — the route 501s there.** [internal] The template text should
carry the same "503/501 when dark → say so honestly" phrasing the house
style uses for dark features, or scope the template block to installs with
the pipeline enabled.

## LOW

**L1 — Self-echo: the turn's already-relayed reply may appear as AGENT rows
in the fetched context (relay writes to TopicMemory mid-turn).** Harmless
for the carve-out (agent rows can never be asks — D4), but say it in D1 so a
builder doesn't "fix" it and tests don't misread it as a defect.

**L2 — `textHead` at-rest honesty.** D8 newly persists 200 scrubbed chars of
every reviewed turn (including `direct` internal sessions) plus topicId to
disk. The spec's privacy section covers context bodies; add the standard
at-rest honesty sentence for the decision log itself (plaintext, machine-local,
filesystem-permission-bound — same posture as sibling JSONLs).

**L3 — Opt-in mechanism statement.** Fields land on the shared
`EscalationReviewContext` (extends `ReviewContext`) passed to ALL reviewers;
"injected ONLY into reviewers that opt in" means only opted-in
`buildPrompt` implementations RENDER the section. Say that one sentence —
otherwise a builder may invent per-reviewer context copies (and the
byte-unchanged test for the other seven should assert prompts, not ctx).

**L4 — Cite nits.** reviewCtx is typed `EscalationReviewContext` (extends
`ReviewContext`) — name the extension in §1.3/D3 for precision;
`TopicOperatorStore` path is `src/users/` (front-matter names no path).

## Lenses with no findings

- **Lessons-aware**: the spec genuinely complies with "Intelligent Prompts —
  An LLM Gate Must Not String-Match" (no deterministic ask-classifier;
  meaning-judged carve-out — D3's rationale paragraph is exactly the
  standard) and with Signal-vs-Authority (context is corroborating-only,
  one-way, envelope reused from the proven §Design 4 channel). The
  fail-closed tone-gate precedent is correctly not weakened (non-goal §3).
- **Security (beyond M1/m4)**: prompt-injection posture is sound — role
  labels are structural (`fromUser` column, never content), envelope +
  JSON-encoding + corroborating-only reused verbatim from the hardened
  sibling, a message claiming "the user asked" proves nothing without an
  enveloped USER-role row, and the PEL + credential-class exclusions bound
  the blast radius of a successful launder to content-class rules.

## External pass status

- **GPT-tier: RAN** — `pi` 0.78.1 → `openai-codex/gpt-5.5` (codex binary not
  installed; the pi door, as in prior ceremonies). Verdict: SERIOUS-ISSUES,
  6 findings: #1→M1 (confirm), #2→M4 (confirm+sharpen), #3→M2 (confirm),
  #4→M6 (adopted at MAJOR), #5→M3 (independent construction), #6→m1 (the
  external's own catch — the round's best net-new item from this door).
  Door honesty: #1-#4 built on verified facts supplied in the preamble; #5
  and #6 are independent contributions.
- **gemini-cli (gemini-2.5-pro, CLI 0.25.2): RAN** — verdict:
  SERIOUS-ISSUES, 3 findings: #1→M4 (filed CRITICAL, calibrated MAJOR — see
  below), #2→M1 (confirm), #3→M1 ground (c) (a genuine sharpening: the
  rationale for opting-in information-leakage is internally contradictory —
  the carve-out excludes exactly the content classes that reviewer flags, so
  no value-adding judgment remains for it to make with the context; folded
  into M1). Door honesty: #1 and #2 built on supplied verified facts; #3 is
  the external's own construction.
- **Calibration note on gemini#1 (CRITICAL→MAJOR):** the seam fact means
  response-review enforcement is reactive (revise-after-delivery) for the
  Telegram channel, not a pre-send gate — but no safety property INVERTS:
  current behavior is unchanged by this spec, the deterministic PEL and the
  always-on pre-send MessagingToneGate remain the actual delivery
  authorities, and the flaw is an omission/overstatement ("blocking power")
  fixable with a decided seam statement + honest harm model (M4's required
  fix). Under the ceremony's calibration discipline (severity measured
  against whether a stated property or safety guarantee breaks), that is
  MAJOR. It is, however, the round's most corroborated finding — raised
  independently by the internal fail-direction lens and BOTH externals (the
  only cross-model double-confirmation of the round).

## Round-1 tally

CRITICAL: **0** · MAJOR: **6** (M1-M6) · MINOR: **5** (m1-m5) · LOW: **4**
(L1-L4).

Verdict: **NOT CONVERGED** — revise and re-run. The revision must: cut
`information-leakage` from the v1 opt-in set (M1), specify the liveConfig
wiring + wiring-layer dev-gate resolution (M2), define the D9.4 counterfactual
measurement (M3), state the Stop-hook seam + two-sided harm model (M4),
promote all seven OQs to decided defaults or named non-goals (M5), and state
the total-containment rule against the fail-open route seam (M6).
