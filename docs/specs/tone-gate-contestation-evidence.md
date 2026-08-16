---
title: Tone-Gate Contestation Evidence — recording which outbound holds the sender overrode
status: superseded-in-direction
author: echo
created: 2026-07-23
supersedes: none
extends: docs/specs/llm-decision-quality-meter.md (§5.4 evidence rules, §5.5 grading pass)
tracked-as: CMT-1996
---

# Tone-Gate Contestation Evidence

> **⚠ SUPERSEDED IN DIRECTION — 2026-07-23, operator (topic 33368). Do not build
> from this as written.**
>
> This spec computes a right/wrong verdict **at decision time**. The operator's
> model is to **record richly and judge LATER, in bulk, with a very intelligent
> model** — no real-time verdict at all: record the input, the prompt, and the
> decision; record whether the agent agreed or disagreed and, when it disagreed,
> WHY, with full context; judge retrospectively, unhurried.
>
> That dissolves this spec's central unresolved problem (FD-J) rather than managing
> it: an override is a *disagreement*, not a verdict, and nothing needs to be stored
> as `wrong` in real time. It also revives the `right` signal withdrawn in FD-I as
> unsound — authorship never had to be *proven*, because the recorded context goes
> to a judge that decides.
>
> **What survives:** the signed decision-token join (§6.1) — stateless, exact,
> cross-machine safe — is the right mechanism for tying a disagreement record back
> to the decision it answers. The correlation-id capture, the content discipline
> analysis, and the honesty properties (silence is never evidence; a self-report is
> never proof) all carry over.
>
> **What falls away:** the grade-emitting half — the rule registration, the
> real-time annotate, and every option in the a/b/c enum question.
>
> **Open operator decision before a rewrite:** retrospective bulk judging needs the
> message body, which the current content-bearing discipline deliberately never
> stores. That tension is the operator's to resolve knowingly.
>
> Tracked as **ACT-942**. Retained unmodified below as the record of what was built
> and reviewed, and of why the reframing was better.

**Parent constitutional standard:** *Observable Intelligence — no autonomous AI
action the system takes is allowed to be invisible.* A gate whose every verdict
settles `unknown` is instrumented but not observable: we can see that it fired and
what it cost, and nothing about how it landed. This spec makes one real outcome of
the system's highest-volume LLM decision point visible.

**Secondary lineage:** *Decision Provenance & Outcome Review*, whose rule text names
"graded real cases feeding its bench battery" — this produces the first such cases
for this point.

**Fit rationale:** measurement only. No authority, no gate, no user-visible surface
change beyond one additive optional field. It makes an existing autonomous
decision's outcome observable, which is exactly what the parent standard requires.

**Naming note** (round-7, codex gpt-5.5 f3): an earlier title promised "real
right/wrong". What this actually produces is a record of **contested** holds — the
title now says so. Reserving right/wrong language for independent outcome evidence
is the point, not a quibble.

## Final design summary (read this first)

| | |
|---|---|
| **What ships** | One evidence rule for `messaging-tone-gate`: an advisory hold the sender explicitly acknowledged and re-sent settles `wrong`. |
| **At what strength** | `self-report` rung, `self-report` strength. An override proves the sender bypassed the hold, NOT that the gate was objectively wrong. |
| **The join** | A **signed token**. The advisory 422 carries `decisionToken`; the re-send echoes it in `metadata.toneDecisionToken`; the seam verifies it and annotates that exact correlation id. Stateless. |
| **What does NOT ship** | Any `right` rule. No signal establishes that a hold was *correctly* placed (ACT-933). |
| **What stays unknown** | Every quiet PASS, every unoverridden hold, every degraded decision, every override without a valid token. Silence is never a grade. |
| **Authority** | None. A missing, forged, or expired token never blocks a send — it only means nothing is recorded. |
| **Honest scope** | A lower-bound count of contested holds, paired with a count of the ones we couldn't attribute. NOT precision, recall, or model comparison. |
| **Rollout** | Live on developer agents via the existing decision-quality seam; dark on the fleet. No new config key, no new stored state. **Pool/fleet aggregation of this rule is PROHIBITED** until sticky retry routing or shared verification keys exist. |

## Problem statement

The LLM-Decision Quality Meter records faithfully and grades nothing.

Measured on the serving machine, 2026-07-23, 168-hour window:

| decision point | decisions | outcomesKnown | right | wrong | unknown | expired |
|---|---|---|---|---|---|---|
| `messaging-tone-gate` | 1087 | 856 (78.7%) | **0** | **0** | **856** | 9 |
| `completion-claim-verify` | 2 | 2 | 0 | 0 | 2 | 0 |
| every other wired point | 0 | 0 | 0 | 0 | 0 | 0 |

`messaging-tone-gate` is ~99% of all graded volume, and every settled verdict is
`unknown`, written by `tone-window-unknown-v1` — a **window closer**, not a grader.

Root cause: grading for this point was never built.

- `RULE_REGISTRY` has exactly two `right`-producing rules; both belong to rare-event
  points that fired **zero** times in the window.
- `MessagingToneGate.review()` supplied a `provenance` block with no
  `onCorrelationId` callback, so the gate never learned its own decision's id.
- `logToneGateDecision()` writes one line to **stderr**, carrying no correlation id
  and not durable.

Nothing carried a decision's identity from the HOLD to what happened next.

**What this spec fixes and what it does not.** It builds the missing identity link
and ships the first rule, moving the point from "no outcome evidence can exist" to
"a recorded sender-disagreement settles a grade." It is **not** a quality rate:
wave 1 cannot say the gate was right, so precision, recall and model comparison stay
out of reach until ACT-932/ACT-933 land. Model/prompt comparison is **BLOCKED, not
underpowered** — with no `right` signal there is no rate to compare, and more volume
does not change that.

## Goals

- **G1.** Produce a genuine outcome grade for `messaging-tone-gate` from a
  deterministic, already-occurring event — no human labelling ritual, no LLM judge.
  Scope precisely: a *lower-bound count of contested holds*, never a quality rate.
- **G2.** Grade **honestly**. Silence must never be promoted to a grade. A quality
  number built on absence-of-complaint is worse than no number.
- **G3.** Keep evidence strength load-bearing: a self-report must be labelled a
  self-report and must never be blendable with independent evidence.
- **G4.** Preserve the existing 856 `unknown` rows as honest history. Their evidence
  was never captured; inferring it now would be fabrication.
- **G5.** Zero authority. No rule here may alter, delay, or block any message, and no
  evidence failure may affect delivery.

## Non-goals

- Enrolling the other 49 pending decision points — deferred until this one grades.
- Migrating blocking rules to advisory (operator decision, CMT-904).
- Any LLM-interpreter-rung rule (`EVIDENCE_RUNGS` marks it DORMANT).
- Changing what the tone gate decides or how.

## Proposed design

### 6.1 The join: a signed token, not a content fingerprint

When the gate holds a message under an **advisory** rule, `evaluateOutbound` returns
422 with the pitfall named and the message NOT sent. The sender may re-send with
`metadata.toneAdvisoryAck = "<rule>"` to acknowledge and deliver. That round trip
already exists (operator directive, 2026-07-18).

This spec adds one field in each direction:

1. **Hold.** The 422 body gains `decisionToken` — an opaque signed envelope over
   `(correlationId, rule, expiry)`.
2. **Override.** The re-send echoes it in `metadata.toneDecisionToken`.
3. **Grade.** The seam verifies the token and calls
   `annotateDecisionOutcome({ correlationId, ... })` against the id it recovers.

**Why signed rather than a bare id.** A bare correlation id in a client-supplied
field would let any caller annotate an arbitrary decision `wrong`. The token is an
HMAC envelope minted and verified by the seam; it accepts nothing it did not issue.
The **rule binding** matters equally: without it a token minted for one advisory
hold could be replayed against a different decision citing a different rule.

**Normative token format** (round-8, codex gpt-5.5 f4 — "opaque signed envelope"
was directionally right but left room for divergent implementations):

| | |
|---|---|
| Payload | `<correlationId>.<rule>.<expiryEpochMs>` — dot-delimited, UTF-8 |
| Delimiter safety | mint REFUSES a correlationId or rule containing `.` (no smuggling); returns null and the field is omitted |
| MAC | **Full** HMAC-SHA256 over the payload, hex (64 chars). An earlier draft truncated to 128 bits; round-9 (gemini-3.1-pro f1) correctly noted the truncation bought nothing measurable — a token is not bandwidth-constrained — so the full MAC is used |
| Key id | a 12-char public id (HMAC of a fixed label under the same key) prefixed to the token — identifies the key, never reveals it |
| Wire form | `keyId + "." + base64url(payload) + "." + mac` — exactly 3 dot-separated parts |
| Expiry | epoch **milliseconds**; `nowMs > exp` ⇒ reject |
| Max accepted length | 512 chars (longer ⇒ `malformed`, no parse attempted) |
| MAC comparison | `crypto.timingSafeEqual`, length-checked first |
| Key | `crypto.randomBytes(32)`, generated once per process |

**Why the signing key is NOT persisted.** A token only has to survive one request
round trip. A process-lifetime key means a restart invalidates outstanding tokens —
costing at most the overrides in flight during that second, which then settle
`unknown` (the safe direction), never mis-graded. That removes a key file, its
permissions, its corruption modes, and any rotation story.

**Why not a content fingerprint** (round-7, codex gpt-5.5). An earlier build hashed
the candidate text and looked it up in a durable store at delivery time. It required
a persisted HMAC key plus lifecycle, a store with retention, a scope tuple
(channel + topic + kind), and a heuristic tie-break when the same text was held
twice — an elaborate local cache reconstructing a link that can simply be handed
over. Review named it correctly: shipping known-worse machinery and documenting
around it. The token is exact where the fingerprint was heuristic, stateless where
it was durable, and travels with the retry where the fingerprint could not cross a
machine boundary. **All of that machinery was deleted, not extended.**

### 6.2 Outcome evidence signals

**(A) Explicit advisory override — the shipped signal.**
The sender saw the objection and shipped the text anyway.

**It is NOT proof the gate was objectively wrong.** A sender may override for
urgency, for a policy tradeoff, or because a valid rule is inconvenient. What is
deterministically established is that they CHOSE TO BYPASS the hold — an assertion
by the judged party about its own judgment. **None of this is ground truth**; that
term is reserved for independent or user-observable outcomes, and wave 1 has none.

→ grade `wrong`, rung `self-report`, strength `self-report`. Rung precedence
(§5.4.3) therefore lets ANY independent grader outrank it, which is the correct
relationship between "the sender disagreed" and real outcome evidence.

**(B) Hold honored by revision — NOT shipped.**
The intended `right` signal was: a hold whose text never shipped, followed by a
different message that passes. It does not survive review — nothing establishes that
the replacement came from the same author. A second session serving the same topic
(a live failure mode) would have its message counted as "the rewrite" and fabricate
a `right`. An authorship inventory was performed: outbound headers identify the
AGENT but not which SESSION; the reply route and message store record no sender.
Deferred to **ACT-933**.

**(C) Everything else — stays `unknown`.**
A PASS that drew no complaint. An unoverridden hold. A degraded or failed-open
decision (no model judgment was made, so there is nothing to be wrong about). An
override with a missing or invalid token.

**This is the G2 line and it is deliberate.** The common case — a message passed and
nobody objected — is not evidence the gate judged well, because a gate that passed
everything unconditionally would score identically. Counting silence would
manufacture a ~99% figure that measures nothing.

**Consequence, stated plainly:** wave 1 emits `wrong` and `unknown` only. A reader
must not mistake "3 wrong / 800 unknown" for "the gate is wrong every time" — the
denominator of *known* outcomes is tiny by construction, and the read surface's
`insufficientEvidence` marker (below `minSampleForRates`) is what keeps that honest.

### 6.3 What the sender sees, and the additive guarantee

`howToProceed` gains a clause naming the token. **A caller that ignores it keeps
working exactly as before**: the override still delivers, unchanged, and simply
settles `unknown`. No existing consumer breaks, and the operator's 2026-07-18
semantics — advisory rules nudge, the agent decides, the override is recorded — are
untouched. Only the recording MECHANISM changes, which is what this spec governs.

**Every failure is counted, not shrugged at.** `getToneContestationCounters()`
reports `minted`, `gradedViaToken`, `overridesWithoutToken`, and `rejected` by
reason.

**Exact predicates** (round-8, codex gpt-5.5 f3). All four counters are evaluated
at ONE site: inside the accepted-override branch, which is reached only when the
cited rule's disposition is `advisory` AND `options.toneAdvisoryAck === result.rule`.
So every counter below already presupposes "the seam accepted this as an advisory
override and is delivering the message."

| Counter | Fires when |
|---|---|
| `minted` | a token was successfully minted onto an advisory 422 (decision reached the router; seam live) |
| `overridesWithoutToken` | accepted override, `metadata.toneDecisionToken` **absent or null** |
| `rejected.malformed` | token present but unparseable / wrong shape / over-length |
| `rejected['foreign-key']` | key id does not match this process's — minted by another process/machine, or before a restart. **Routine topology, NOT an attack** |
| `rejected['bad-signature']` | same key id, MAC mismatch — the genuine forgery signal |
| `rejected.expired` | valid MAC, `now > exp` |
| `rejected['rule-mismatch']` | valid MAC and unexpired, but minted for a DIFFERENT rule |
| `gradedViaToken` | token verified AND `annotateDecisionOutcome` reported `applied` |

Note what this means: a **fabricated or stale `toneAdvisoryAck` with no token** is
indistinguishable from an honest un-updated caller, and both land in
`overridesWithoutToken`. That is correct and deliberate — the ack governs DELIVERY
(existing behaviour, unchanged), the token governs ATTRIBUTION, and neither can
substitute for the other. An ack alone can never produce a grade. `overridesWithoutToken` is the load-bearing one: an override happened whose
decision could not be identified (a caller that did not echo, or a hold issued on
another machine). **Any surface showing an override count MUST show it beside**, or
a number that means "we are rarely watching" reads as "the gate is rarely
contested". A non-zero `rejected['bad-signature']` is a forgery signal worth an
operator's attention — and it stays one **because `foreign-key` is classified
separately** (round-9, codex gpt-5.5 f3). Without that split, ordinary
multi-machine retry routing and every restart would register as forged tokens,
burying a real attack signal in routine topology noise and training an operator to
ignore the counter. Key identity is checked FIRST, before the MAC.

**Pool/fleet aggregation of this rule is PROHIBITED** (round-10, codex gpt-5.5 f2).
"Developer-agent only" is not merely a rollout posture here: because the signing key
is process-local, measured contestation partly reflects routing stickiness, deploy
cadence and caller-version skew rather than sender disagreement alone. Aggregating
across machines or over deploy boundaries would present topology as behaviour. The
prohibition lifts when sticky retry routing or a mesh-shared verification key exists
(ACT-933), not before.

**Verification coverage is a first-class denominator** (round-8, codex gpt-5.5 f2).
The honest ratio is `gradedViaToken / (gradedViaToken + overridesWithoutToken +
Σ rejected)` — the share of accepted overrides that could be attributed at all. Any
surface presenting these counts MUST label them **"same-process attributed only"**
unless sticky retry routing or a mesh-shared verification key is active. Retry
routing, load balancing, restarts, and caller-version skew can all correlate with
contested sends, so the counts are not a uniformly-thinned sample and must never be
compared across time or machines as if they were.

### 6.4 The existing 856 rows

They predate the token and have no captured evidence, so they cannot be graded.
Claiming otherwise would be inventing data. They stay honestly `unknown`.

Verification of the live path runs on a **throwaway agent with its own state
directory** per the Live-User-Channel Proof standard, so verification traffic never
enters the production agent's `decision_quality` tables — no tagging or filtering
rule is needed because the rows are never co-located.

## Testing (all three tiers — Testing Integrity Standard)

**Tier 1 — unit** (`tests/unit/tone-decision-token.test.ts`, 14 tests). Mostly
adversarial, because the signature is the only thing between a caller and annotating
an arbitrary decision: forged MAC, payload edited to point at another decision,
expired (including both sides of the boundary), replayed under a different rule,
truncated, and malformed input of every shape — all fail CLOSED with no correlation
id recovered. Plus mint-refusal on delimiter-bearing ids, counter independence, and
snapshot immutability. Registry agreement pins `self-report`/`self-report` and
asserts NO right-producing rule exists for this point.

**Tier 2 — integration** (`tests/integration/tone-gate-contestation-evidence.test.ts`,
5 tests; real Express route, real gate, real router, real annotate chokepoint):
the 422 carries a token and the `howToProceed` names it; echoing it settles `wrong`
under `byStrength['self-report']` and **not** `deterministic-proof`; an override
WITHOUT a token still delivers, grades nothing, and increments
`overridesWithoutToken`; a FORGED token still delivers and grades nothing; and the
G2 negatives — a quiet PASS terminalizes `unknown`, a later unrelated message never
retroactively scores an earlier one.

**Tier 3 — E2E** (`tests/e2e/decision-quality-alive.test.ts`): boots the real
AgentServer on the production init path; `GET /decision-quality` answers 200 (not
503), `wiredButNoGrader` does not list `messaging-tone-gate`, the rule resolves at
its declared rung/strength, and the grade pass still answers 200.

**Wiring integrity:** the `onCorrelationId` callback is genuinely attached and fires
on a real review — proven during development, when driving the gate with a bare
provider instead of the router produced zero recorded decisions.

## Rollout & rollback

Observe-only by construction. **Enabled on developer agents, dark on the fleet:** the
token mint/verify rides the existing `provenance.uniformSeam` resolution, verified
live (dev resolves `{ enabled: true, dryRun: false }`; the fleet resolves dark and
no token is ever minted). No new config key — it cannot drift out of sync with the
substrate it grades.

Rollback ladder, cheapest first: (1) leave the seam dark — no token is minted, the
`decisionToken` field is absent, every path is a no-op; (2) remove the rule from
`RULE_REGISTRY` — the point reverts to all-`unknown`, settled grades stay as honest
history; (3) revert the commit. **No persisted state at all**, so there is nothing
to migrate, clean up, or unwind.

## Frontloaded decisions

**FD-A. Silence is not a grade.** Rejected: promoting no-complaint PASSes. A
pass-everything gate would score identically.

**FD-B. One rule, registered at its true strength.** A rule registers at the strength
its evidence supports; the read surface segments rather than blends.

**FD-C. A signed token, never text.** Rejected: storing a text head (content
discipline), and reusing the existing unsalted `candidate.sha256` (dictionary-
confirmable over the small space of agent replies, and no lookup path). Superseded
entirely by the token — no fingerprint of any kind now exists in this design.

**FD-D. Grade forward, not backward.** The 856 existing rows stay `unknown`.

**FD-E. Override coverage is narrow today.** Only `B21_USER_TASK_SUBSTITUTION` is
advisory, so evidence is limited to that rule's traffic until the CMT-904 migration.
Built so coverage widens automatically if the operator takes it.

**FD-G. A PASS followed by a user CORRECTION is deferred.** Real signal, but
attributing a correction to one prior message is inferential and the join is noisy.
Tracked as **ACT-932**; additive when built.

**FD-H. An override is `self-report`, not proof.** Rejected: `deterministic-proof`.
It establishes bypass, not error. Cost: the strongest signal wave 1 has carries its
weakest-but-true label. Intended trade.

**FD-I. No `right` rule ships.** Rejected: the revision proxy. It cannot establish
authorship and would fabricate grades. Tracked as **ACT-933**. Consequence accepted:
a meter that says "wrong" and "don't know" is strictly more than today's "don't
know" for everything, and infinitely more than one that says "right" without grounds.

**FD-J. Storing sender-disagreement as `wrong` is a deliberate mapping into a closed
enum, with a NAMED residual.** The enum (`right | wrong | unknown`) belongs to the
parent spec; widening it from a dependent spec is scope creep. Emitting `unknown`
would be worse — a recorded disagreement IS evidence, and calling it "no evidence"
is the same dishonesty inverted. **The residual:** a future export or chart that
counts bare `wrong` without segmenting by strength will misread this. Mitigations:
`byStrength` is the meter's DEFAULT aggregate; the rule sits at the lowest rung; the
`ruleId` is persisted AND served in `byRule`, giving any consumer a machine-readable
discriminator without a schema change. A parent-spec `gradeInterpretation` field is
recorded as a suggested improvement to `llm-decision-quality-meter` §5.4 — and
tracked as **ACT-934**, so it is a scheduled change with an owner rather than a
sentence in a spec.

**Binding requirement on NEW surfaces** (raised in rounds 3–10; the reviewer's
narrower resolution is adopted): any surface added from here that exposes this
decision point's grades MUST read `byRule` or `byStrength`, never bare
`gradeDistribution.wrong`, **and MUST render this rule's grades with an explicit
compound label — `contested (self-report)` or `contested_wrong_self_report` — never
the bare word `wrong`.** The `ruleId` is persisted AND served, so a machine-readable
discriminator already exists without a schema change; the residual is confined to a
consumer that ignores both served discriminators, which is a reviewable defect in
that consumer rather than an ambiguity in this data.

## Alternatives considered

**A. Content fingerprint + durable store.** Built, then **deleted** in round 7. See
§6.1 — heuristic where the token is exact, stateful where the token is not, and it
could not cross a machine boundary.

**B. A bare correlation id in the metadata field.** Rejected — lets any caller
annotate an arbitrary decision `wrong`.

**C. An LLM judge reading message content to decide whether an override was
justified.** Rejected outright. The interpreter rung is DORMANT, and a content-
reading judge is the most direct route to manufacturing the grades this spec exists
to prevent.

**D. Persisting the signing key.** Rejected — a token lives minutes; persistence buys
nothing and costs a key file, permissions, corruption handling and rotation policy.

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| `tone-advisory-override-wrong-v1` (grade a token-bound override `wrong`) | **invariant** | Deterministic by design: verify a signature, check an expiry and a rule binding, annotate. No competing signals to arbitrate — the token either verifies or it does not. The genuine uncertainty is in INTERPRETING an override, which is handled by the `self-report` rung (FD-H), not by an arbiter. A judgment layer reading message content to decide whether an override was "justified" would manufacture exactly the grades this spec prevents. |
| Token verification (accept / reject) | **invariant** | A cryptographic check with a closed rejection taxonomy, failing closed on every branch. Judgment here would be an authority surface, which G5 forbids. |
| `messaging-tone-gate` (the gate's own block/allow verdict) | **unmodified** | This spec adds an `onCorrelationId` callback, a `correlationId` result field, and an additive response field. None is read by any block/allow branch; the verdict is byte-identical with and without them. |

No decision point here gates information flow, blocks an action, or constrains agent
behavior. Every rule is measurement.

## Multi-machine posture

| Surface | Posture | Mechanism |
|---|---|---|
| The signing key | **machine-local, process-lifetime** | `machine-local-justification:` **not claimed and not needed** — the key is not state, it is an ephemeral in-process secret with a lifetime shorter than one request round trip. Nothing to replicate. |
| Grades written via `annotateDecisionOutcome` | machine-local storage, **proxied-on-read** | Same substrate as every existing rule's grades; `?scope=pool` already merges them machine-tagged. |
| The rule registry entry | **unified** | Shipped source constant. |

**The cross-machine case, stated plainly.** A hold issued on machine A mints a token
carrying A's key id. If the override is re-sent through machine B, B sees a foreign
key id, classifies it `foreign-key`, and cannot annotate A's row (which lives in A's
substrate anyway). The decision settles `unknown` — **honestly ungraded, never
mis-graded**, which is the safe direction, and the case is *named* in the counters
rather than lumped in with forgery.

This is strictly better than the fingerprint design it replaced, where the same case
was silently invisible. The residual bias is **not necessarily random**: if retries
route differently from first attempts, misses concentrate. Wave 1 therefore treats
the count as an existence signal, never a rate, and **pool-level interpretation is
BLOCKED** until sticky retry routing or a mesh-shared verification key exists
(ACT-933).

## Clock and ordering assumptions

- **Expiry uses one machine's wall clock** — mint and verify happen in the same
  process, so no cross-machine time comparison occurs.
- **Skew fails CLOSED**: an unparseable or past expiry rejects the token; a rejected
  token grades nothing.
- **No NTP assumption** is required, and no monotonic-clock upgrade is claimed.
- **Ordering is not a factor**: the token carries the identity, so there is no
  "which decision came first" question to resolve.

## Glossary

- **Decision point** — a named place where an LLM makes a judgment call.
- **Window closer / terminalizer** — a rule that writes a final `unknown` when an
  evidence window expires with nothing observed. A timer, not a judge.
- **Route seam** (`evaluateOutbound`) — the single function every agent→user message
  passes through before delivery.
- **Correlation id** — the per-decision id the intelligence router mints; the join
  key between a decision and anything recorded about it.
- **Rung / evidence strength** — the meter's two-axis classification of how
  trustworthy a grade's evidence is. **Inherited from `llm-decision-quality-meter`
  §5.4.2/§5.4.3, not invented here**: this spec registers into an existing taxonomy
  and adds no new value. It is a small closed enum with fixed precedence rather than
  a numeric confidence score because consumers must be able to SEGMENT (never blend)
  evidence classes.
- **Advisory rule** — a rule that nudges rather than blocks; the sender holds the
  final decision and may override with an acknowledgment.

## Open questions

*(none)* — FD-G and FD-I resolve the deferred rules with tracked owners (ACT-932,
ACT-933); FD-J records the enum residual as a decision with a named mitigation.
