<!-- GENERATED FILE — DO NOT EDIT.
     Source: docs/specs/outbound-gate-advisory-override.md
     Regenerate: node scripts/generate-spec-contract.mjs --spec docs/specs/outbound-gate-advisory-override.md --strict
     STRICT IMPLEMENTATION CONTRACT: allowlisted contract sections only.

     Everything not on the allowlist is ABSENT BY DEFAULT — including all
     rationale. This file says WHAT to build, never why. Read the source
     spec for the reasoning, the alternatives, and the accepted residuals
     in their full form.
     (20 residual "round-N" reference(s) remain inline.)
-->
---
title: "Outbound gate advisory override — judgment rules become nudges, credentials stay a wall"
slug: "outbound-gate-advisory-override"
author: "Instar Agent (echo)"
parent-principle: "Signal vs. Authority"
status: "draft"
approved: false
review-convergence: ""
review-iterations: 0
single-run-completable: false
eli16-overview: "docs/specs/outbound-gate-advisory-override.eli16.md"
---
# Outbound gate advisory override
## 0.0 What an implementer builds (executive summary)

Two pull requests against one spec.

**PR-A — the wall and the data path.** (1) `B22_HELD_CREDENTIAL`: a
process-lifetime in-memory index of the credential values this install holds
(allowlisted classes only), matched by substring over three normalized forms;
a match refuses the message terminally, at the outbound seam and again at the
adapter send primitive. (2) `B23_CREDENTIAL_SHAPED`: every credential-*shaped*
pattern from `DURABLE_SECRET_PATTERNS`; it holds a message only where the author
can answer the hold, and observes everywhere else. (3) **Dissent**: any verdict
that concluded something can be disagreed with in writing while the message
stays held, recorded through the existing decision-quality chokepoint.
(4) **Judgeable capture**: the candidate body, the conversation slice the model
was actually shown, agent state and a truncation-honest copy of the model's
reasoning, behind its own consent flag, written to a machine-local store no
route reads. (5) The posture surface that reports all of the above whether or
not anything fired.

**PR-B — the widening.** Every LLM rule becomes advisory; a held message returns
an opaque single-use token; the author resends with the token, an
acknowledgement and a mandatory written reason; the seam skips only the LLM
review, re-runs the deterministic checks, delivers, and records the disagreement
once. One shared protocol helper that every relay script delegates to. Ships
dark, then dry-run, then live on the development agent.

**The contract both are tested against is §3.8.1.** If the code and that table
disagree, the table is right.

## 0.2 Current design overview (no history — read this first)

*Everything in this section is the design as it stands. Nothing here explains how
it got here; §§12+ do that, and §3's prose carries the reasoning inline for
readers who want it. Both external reviewers asked for exactly this section.*

**Four producers can stop an outbound message.**

1. **B22 — held credential.** The message contains a credential value this
 install actually holds, proven by exact comparison against an in-memory index
 built from an allowlisted set of credential classes. **Refuses terminally; no
 override, ever.** Runs at the outbound seam and again at the adapter send
 primitive, so a path that bypasses the seam is still covered. A dissent may be
 filed against it (recorded, message stays held).
2. **B23 — credential-shaped.** The message matches one of the shared credential
 *patterns*. **Advisory wherever the author can answer it**: the message is
 held and delivered on an override carrying a written reason. Where the author
 structurally cannot answer — a relay, a system template, a job, the lifeline
 path — the sender class's policy applies, and **every class defaults to
 observe** (recorded, nothing blocked). Where recourse is only *temporarily*
 absent (early rollout stages, recording dark) it is observe-only.
3. **LLM rules B1–B21.** Every judgment and representation rule becomes
 **advisory**: held, returned to the author, delivered on an override with a
 recorded reason. Pre-existing behaviour (a terminal block) is what they
 degrade to for callers that cannot acknowledge.
4. **Availability holds and the degraded floor.** An availability hold concluded
 nothing and stays terminal. The degraded deterministic floor *did* conclude
 something, so it **returns the message to the author** with the situation
 named — re-send later for a full review, or override now with a reason.

**Every stop that concluded something can be disagreed with**, in writing, while
the message stays held. That is the dissent path, it transfers no authority, and
it is what fills the evidence corpus from day one.

**What gets recorded.** Each decision produces a `judgeable-decision-record`:
the candidate (and its body), the conversation slice the model was actually
shown, agent state, the prompt version, the model, the gate's verdict and its own
reasoning, the author's action and written reason. Reason text and captured
conversation are machine-local, never served, never replicated, retention-swept,
and deletable. An override is only granted once a joinable stub of that record is
durably written.

**How it ships.** PR-A: the wall, B23, dissent, the capture, the posture surface.
PR-B: the advisory widening, the override protocol, the shared relay helper.
Stages: 0 dark, 1 dry-run, 2 live on the development agent, 3 fleet — the
operator's decision, gated on evidence and on a real grading rung existing.

**The contract is §3.8.1.** Where any prose disagrees with that table, the table
is right.

## 0. Glossary (for a reader outside this codebase)

| Term | Meaning here |
|---|---|
| **seam** | The one function every outbound message passes through (`evaluateOutbound`) — the single place a delivery decision can be made. |
| **chokepoint** | Same idea for writes: the one function through which a kind of record may be written (`annotateDecisionOutcome` for decision outcomes). |
| **ratchet** | A unit test that fails the build if an invariant regresses — e.g. "every rule id has a disposition". Enforcement by CI, not by memory. |
| **rung** | A tier in the closed evidence-strength ladder (`self-report` … `llm-interpreter` …). Higher rungs outrank lower ones when grading. |
| **disposition** | Whether a cited rule *blocks* the message or merely *advises* the author. |
| **advisory / nudge** | A rule citation the author may override; the message is held until the author decides. |
| **dissent** | A recorded disagreement filed against a citation while the message **stays held** — data without authority transfer. |
| **ACT-1198** | The tracked work item carrying the preconditions for a bulk LLM judge (`GET /evolution/actions`). |
| **B1…B22** | Rule ids in the outbound gate's rule set. |

### 3.8.1 Normative outcome table

The accumulated mechanisms — advisory rules, dissent, B22/B23, availability
holds, the degraded floor, adapter-only B22, capability, token validity,
recording state — compose into a state machine large enough that implementation
drift is the realistic failure. This table is **normative**: each row is a test
case, and a behaviour not derivable from it is a defect in one or the other.

**In conventional terms first.** Every outcome below is one of five states:

| Plain term | What it means here | Spec vocabulary |
|---|---|---|
| **Hard deny** | Refused; no path forward for this text | B22 only |
| **Soft hold** | Not sent; the author may send it by recording a reason | B23 where recourse exists, advisory rules, degraded-floor citations |
| **Blocked** | Not sent; no override path *for this caller* | blocking rule, or an advisory rule from a caller that cannot acknowledge |
| **Degraded / unavailable** | The check could not run; nothing was concluded | availability hold, `detectorIncomplete` |
| **Observed** | Recorded, nothing changed | dry-run, observe-only, would-hold — including B23 and degraded-floor citations where recourse does not exist |

An **approval token** is the receipt the server hands back with a hold, which
the author returns to prove which decision they are answering. An **audit event**
is a local log line, never a message to anyone.

**The precedence rule is now MECHANICALLY CHECKED, not merely declared.** A spec lint ships with PR-A and runs in
CI. It is **critical infrastructure and specified as such**,
not a promise: it parses §3.8.1 into `{rowId, producer, capability, token,
recording, outcome}`, extracts every Frontloaded Decision and test-plan assertion
naming a row id or an outcome token (`observe`, `hold`, `refuse`, `deliver`,
`advisory`, `fail-closed`), resolves each against its row, and **fails the build
on a mismatch**. Its own tests use three fixtures that must fail it: a decision
naming an outcome its row does not have; a PR ownership list that is not a
partition; and a table row with the wrong cell count. All three are real defects
this review found by hand. Prose that contradicts
the table stops being a thing a reviewer has to notice. Until that lint exists,
the same comparison is done by hand at every fold and recorded in the round log
— which is how rounds 15, 17 and 18's drift was found, and an honest admission
that hand-checking is what a lint is for.

**§3.8.1 IS THE SINGLE SOURCE OF OUTCOME TRUTH.** Every other
section — §3.1, §3.5, §3.8, §3.11, the frontloaded decisions — is *explanatory*.
Where prose and this table disagree, **the table wins and the prose is a defect
to fix**, and three rounds of this review found exactly that class of drift. The
tests derive from the table, so a behaviour not derivable here does not exist.

**Stage matrix** (the rollout dimension, pulled out of the prose so it cannot
drift again):

| | B22 (possession) | B23 (pattern) | LLM advisory rules | Dissent |
|---|---|---|---|---|
| **Stage 0** (PR-A) | enforcing, terminal | **observe-only** — would-hold recorded, nothing blocked | unchanged — blocking | **live on every verdict** |
| **Stage 1** (PR-B, dark — `dryRun: true`, so recording is not live) | enforcing | **observe-only** — recording is dry-run, so a hold could not be answered honestly (the B23 rule) | `would-advise` logged, still blocking | live |
| **Stage 2** (dev agent) | enforcing | **overridable with a recorded reason** | **overridable with a recorded reason** | live |
| **Stage 3** (fleet — operator's call, gated on §8.1) | enforcing | overridable | overridable | live |

**Evaluation is PHASED; within a phase the first matching row wins.**

- **Phase A — deterministic wall.** B22 and detector-incomplete, on every
 request including every resend. Nothing downstream can waive these.
- **Phase B — override resolution.** If a valid token is presented: the
 acknowledged citation (and only that citation, on unedited text) is treated as
 answered and is NOT re-issued. A deterministic finding *different* from the
 acknowledged one — a B23 kind that did not fire before, e.g. because the index
 finished rebuilding between the two passes — is a **fresh hold** with its own
 token, never suppressed by the earlier ack.
- **Phase C — review.** Reached only when Phase B did not resolve the request:
 the LLM review and its dispositions.

| # | Producer / condition | `advisoryCapable` | Token | `recordingLive` | Outcome |
|---|---|---|---|---|---|
| 1a | **B22** (proven possession — the value arm is the whole wall), **seam** | any | any | any | **Refuse, terminal.** Never overridable. Returns a **dissent-only** token (§3.3). |
| 1d | **B22, ADAPTER layer** | n/a | n/a | n/a | **Refuse at egress**, local audit event only — **no token, no agent-facing protocol**. The adapter's callers are system templates, relays and the lifeline fallback; there is nobody to hand a token to (§3.2). Counted `b22-adapter-caught-post-seam`. |
| 2 | **B22 matcher threw** on a built index | any | any | any | **Hold**, `detectorIncomplete`. |
| 2a | **No index exists** (never built at startup) or a **refresh failed** while a previous index is served | any | any | any | **Degraded, NEVER a hold** — the wall's reach narrows (to nothing, or to the previous index), `valueArmScope` + `b22-index-degraded` surfaced unconditionally (§3.2.2). Holding every message because a vault cannot be read is worse than the exposure it would prevent, and that trade is stated rather than implied. |
| 3 | Deterministic **B23**, seam, **Stage 0** | any | — | any | **Observe-only** — `b23-would-hold` recorded with the kind; nothing blocked (§3.8). |
| 3a | Deterministic **B23**, seam, **Stage ≥1** | true | — | true | 422 advisory + token; override with reason ⇒ deliver + annotate. |
| 4 | Deterministic **B23**, seam | true | — | **false** | **Observe-only** — recording is not live, so an override could not be recorded and a hold could not be answered honestly; records `b23-would-hold` locally, blocks nothing (the B23 rule). |
| 5 | Deterministic **B23**, seam, caller **cannot acknowledge** | **false** | — | any | **Per the sender class's policy** (§3.8): `observe` by default — `b23-would-hold` recorded, nothing blocked. |
| 6 | Deterministic **B23**, adapter layer | n/a | n/a | n/a | **Not evaluated** — the adapter runs possession-only, and terminally (row 1d). |
| 7 | Availability hold (`CAPACITY_UNAVAILABLE` / `GATE_UNAVAILABLE`) | any | any | any | Terminal, labelled `availability`, never ackable, no token. |
| 8 | Degraded deterministic floor citation | true | — | true | **422 advisory + token**, exactly like any advisory citation — plus `source: 'degraded-floor'` and the situation named: re-send later for a full review, or override now with a recorded reason. It is a soft hold with a normal token, not a special shape. |
| 8c | Resend against a degraded-floor citation, ack + reason + valid token | true | valid | true | Deliver + annotate once, `dispositionAtDecision: 'degraded-floor'` recorded so the corpus can tell an outage-window override from an ordinary one. |
| 8a | Degraded floor, `recordingLive` **false** | true | — | false | **422, no token** — an override cannot be recorded, so none is offered. The response says the full reviewer is unavailable and re-sending later is the path. |
| 8b | Degraded floor, caller **cannot acknowledge** | **false** | — | any | **Always observe-only** — recorded, nothing blocked. The sender-class `fail-closed` opt-in does **not** apply to this producer. |
| 9 | LLM **blocking** rule | any | — | any | 422 blocked + token; a resend may file a **dissent** ⇒ message stays held, annotation written. |
| 10 | LLM **advisory** rule | true | — | true | 422 advisory + token. |
| 11 | LLM **advisory** rule | true | — | **false** | Blocking (coupling), counted. |
| 12 | LLM **advisory** rule | **false** | — | any | Terminal `tone-gate-blocked`, counted `advisory-degraded-to-block`. |
| 13 | Resend, ack + reason + **valid** token, hash matches | true | valid | true | **Phase A** runs (rows 1–2 still apply); the acked citation is treated as answered; **Phase C is skipped**; deliver; annotate once. |
| 13a | Resend as above, but a **different** deterministic rule now fires | true | valid | true | Fresh hold on the new citation with a new token — an ack for one rule never answers another. |
| 14 | Resend, token valid, **hash mismatch** (edited message) | true | valid | true | Full fresh review (the edit is a new message). |
| 15 | Resend, token **absent/expired/consumed** | true | invalid | true | Fresh review; response carries `tokenExpiredFreshReview: true`; counted separately; never a join on text. |
| 16 | Resend, ack present, **reason missing/short after scrub** | true | valid | true | 422 with `reasonRequired: true`, `refusedField: 'reason'`; nothing delivered, nothing annotated. |
| 17 | Resend, **reason itself trips B22** | true | valid | true | 422 `reasonRejected: true`, `refusedField: 'reason'`; nothing delivered, nothing annotated. |
| 18 | Valid override, the **`authorized` event cannot be appended** | true | valid | true | **Refuse the override** (`overrideUnrecordable: true`) — nothing delivered. Authority is granted only against durable evidence (§3.8). |
| 18b | *(Merged into row 18 in round 32.)* The reason text rides the `authorized` event, so "the reason cannot be written" and "the event cannot be appended" are **one failure**, not two. Retained as a row id so change-log references resolve. |
| 18a | Valid override, `authorized` appended, **rich annotate call fails afterwards** | true | valid | true | **Deliver** + count `override-unrecorded`. The fact is durable; only the derived detail was lost, and observability is never a delivery gate. |
| 18c | Valid override, `authorized` appended, **adapter B22 refuses at egress** | true | valid | true | Nothing delivered; `egress-refused` appended. The corpus records an override that was granted and correctly stopped — never a delivery. |
| 18d | Valid override, `authorized` appended, **send throws or times out** | true | valid | true | `send-failed` appended. Same distinction: authorized ≠ delivered. |
| 19 | Plain resend, no ack, text hash matches a live record | true | — | any | Fresh review; counted `advisory-evaded-by-resend` (exact-text lower bound). |
| 20 | Resend carrying `agentDissentReason` + a **dissent-only** token (B22 / terminal) | any | valid | true | Message **stays held**; dissent annotated (`self-report`). Authority unchanged — the zero-risk evidence path (§3.3). |
| 20a | Resend presenting a **dissent-only** token with an override ack | any | valid | any | Refused `dissentOnlyToken: true`; nothing delivered, nothing overridden. |
| 21 | Resend carrying `agentDissentReason` against an **availability hold** or `detectorIncomplete` | any | any | any | Refused with `notAJudgment: true`; nothing annotated — there is no verdict to dissent from. |
| 23 | Send where `isProxy` / `isSystemTemplate` / `willRelay` (review short-circuited) — **B22** | n/a | n/a | any | **Evaluates and refuses.** Hoisted above the early return; possession needs no protocol to be answerable (dissent is available wherever the caller can carry it, and the refusal is audited regardless). |
| 23a | Same paths — **B23** | n/a | n/a | any | **Per the sender class's policy** (§3.8). These callers have no advisory protocol, so a hold can never be *answered* — but round 22 established that the operator, not the rule, decides whether an unanswerable hold is preferable to delivery for a given sender: **every class defaults to `observe`**; `fail-closed` exists only where an operator has explicitly opted that class in. Records `b23-would-hold` either way. |
| 22 | Resend with ack + reason but an **expired/absent** token | true | invalid | true | Fresh review (row 15) **and** `expired-token-override-attempt` recorded machine-local, explicitly marked unjoined + unjudgeable, so the corpus does not silently over-represent overrides whose token happened to survive. |

### 3.9 Fail directions

| Condition | Behavior |
|---|---|
| B22 index **build/refresh** fails or times out (rows 2/2a) | **Degraded** — the wall's reach narrows to nothing while degraded; B23 still runs and behaves **exactly as §3.8.1 says for the current stage and caller** (observe-only at Stage 0, at Stage 1 while recording is dry-run, and on protocol-skipped paths; a hold with recourse from **Stage 2**, when recording is live and the caller is advisory-capable) — never an unanswerable hold, whatever this row once implied, `valueArmScope: 'unavailable'` on the payload + on the §3.2.2 posture surface, `b22-index-degraded` counted. **Never a hold.** (An agent with a decrypt-failed vault must not have every outbound message held forever — and after round 11's narrowing this is the one condition under which the wall is *absent*, which is exactly why the posture surface reports it unconditionally.) |
| B22 **match evaluation** throws on a built index (row 2) | **Fail closed** — hold, `detectorIncomplete` (§3.9.1 for the remediation contract). One term throughout — `detectorError` was a second name for the same state. Round 16 deleted the verification cap with the fingerprint scheme, so exact substring matching has no hit-amplification path left to bound. |
| Secret backend is `bitwarden`/`manual` | **Config-held credentials are still indexed and still walled** — they do not come from the vault. Only vault-derived values are unavailable, and the scope reports `vault-unavailable` on the posture route rather than only on a refusal. |
| The **`authorized` event** cannot be appended (row 18) | **Override refused** — `overrideUnrecordable`. Authority is granted only against durable evidence. |
| **Rich provenance annotation** fails after `authorized` (row 18a) | Message still delivers; counted `override-unrecorded`. The fact is durable; only the derived detail was lost — recording detail is observability, never a delivery gate. |
| Process crashes between `authorized` and any terminal event | The record is **incomplete, not delivered**. Startup reconciliation marks it `send-outcome-unknown`; the judgeable corpus counts only records with a terminal event, so a crash can never inflate the delivered-override count. |
| Annotate seam **dark/dry-run** | Advisory widening resolves **false**. Pre-existing **LLM** rules revert to blocking (their prior behaviour); **B23 and degraded-floor citations go observe-only** (rows 4, 5, 8a, 8b) — they are new, with no prior block to revert to. Recording and authority are coupled. |
| Token absent/expired/mismatched | `override-uncorrelated`, counted; no join. |
| Gate provider unavailable | Availability hold (§3.1) — terminal, non-ackable, labelled as availability. |

#### 3.9.1 `detectorIncomplete` remediation contract

**.**

- **The agent-facing message says what to do**: the credential check could not
 complete on this message; edit it (removing large repeated key-like fragments
 is the usual cause) and re-send. It is not a verdict about the content, and it
 says so.
- **It is not dissentable** — nothing concluded anything (§3.3) — but it **is
 counted** (`b22-detector-incomplete`, with the cause: cap vs throw), and a
 sustained rate crosses a band into ONE deduped Attention item. A matcher bug
 therefore surfaces as an operator alert rather than as an unexplained silence.
- **`emergencyDisable` covers it.** The lever disables the whole detector, so it
 disables `detectorIncomplete` with it — stated explicitly, because a
 kill-switch that leaves the fail-closed arm running would not be a
 kill-switch.
- **The blast radius is one message**, not the channel: the hold is per-candidate
 and stateless, so an edited resend is evaluated fresh.

### 3.10 Test plan

**Unit** — disposition/class parity ratchets incl. B22/B23 *exclusion* from
`VALID_RULES` and `RULE_CLASSES`; **B23's kind set covers `DurableSecretKind`**
minus the reasoned exclusions (a new kind fails the build rather than shipping
unhandled); an LLM citation of B22 *or* B23 is invalid-rule; **B22 fires only on
proven possession** — per normalization form, and for this install's own
`authToken`; **every pattern match is B23 and never B22**, with the prose cases
as named fixtures (`your api_key: not-configured-yet`, `Bearer your-token-here-example`,
a dotted identifier matching the `jwt` shape) — each asserted overridable;
negatives for git SHAs, fingerprints, correlation ids, base64 image data and
plain prose; refusal payload never contains the value, the arm, or the tier;
reason validation (missing/blank/short-after-scrub/clamped); **a repeated reason
is admitted and counted, not refused**; index bounds, clamp counters,
constant-time verify, and read-only key path (no key generation); both
producer-keyed override-admission maps.

**Integration** — full HTTP pipeline: advisory 422 → resend without reason → 422
`reasonRequired` → resend with reason+token → 200 + exactly one annotation, and
**no second LLM review**; token replay refused; pre-ack without a token refused;
B22 refusal not overridable by any metadata combination; **B22 fires on the
`isProxy`, `isSystemTemplate` and `willRelay` paths**; **a B22 match on a
short-circuited resend still refuses** (the ack for one rule cannot launder
another rule's wall); **`toneGate.advisoryOverride` actually resolves through the
extended `resolveToneGateOperatorConfig` whitelist** (a dedicated test — the
whitelist omission is the documented cause of the 2026-07-24 wiring gap, and
gemini flagged it again in round 2); **an ack against a `degraded-floor`
citation is HONOURED and recorded**; **`GET
/decision-quality` reports `credentialWall` posture on an install whose value arm
is unavailable** (the check-that-cannot-run test); `GET /judgment-provenance`
(both scopes) returns no reason text; **the reason store is excluded from the
backup path**; annotate failure does not block delivery; annotate-dark reverts to
blocking; dry-run changes no outcome; dissent-on-block records an annotation
while the message stays held.

**The B23 rule — one test per row, because this is the behaviour that drifted
six times.** Assert B23 **observes and blocks nothing** at Stage 0; at Stage 1
(`dryRun`); when `recordingLive` is false; when the caller is not
advisory-capable; and on the `isProxy` / `isSystemTemplate` / `willRelay` paths.
Assert it **holds with a token** only at Stage 2 with recording live and a capable
caller. Assert the adapter layer never produces a B23 outcome at all.

**Spec-lint (§3.8.1, ships with PR-A)** — a CI check that every frontloaded
decision and every test-plan assertion naming a B22/B23/degraded-floor/token
outcome resolves against the table row it claims to describe, failing the build
on a mismatch. Its own test: a deliberately contradictory fixture decision must
fail it.

**Completeness contract (§3.11)** — a unit test asserts every field the
`judgeable` predicate requires is present on a row produced by the real
`buildToneDecisionContext` with capture on, and that `judgeable:false` names the
missing fields with capture off; a ratchet fails the build when the prompt
template's hash changes without `TONE_GATE_PROMPT_ID` changing; a test asserts
`rawResponseTruncated` is set when the model's response exceeds the head bound.

**E2E** — production initialization path: routes answer, flags resolve, an override
recorded in a real server lifecycle appears in `GET /decision-quality` as a
`self-report` row with non-zero `overrides`.

**Live-user-channel proof** — a real Telegram message, blocked, overridden through
`telegram-reply.sh --tone-override`, delivered, and read back out of the live read
surface. Slack parity is required before the Stage-3 fleet flip, not before merge
(the change is channel-shaped; the Standards-Conformance Gate flagged this and
this is the honest scoping answer).

## 4. Honest limits

- **Split, encoded, and described credentials are out of reach.** Exact
 (normalized) substring matching plus a pattern list catches a verbatim
 credential in one message. It does **not** catch a secret split across two
 messages, base64/hex-encoded, or described in pieces. Splitting/encoding are
 in-scope-but-unhandled residuals; describing is an accepted limit (no
 deterministic test exists). §3.2's normalization closes only the whitespace and
 separator forms.
- **`dashboardPin`** is below the ≥12 floor and out of B22's scope.
- **Homoglyph / confusable substitution is NOT covered.** NFKC folds
 compatibility forms; it does not map Cyrillic `а` to Latin `a`. A credential
 rewritten with confusables defeats the value arm. Listed here rather than
 implied away — it sits in the same class as splitting and encoding: an
 in-scope-but-unhandled residual, not a solved problem.
- **A credential this install does NOT hold is a nudge, never a wall.** After
 round 11 this covers *every* shape — a third party's API key, a DB password in
 a `password: …` sentence, a PEM block. Each holds the message and demands a
 consciously recorded override; none refuses irreversibly. This is a deliberate
 reach reduction bought for the removal of unappealable authority over ordinary
 sentences, and it costs only the ability to stop an agent that has written down
 a justification — never the ability to stop an accident. Anything this install
 actually holds is unaffected: that is the wall.
- **The value arm is machine-scoped.** On the relay path the composing machine's
 credentials are what matter; see §6.
- The change grades nothing. It produces evidence; the judging is later, in bulk,
 and today's `llm-interpreter` rung is dormant (G8).

## Decision points touched (§5)

| Decision point | What it decides | Classification | Justification |
|---|---|---|---|
| `messaging-tone-gate` | Whether an outbound message is delivered | **judgment-candidate** | The canonical competing-signals point. **Floor:** the deterministic B22 arm runs pre-LLM and is unconditional. **Arbiter:** the LLM gate judges; its verdict is advisory, so the author is the final arbiter and every disagreement is recorded. **Ladder:** LLM verdict → provider failure-swap chain → degraded deterministic floor (**advisory**, round 17) → availability hold (blocking, and not a judgment). Bounded action space `{deliver, advise, refuse, observe}`; conservative default on any unresolvable flag is `blocking` for pre-existing LLM rules and `observe` for the new deterministic ones, which had nothing to fall back to. |
| **B23 pattern arm** (every kind) | Whether the candidate matches a credential-shaped heuristic | **judgment-candidate** | Honestly a low-context signal about meaning ("is this string a secret or a placeholder?"). **Floor:** wherever B23 holds, nothing is delivered on a match without an explicit recorded act; where the author would have no way to answer it, it holds nothing and records instead (the B23 rule, §3.8) — the floor is never an unanswerable block. **Arbiter:** the author, via a recorded override with a mandatory reason. **Ladder:** heuristic match → author override (recorded) → where the override path is unreachable, the citation is **observe-only** (the B23 rule, §3.8) — never a block, because B23 is a new hold with nothing to fall back to. Bounded action space `{observe, hold, hold-then-deliver-on-recorded-override}`. |
| **B22 value arm** | Whether the candidate contains a credential this install holds | **invariant application, environment-conditional signal** | The *logic* is invariant — a total, deterministic predicate over whatever the index holds, applied identically everywhere. Its *reach* is not environment-independent (backend, keychain availability, store readability), so it is specified as a best-effort **additive positive** signal that can only ever *add* refusals, never remove one. Round-2 (gemini) correction: v2 called this simply "invariant", which overstated it — the honest split is invariant application, conditional signal presence, with the presence reported unconditionally per §3.2.2, never inferred from silence. |
| Override/dissent admission | Whether a resend is honored | **invariant** | A deterministic predicate over the request: valid consumed token + ack matches the token's rule + candidate hash matches + reason present after scrub. The ≥12 floor is deliberately a **presence** check making no quality judgment (§3.4) — reason quality belongs to the bulk judge, not to admission. |
| Stage/dryRun resolution | Whether a citation advises or blocks | **invariant** | Conservative default stated: an unresolvable flag resolves to `blocking` (pre-change behavior), never advisory — this is the one place a defect could ship a message the gate meant to hold. |
| **`authorized` event append** (pre-send) | Whether the override is granted at all | **invariant** | A durable write that **does** gate delivery: no event, no override (rows 18/18b). This is the authority-for-evidence bargain in code. |
| **Derived provenance annotation** (post-send) | Whether the disagreement is surfaced on the read surfaces | **invariant** | Unconditional side effect; **never** gates delivery (row 18a). |

## 6. Multi-machine posture

| Surface | Posture | Notes |
|---|---|---|
| `RULE_DISPOSITIONS`, `DETERMINISTIC_RULE_DISPOSITIONS`, B22/B23 logic, the pattern set | **unified** | Code — identical everywhere by construction. |
| Pending advisory token records | **machine-local** | `machine-local-justification: physical-credential-locality` — the record is in-memory server state describing an in-flight decision made by *that* machine's provider, and the token is a key into it. Lifetime is minutes and never outlives the request pair. A token presented elsewhere finds no record and falls to `override-uncorrelated` (counted, honest). |
| The live-credential index | **machine-local** | `machine-local-justification: physical-credential-locality` — derived from that machine's own secret store and config. A unified index would ship a fingerprint index of every machine's credentials to every other machine: strictly more exposure, no benefit. **Relay path (must be built), restated after round 11's narrowing:** `evaluateOutbound` is skipped when `willRelay`, so the composing machine's seam is where A's credentials are checked — the wall runs on the **composing** machine before relay, and B23 *evaluates* there too — observe-only, since a relayed send has no advisory protocol (row 23a). Machine B's adapter-layer wall then checks **B's own** credentials at B's egress. That is additive, not redundant: each machine's wall protects the credentials it actually holds, at the point they would actually leave. `valueArmScope` records which applied. |
| Override reason **free text** | **unified surface, one deliberately non-replicated field** | *Not* a machine-local surface and therefore **no `machine-local-justification` key** — round-2 correction: v2 claimed `operator-ratified-exception` and cited a commit SHA that ratifies nothing of the sort, which is exactly the "marker present but substantively wrong" case Standard A rejects. The correct description: the surface is the unified record above; the free-text payload is excluded from serving and replication as a **containment property**, on the exact precedent of `contextFull` in judgment-provenance (written locally, stripped by `readRedacted()`, never replicated). The bulk judge reads the text on the machine that wrote it (§3.6). |
| Recorded override/dissent outcomes | **unified (proxied-on-read)** | Rides the existing decision-quality pool merge, machine-tagged (per-machine framework routing makes per-machine rates genuinely distinct data). Requires the `DECISION_QUALITY_POINT_FIELDS` allowlist extension (§3.7). |

## 7. Frontloaded Decisions

1. **B8/B9 are advisory.** Contextual judgments; false-positive cost is a
 duplicate or terse message — recoverable.
2. **The known-live-value floor is a flat ≥12 characters on the normalized form**,
 not per-secret entropy. A per-secret entropy floor is an unevidenced tunable
 whose failure mode (a low-entropy but live password falling under the bar) the
 flat floor does not have. It is an **availability** guard, not a security
 property.
3. **Override counts do NOT feed the benchmark-divergence detector in this
 change** — it compares grade rates to benchmark pass rates, and overrides are
 `unknown`-graded self-reports. Wire it after real grades exist.
4. **Reason floor 12 chars (post-scrub), clamp 500** (matching `EVIDENCE_NOTE_CLAMP`).
5. **B22 refuses rather than redacts** — redaction alters the author's words and
 leaks prefixes.
6. **B22 ships enabled, not dark**, with a PIN-gated `emergencyDisable`. The
 advisory widening is what ships dark.
7. **The reason text never enters a served or replicated surface** (§3.6). Served
 evidence is `reasonHmac` + `reasonLength` only.
8. **The flag is top-level `toneGate.advisoryOverride`**, with the
 `resolveToneGateOperatorConfig` whitelist extended in the same change.
9. **B22 and B23 are both excluded from `VALID_RULES` and `RULE_CLASSES`**; the
 ratchets assert the exclusion, and an LLM citing either id is an invalid rule.
10. **The resend does not re-run the LLM** when a valid token matches; an edited
 message gets a fresh review.
11. **The reason requirement is gated on `enabled`** — Stage 0 preserves B21's
 ack-only contract; the B21 integration test is amended at Stage 1 in the same
 change.
12. **Dissent-on-block ships first and unconditionally**, so the dataset does not
 wait on the widening's rollout.
13. **The four non-ack-capable routes are declared `advisoryCapable: false`**
 initially, rather than emitting an instruction they cannot honour. Outcome
 differs by producer, per the table: a pre-existing **LLM** advisory rule
 degrades to its prior terminal block (row 12); **B23 goes observe-only**
 (row 5), because it is new and has no prior block to fall back to.
 
14. *(Reversed in round 17.)* The degraded deterministic floor was blocking; it
 is now **advisory** under the same recourse rule — it concludes something
 about the message, so it is answerable. B22 keeps the irreversible case.
15. **The Stage-3 fleet flip is the operator's**, on the named conditions in §3.8.
 The builder never performs it.
16. **The existing `advisoryOverridden` audit re-log stays**, and MUST NOT carry the
 reason text (different retention and scrub contract than the annotate path).
17. **B22 is PROVEN POSSESSION ONLY; every pattern match is B23** (§3.2).
 Superseded the earlier two-tier form in round 11 — no regex is possession,
 so no regex holds irreversible authority.
18. **The advisory token is an opaque 256-bit CSPRNG id keyed to a server-side
 pending record**, not an HMAC over concatenated fields (§3.5).
19. *(Retired in round 16.)* The fingerprint prefilter and everything built to
 make it sound — dual anchors, buckets, the fail-closed verification cap,
 retrieval handles, the matcher benchmark — were **deleted** when the premise
 they served ("no plaintext credentials in this process") turned out to be
 false already. See §3.2.1. FD31, FD34 and FD46 are retired with it.
20. **A repeated reason is COUNTED, never refused** — a similarity heuristic
 holding admission authority is the pattern this spec removes (§3.8).
21. **While grading is dormant (G8), the per-rule fail-safe circuit ALERTS
 instead of reverting**; it reverts only once a non-`self-report` grading rung
 exists, and every state is operator-clearable (§3.8).
22. **The resend short-circuit skips the LLM review only** — the localhost
 guard, the length check, and B22/B23 re-run on every resend (§3.5).
23. **Degraded-floor citations are labelled `source: 'degraded-floor'`** so the
 author knows a fallback produced it — and, since round 17, they are
 **`overridable: true`** under the same recourse rule (§3.1). The label is
 information for writing a reason, not a refusal.
24. **The credential wall reports its posture unconditionally** (§3.2.2) — a
 permanently unavailable value arm can never present as a healthy wall.
25. **The judgeable-record completeness contract ships in the SAME change as the
 widening** (§3.11), behind its **own** `toneGate.recordDecisionContext` flag
 (default off, nested under `recordCandidateBody` — see FD33, which supersedes
 this decision's original single-flag form). Operator direction 2026-07-24:
 rich per-decision context is the point of the whole effort, and a gap in it
 cannot be backfilled.
26. **`recordingLive` is a configuration predicate; a per-call annotate failure
 delivers and is counted `override-unrecorded`** — observability never
 becomes a delivery gate (§3.8, resolving the §3.9 contradiction).
27. **Normalization is symmetric and canonical** (NFKC → control-strip → three
 forms) applied to indexed values and candidates alike (§3.2).
28. **Pending token records are NOT persisted across restart** — a stale token
 falls through to a fresh review and a new token; one extra round trip, no
 lost message (§3.5).
29. **The `reasonHmac` key is not rotated on a schedule** — rotation only splits
 a live corpus and buys nothing, since the hash authenticates nothing (§3.6).
30. **The rejected index alternatives are recorded** (Aho–Corasick / exact trie /
 per-message store read) with the long-lived-plaintext reason (§3.2.1).
31. *(Retired in round 16 — no cap exists; see FD19.)*
32. **The adapter-level detector is B22 (possession) only** — B23 exists only
 where the override protocol does (§3.2).
33. **Decision-context capture gets its own flag** (`recordDecisionContext`,
 default off, nested under body capture) rather than widening an existing
 consent on update (§3.11). Supersedes FD25's original single-flag form.
34. *(Retired in round 16 — no anchors exist; see FD19.)*
35. **§3.8.1's outcome table is NORMATIVE** — the tests derive from it, so a
 behaviour not derivable from the table is a defect in the code or in the
 table, never an undocumented third option.
36. **Live widening requires context capture to be ON** (§3.11) — the same
 authority-requires-recording coupling as `recordingLive`, so Stage 2 cannot
 mint overrides that no judge can grade.
37. **Terminal judgments return a DISSENT-ONLY token** — every judgment gets a
 join key; no wall gets an exit (§3.3). Availability holds and
 `detectorIncomplete` return no token at all, because they are not judgments.
38. **The build lands as TWO sequenced PRs against this one spec** (PR-A wall +
 dissent + capture, PR-B the widening), tested against the shared normative
 table; the spec itself is not split (§3.8).
39. **All matcher arithmetic is over UTF-8 bytes of the NFKC-normalized string**
 — never code points, never UTF-16 units (§3.2.1).
40. **Stage 3 is out of scope for this build** — it waits on ACT-1198, which is
 recorded as a live dependency rather than as an open question (§8.1).
41. **Consuming a token requires the full binding tuple** — rule, detector kind,
 candidate hash, **channel, topic and message kind** (§3.5).
42. **B22 enforces from day one** — proven possession verified by exact
 comparison needs no soak. 
43. **Dissent is scoped by "false-positive-reportable verdict"**, not by
 "judgment" — the conclusion makes it reportable, not the reasoning style (§3.3).
44. **The 422 protocol lives in ONE shared helper** that every relay script
 delegates to; no channel parses it independently (§3.8).
45. **Captured conversation context is MINIMIZED** (≤8 messages, ≤500 chars each,
 drops recorded); the bounds are set by a judgeability test whose authority is
 a **human-reviewed fixed corpus**, never a model's agreement (§3.11).
46. *(Retired in round 16 — no anchor keys exist; see FD19.)*
47. **The pending record is consumed only after ALL resend validation passes** —
 a rejected reason costs no round trip (§3.5).
48. **No template allowlist for B23** — an automated sender adopts the shared
 helper or does not emit credential-shaped examples; the **`b23-would-hold`**
 counter makes either visible (§3.8). *(`advisory-degraded-to-block` is the
 LLM-rule counter; B23 never degrades to a block.)*

*(FD31–33 were cited by the round-4 change log before they were written into
this list — a dangling reference caught in round 6. Recorded rather than quietly
fixed: it is the same stale-internal-drift class codex flagged as FD25 and FD19,
in a spec that warns about exactly that, which is the argument for the
cross-checking rather than for trusting a careful author.)*

## Open questions (§8)

*(none)*

> No decision is parked on the operator. The live external dependency is recorded
> in §8.1 rather than disguised as a question.

## 8.1 Dependencies (live, external to this spec)

| Dependency | Owner | What blocks on it |
|---|---|---|
| **ACT-1198** — the bulk-judge preconditions (instruction-inert quoting, the reason/context ingestion contract, a non-`self-report` evidence rung on `messaging-tone-gate`) | tracked evolution action, not this spec | **Stage 3 (the fleet flip) only.** It is already gated on this in §3.8 condition (b). Stage 3 is therefore **explicitly out of scope for this build** — this spec ships Stages 0–2 and the operator's Stage-3 decision waits on ACT-1198 landing. Nothing in PR-A or PR-B depends on it: the corpus accumulates and is readable regardless of when the judge is built. |

## 9. What this does not do

- It does not judge anything; it produces the evidence a later bulk judge grades.
- It does not touch the localhost-link guard or the length check.
- It does not weaken the credential floor — it builds the first explicit one, and
 §4 states exactly where that floor's reach ends.
