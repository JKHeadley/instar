<!-- GENERATED FILE — DO NOT EDIT.
     Source: docs/specs/outbound-gate-advisory-override.md
     Regenerate: node scripts/generate-spec-contract.mjs --spec docs/specs/outbound-gate-advisory-override.md --strict
     STRICT IMPLEMENTATION CONTRACT: allowlisted contract sections only.

     Everything not on the allowlist is ABSENT BY DEFAULT — including all
     rationale. This file says WHAT to build, never why. Read the source
     spec for the reasoning, the alternatives, and the accepted residuals
     in their full form.
     (38 residual "round-N" reference(s) remain inline.)
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

## 3. Design

### 3.1 Three dispositions, not two

| Class | Members | Disposition |
|---|---|---|
| Judgment / representation | B1–B21 (every LLM-citable rule) | **advisory** — overridable with a recorded reason |
| Deterministic credential **wall** | **B22_HELD_CREDENTIAL** (new, non-LLM) — **proven possession only**: the candidate contains a credential value this install actually holds, verified by exact comparison | **blocking**, no agent override |
| Deterministic credential **nudge** | **B23_CREDENTIAL_SHAPED** (new, non-LLM) — **every** credential-*shaped* pattern match (§3.2) | **advisory** — overridable with a recorded reason **wherever recourse exists; observe-only everywhere else** (the B23 rule, below) |
| Availability holds | `CAPACITY_UNAVAILABLE`, `GATE_UNAVAILABLE` | **blocking**, non-overridable, and *not a judgment* — nothing concluded. *(The degraded deterministic floor is NOT in this class: it does conclude something, so round 17 made it advisory — see below.)* |

**The wall is POSSESSION, and nothing else (settled over rounds 2, 7 and 11 —
each time by the Standards-Conformance Gate against the Signal-vs-Authority
standard, and each time by narrowing).** v2 gave the whole pattern arm
unappealable authority. Read against the actual pattern source
(`DURABLE_SECRET_PATTERNS`), that is a Signal-vs-Authority violation with
concrete failure cases: `labeled-secret` matches
`(?:token|secret|password|…)["'=:\s]+([A-Za-z0-9._-]{12,})`, so the sentence
*"your api_key: not-configured-yet"* is a match; `bearer-token` matches
`Bearer your-token-here-example`; and the module's own header flags `jwt` as a
known false-positive suspect on dotted identifiers. Those are ordinary sentences
an agent writes **to** the operator, and v2 would have suppressed them
irreversibly with no recourse. Authority is now proportional to signal
confidence — and round 11 took the argument to its end. The gate's objection to
the *remaining* wall-grade patterns holds too: `ghp_xxxxxxxxxxxxxxxxxxxx` in a
sentence explaining what a token looks like is a match on
`gh[pousr]_[A-Za-z0-9]{20,}`, and it is not possession. **No regex is
possession.** The operator's own words for the one wall were "an *actual live*
password or key" — proven, not shaped.

So the final rule is one line: **possession ⇒ wall; shape ⇒ nudge.** B22 is the
value arm alone; every pattern kind is B23. This deletes the tier map, the
per-kind assignment argument, and the shadow-mode staging that existed only
because pattern matches were about to hold irreversible authority — the
recurring "this is too complex" finding, answered by removing machinery rather
than by defending it.

**What that costs, stated plainly.** A live credential this install does *not*
hold — a key for another account, read from a file — becomes a **nudge**: the
message still stops, and sending it requires a consciously written reason that
is recorded. The wall was always a barrier against *accident*, never against a
determined agent (§4 already concedes that splitting, encoding or describing a
secret defeats it). A nudge is a full barrier against accident. What is given up
is the ability to stop an agent that has written down a justification — and
paid for by removing the ability to silence an ordinary sentence forever.

**Availability holds are a distinct class (G9).** They are not the gate deciding
the message is wrong; they are the gate being unable to decide. They stay
terminal, they are never ackable, and the agent-facing payload MUST say the hold
is an availability hold so no ack is attempted and no round trip is burned. The
degraded deterministic floor (`buildDegradedToneResult`) was carved out as
**blocking** through v19, on the argument that during a provider outage it is the
only leak protection running. That carve-out is retired — see immediately
below.

**Round-17 correction — the carve-out is RETIRED.** The Standards-Conformance
Gate flagged it twice in one pass (Signal vs. Authority; No Silent Degradation to
Brittle Fallback), and applying this spec's own B23 rule agrees: the degraded
floor produced **unanswerable holds using rule ids that are advisory under the
real gate** — the same defect for the sixth time, this time inside the exception
I wrote for it. The floor is reached only after the provider failure-swap chain
is exhausted, and at that point the author is the only judge available; a
degraded regex is precisely the low-context signal that should not outrank them.
So **degraded-floor citations are ADVISORY**, under the identical recourse rule:
overridable with a recorded reason where the override path is reachable
(it is — the override path is deterministic and does not need the provider),
observe-only where it is not. The credential wall is unaffected: B22 runs
independently of the LLM path and is never overridable, so the irreversible case
keeps its protection while judgment stops being decided by a fallback.

**Round-22: the tension resolves properly, and the answer was a third option.**
The gate flagged *No Silent Degradation to Brittle Fallback* a third time, and
the parent-principle fit dropped to `weak` — which is the signal that a defence
is being repeated rather than a problem solved. Re-reading the objection instead
of my answer to it: the complaint is that the brittle fallback becomes a
**delivery path by default**. Both of my previous positions accepted that framing
— v19 made the floor authoritative (unappealable), v22 made it deliverable
(overridable). Neither asked whether the message has to be *decided* during the
outage at all.

It does not. **A degraded-floor citation is an ordinary advisory hold** — the
same 422, the same token, the same override-with-a-reason — carrying
`source: 'degraded-floor'` and the situation named. Concretely it hands back the message with the situation named — "the full reviewer is
unavailable; re-send in a few minutes for a real review, or override now with a
recorded reason if this is urgent." The brittle fallback stops being a delivery
path *and* stops being a wall. The decision waits for the reviewer whose judgment
we actually wanted, and **the author's own re-send is what resumes it**.

**Round 25 deleted the queue this paragraph used to describe.** v27 held the
message in an in-memory deferral queue with a TTL, eviction, idempotency keys,
restart-loss disclosure, recovery re-submission and an attention item — a small
workflow engine, which is the thing this spec rejected in §3.5.1 and then built
anyway under another name. codex named it twice. The queue bought exactly one
thing over telling the author to re-send: it removed the need for the author to
re-send. That is not worth a lifecycle. **The agent is a program that can retry;
the honest design is to tell it so.**

- **Recourse still exists for urgency**: the author may override with a recorded
 reason to send immediately rather than wait — waiting is the default,
 impatience is a recorded decision.
- **Waiting must not depend on the author REMEMBERING (Standards-Conformance
 Gate, flagged in both runs of the final pass: *No Manual Work — user or
 agent*).** Deleting the queue removed a workflow engine, but it left "re-send
 in a few minutes" as an instruction the agent has to hold in its head — which
 is the willpower-over-structure failure this project exists to eliminate, and
 the gate was right to catch it. The answer is **not** to rebuild the queue: it
 is to use the durable follow-through mechanism that already exists. The
 **seam itself opens the commitment** (`POST /commitments`,
 `type: one-time-action`, `owner: agent`, carrying the candidate hash and the
 citation) at the moment it returns a degraded-floor hold — the author is not
 asked to remember, or even to act. *(The gate flagged the instruct-the-author
 version too, and was right again: "tell the agent to do it" is still manual
 work. Automatic at the seam is the only version that satisfies the standard.)*
 The existing beacon then carries the retry across session ends, restarts and
 compaction — more durable than the deleted in-memory queue ever was, while
 adding **no new machinery to this feature**: it delegates durability to the
 follow-through system that already exists for exactly this. The commitment is
 idempotent on the candidate hash, and it is closed automatically when the
 message is later delivered, overridden, or abandoned by the author.
 **It is an integration, not a lifecycle this feature owns.** The
 difference is ownership: the deleted queue was *new storage with new expiry,
 eviction, recovery and alerting semantics built inside the gate*. A commitment
 is a **row in a system that already exists** and already answers every one of
 those questions — durable store, beacon cadence, close/abandon paths, operator
 surface. This feature supplies exactly `{type: 'one-time-action', owner:
 'agent', externalKey: <candidate sha256>, summary: '<rule id> held while the
 reviewer was offline'}` and closes the row on delivery, override or
 abandonment — no other fields, no message text, no new states. **It is a
 reminder, not an automatic retry.** Carrying no message text
 means it cannot re-submit anything, and that is deliberate: it prompts the
 author to re-compose or re-send once the reviewer is back. Storing a draft to
 enable true auto-retry would be a new content store with its own consent and
 lifecycle — exactly what rounds 25 and 30 removed. Its privacy
 posture is the commitment store's, and the row carries the **candidate hash and
 citation only, never the message text** — the text stays where §3.6 puts it.
- **Availability holds are unchanged** — they conclude nothing, so there is
 nothing to re-review; they stay terminal.
- **B22 is unchanged** — possession never depended on the provider.

Recorded because it is the more useful lesson: **twice I answered a repeated
objection by picking a different side of the same false choice.** The gate was
not asking me to choose better between block and deliver; it was pointing out
that neither was necessary.

**The earlier framing, kept for the record.** Having made the
floor advisory, the Standards-Conformance Gate flagged the *opposite* concern
under **No Silent Degradation to Brittle Fallback**: a message can now be
delivered, via override, in a window where the real judge could not judge at all.
Both flags are correct about their own standard, so this is a genuine tradeoff
rather than a defect to patch, and it is resolved rather than split:

1. **It is not silent, and that is the word the standard turns on.** The citation
 is labelled `source: 'degraded-floor'`, the agent-facing text says the full
 reviewer is unavailable, every override in a degraded window is recorded with
 its reason, and those overrides are counted on a **distinct outage-window
 counter** surfaced separately from ordinary overrides — so "how much got
 through while the gate was down" is a number, not a guess.
2. **The irreversible case never depended on the LLM.** B22 runs independently of
 the provider and is never overridable. What the floor decides during an outage
 is representation and judgment — the recoverable class — and there the author
 is the only judge present.
3. **The operator already owns the fail-closed lever**, and this spec does not
 take it away: `failClosedOnExhaustion: true` replaces the degraded floor with a
 pure availability hold (terminal, non-ackable, §3.1). An operator who prefers
 silence to author judgment during an outage sets it. **That choice is theirs,
 and naming it here is the honest answer to the flag** — the default is the
 middle path, not the only path.
4. **The tradeoff hierarchy decides the default**: an agent that cannot reach its
 operator during a provider outage is worse than one whose judgment is
 unreviewed for that window, because the first failure is invisible and the
 second is recorded.

**The citation must still be LABELLED.** The
degraded floor emits an ordinary rule citation — `B2_FILE_PATH`,
`B15_CONTEXT_DEATH_STOP` — so once the widening is live, the author sees the
*same rule id* accept an override at 10:00 and refuse one at 10:01, with nothing
in the payload explaining the difference, and burns a round trip discovering it.
Every degraded-floor refusal therefore carries `source: 'degraded-floor'`,
`overridable: true` (per the correction above), and an agent-facing line saying
the full reviewer is unavailable and this citation came from the fallback
check. The label now tells the author which
*kind* of review produced the citation — a degraded fallback rather than the
full-context gate — which is information they need when writing an override
reason, not a refusal.

**Neither B22 nor B23 is a member of `VALID_RULES` or `RULE_CLASSES`.**
`interpret()` honors any rule in `VALID_RULES`, so admitting B22 there would let
a hallucinated model citation produce the one non-overridable verdict in the
system — precisely what this spec forbids. Both have their own result shape,
produced before the model runs and carrying `source: 'deterministic-credential'`.
The parity ratchets are extended to assert both are **excluded** from the LLM-
citable enums, and a unit test asserts an LLM response citing either id is
treated as an invalid rule (retry), never honored.

**Override admission is keyed on the verdict's PRODUCER**, so a model can never
reach the deterministic dispositions and a detector can never inherit an LLM
one. Two closed maps, each unit-tested, and admission requires
`result.advisory === true` **and** a match in the map for that producer:

| Producer | Admission requires |
|---|---|
| LLM verdict (`source` absent) | `result.rule ∈ VALID_RULES` **and** `RULE_DISPOSITIONS[result.rule] === 'advisory'` |
| Deterministic detector (`source === 'deterministic-credential'`) | `DETERMINISTIC_RULE_DISPOSITIONS[result.rule] === 'advisory'` — a closed two-entry map: `{ B22_HELD_CREDENTIAL: 'blocking', B23_CREDENTIAL_SHAPED: 'advisory' }` |

Never a pseudo-rule, never B22 by any path.

Out of scope and unchanged: the localhost-link guard and the 4096-length check.

### 3.2 B22_HELD_CREDENTIAL — the one wall

B22 is deterministic and pre-LLM. It cannot be argued with and costs nothing when
it does not fire.

**Placement (G-critical).** B22 sits **alongside the localhost-link guard**: before
the `if (!ctx.messagingToneGate) return { ok: true }` early return and **outside**
the `try { … } catch { /* fail-open */ }` block that wraps the tone-gate review —
otherwise a throw is swallowed and the message delivers, contradicting the stated
fail direction. **The relay path's call site, named.** `evaluateOutbound` short-circuits when `isProxy || isSystemTemplate ||
willRelay`, and that early return is *above* everything. The required change is
therefore explicit: **the deterministic credential evaluation is hoisted above
that early return**, so B22 and B23 run on the composing machine for a
relayed send even though the LLM review does not. The short-circuit continues
to skip the review, the recording, and the advisory protocol — it no longer
skips the wall.

**But B23 stays observe-only on those paths.** v15's row 23
let a B23 match *hold* there, which is an unanswerable regex block: those
callers have no advisory protocol to answer it with. That is the same defect
this spec rejects at the adapter layer and at Stage 0, appearing a third time,
and it gets the same answer — **a hold only exists where recourse exists.**
Rows 23/23a pin it, and an integration test drives a `willRelay` send end to
end.

A second instance sits at the **adapter send primitive**
(`TelegramAdapter.sendToTopic` and the Slack/WhatsApp/iMessage equivalents),
because `evaluateOutbound` is skipped entirely when `isProxy || isSystemTemplate ||
willRelay`, and there are many non-adapter `sendToTopic` callsites plus the
always-on cold-start lifeline fallback that deliberately bypasses the gate. The
adapter primitive is the true single egress; the seam instance is the early,
cheap one that produces a good agent-facing refusal.

**The adapter instance is B22-ONLY.** The two layers are not
symmetric and must not pretend to be: the override protocol — tokens,
correlation ids, an actionable 422 — lives at the seam, and the adapter has no
caller it can hand a token to (its callers include system templates, relays and
the lifeline fallback). A B23 citation there would be a hold nobody can
answer, which is a terminal block wearing an advisory label. So the adapter runs
**possession detection only**; B23 exists exclusively at the seam. An adapter
B22 hit on a message the seam already approved (possible only on gate-bypassed
paths, which is why the adapter instance exists) refuses and is counted
`b22-adapter-caught-post-seam` — a signal worth watching, since it means a live
credential reached egress through a path with no review.

**Arm 1 — known-live-value (primary).** The candidate contains, as a substring, a
credential value this agent actually holds.

- **Source set is STAGE-AWARE.** **PR-A: the loaded-config allowlist only.** The
 isolated matcher later adds vault-backed credentials. `valueArmScope` reports
 one of `config-only` (PR-A's normal state), `vault-unavailable` (config-only
 while a vault exists that is not covered), or `isolated-matcher` (the future
 full state) — so the wall's real coverage is readable rather than assumed. The
 full source set, for when the matcher lands:
 the `SecretStore` (`stateDir/secrets/config.secrets.enc`), *plus* the
 credential-bearing leaves of `.instar/config.json` — `authToken`, the Telegram
 bot token, tunnel tokens, and any `*Token` / `*Secret` / `*Password` leaf. This
 is not optional polish: `authToken` lives only in `config.json` and is a bare
 hex string, so a vault-only index misses it — and `authToken` plus the public
 tunnel URL in one overridden message is full remote API access to this agent.
 A unit test asserts a message containing this install's own `authToken` is
 refused.
- **The name is `HELD`, not `LIVE`, and the difference is load-bearing.** Exact comparison proves the candidate contains a value
 this install **holds in its store or config** — it does **not** prove that
 value is currently valid. A rotated-away token, or a placeholder someone left
 in config, is still "held", and would otherwise become an unappealable wall
 over a string that protects nothing. Two mitigations, both cheap: (a) the index
 **excludes** any value equal to a shipped config-template default or matching
 the code-declared placeholder list (`CHANGEME`, `changeme`, `your-*-here`,
 `xxx…`, `placeholder`, `example`, `TODO`) — an exclusion list with a written
 reason, ratcheted like the pattern exclusions; (b) the refusal counter is
 broken out per credential **key name**, so a wall firing repeatedly on one key
 is visible and points straight at a stale or dummy entry. A stale-but-real
 credential stays walled deliberately — refusing to send a rotated key costs
 nothing, and the agent cannot know it was rotated.
- **`dashboardPin` is below the ≥12 floor and is explicitly OUT of B22 scope.**
 Stated here rather than left to be discovered. It remains covered only by the
 (now advisory) judgment rules.
- **On a `bitwarden` or `manual` secret backend, only the VAULT half is
 unavailable** — config-held credentials are indexed as normal, which in PR-A is
 the whole index anyway. B23 still runs, and the payload carries
 `valueArmScope` from the stage-aware enum so a miss is never silent.
- **Normalization is SYMMETRIC and canonical.** v3 specified
 the candidate's three forms but never said the indexed credential is reduced
 the same way — and an asymmetric pipeline leaves separator evasion open at the
 exact point it claims to close it. One canonical pipeline, applied to **both**
 the indexed value and the candidate, in this order: (1) Unicode **NFKC**;
 (2) strip zero-width and bidi controls (`U+200B–U+200F`, `U+2028/2029`,
 `U+FEFF`); (3) form A = as-is, form B = all Unicode whitespace removed,
 form C = whitespace **and** `[-_.]` removed. The index stores the value in each
 form; the candidate is scanned per form; the ≥12 floor is applied to the
 *most-reduced* form so a short-after-reduction value is never indexed. This
 closes **formatting and separator** evasions — and, stated precisely because
 v7 implied otherwise, it does **not** close homoglyph or
 confusable-character substitution, which is recorded in §4,
 which matter because the instruction to reformat can arrive through
 attacker-influenceable inbound content.

**Arm 2 — pattern (composed, never restated; ALWAYS a nudge).** The pattern
arm **imports `DURABLE_SECRET_PATTERNS` from `src/core/durableSecretScrub.ts`**.
It does not hand-write a list. That module's own header documents three prior
copies drifting on `sk-ant-api…` vs `sk-ant-…` and warns that a fourth copy
"would bake Class-1 drift into the floor itself".

Every imported kind is B23. There is no tier map and no per-kind authority
argument: a pattern match holds the message and demands a recorded override, and
that is all it ever does. A ratchet still asserts B23's kind set ⊇
`DurableSecretKind` minus a code-declared exclusion list carrying a written
reason per exclusion, so a new pattern kind cannot ship unhandled.

B23 is **not a weakening**: wherever it holds at all, the citation *holds the
message* and demands an explicit, recorded override (and where it cannot be
answered it holds nothing — the B23 rule, §3.8). What it removes is the irreversible,
unappealable class of that hold. A live credential this install holds is caught
by Arm 1 regardless of its shape — so what B23 covers is exactly the population
where a match is a guess.

`labeled-secret` and `url-embedded-credential` still close the reviewer-identified
gap that a DB/SMTP password from another project would otherwise be waved
through — as nudges, which is what a shape match can honestly support.

**Entropy scanning stays excluded.** `SecretRedactor` offers it and it is right
for redaction (over-redacting is cheap). It is wrong for an irreversible wall:
git SHAs, fingerprints, correlation ids and base64 blobs all score high, and
every false positive is a message the operator never receives with no override.

**The wall costs nothing legitimate.** There is already a sanctioned path for
getting a credential to the operator — Secret Drop and auth-gated private views —
and the agent template forbids pasting credentials into chat regardless. B22
refuses rather than redacts, because redaction silently alters what the author
said and a partially-redacted credential still leaks its prefix.

**Refusal payload discipline.** The refusal never contains the matched value or
any slice of it. The detector *class* (`known-live-value` / `provider-pattern`)
is a confirmation oracle and stays in the machine-local audit only; the
agent-facing text says "contains a credential this install holds — revise"
. The spec forbids
interpolating the detector class or arm into any outbound or relayed text.
Relatedly, `logToneGateDecision` currently writes `text.slice(0, 80)` unscrubbed
to `logs/server-stderr.log`; the B22 path MUST route through a variant whose head
is passed through `scrubForStore` first, and `textHead` is scrubbed
unconditionally (cheap, in scope).

**Kill switch (required).** `toneGate.credentialWall.emergencyDisable` — absent ⇒
ON, mirroring the permission-prompt floor's reasoning that a stale persisted
`false` could re-disable the very safety it provides. Setting it is
dashboard-PIN-gated, audited, and raises an Attention item in **both** directions.
A fail-closed detector shipping enabled fleet-wide with no lever is not
acceptable. The lever disables **both** B22 and B23 (one detector, one switch);
B23 additionally follows the advisory machinery's own flags.

### 3.2.2 The wall's posture is reported whether or not it fires

A check that *cannot run* and a check that *ran and found nothing* both present
as silence. That failure shape cost this project three weeks of a dead benchmark
comparator (topic 33368, 2026-07-23), and v2 reproduced it: `valueArmScope` and
`indexedCredentialCount` appeared **only on a refusal payload** — so an install
whose value arm is a permanent structural no-op (`bitwarden`/`manual` backend, a
decrypt-failed store, a rebuild that fails every time) would surface exactly
nothing, because nothing refuses.

Therefore the wall reports its own posture unconditionally:

- `GET /decision-quality` (tone-gate row) carries `credentialWall`:
 `{ enabled, valueArmScope: 'config-only' | 'vault-unavailable' | 'isolated-matcher', indexedCredentialCount,
 lastIndexBuiltAt, indexDegradedSince | null, patternKinds: { wall, nudge } }`.
 Added to `DECISION_QUALITY_POINT_FIELDS` with the §3.7 fields.
- The wall registers with the guard-posture inventory (`GET /guards`) so a
 disabled or permanently-degraded wall grades as `off-runtime-divergent` rather
 than reading as healthy.
- **Scope note.**
 Fair, and answered by *reference rather than construction*: nothing below is a
 new workflow engine. The posture fields are additive fields on an existing
 route plus one guard registration; the escalation obligations are the
 constitution's existing **Self-Heal Before Notify** standard, whose required
 declarations are recorded here because the standard requires them to be
 declared per watcher — not because this spec builds the machinery. The heal
 step already exists (the index rebuild). If the shared `SelfHealGate` helper
 lands first, this feature adopts it; until then it declares against the
 standard directly, which is what every current watcher does.
- **Self-heal before notify.** The index rebuild (§3.2.1) *is* the self-heal
 step; it is idempotent (a rebuild fully replaces the previous index or is
 abandoned — never a partial merge) and already carries P19 brakes:
 `max-attempts` 3 per episode, `backoff` 30 s → 2 min → 10 min,
 `max-wall-clock` 30 min per episode, `dedupe-key`
 `b22-index-degraded:<machineId>`, `breaker` — 5 degrade→heal flaps inside 6 h
 auto-reclassify the episode to critical, a reclassification a `recoverable`
 label can never waive. Escalation is reachable **only** after
 `selfHealAttempted && selfHealExhausted`, with
 `max-notification-latency: 3600s` as the backstop that tells the operator even
 while heal is still running. `audit-location`:
 `logs/credential-wall.jsonl` — metadata only (counts, scope, timings, never a
 value, never a matched span). Severity `class`: `recoverable` (the pattern arm
 keeps running throughout; the degradation narrows reach, it does not expose
 anything).

### 3.2.1 The held-credential index

**Round-16 rewrite — this section got radically simpler by testing its own
premise.** Every version through v17 built a fingerprint index (keyed anchors,
buckets, a verification cap, retrieval handles, a matcher shoot-out, a rolling
fallback) whose entire purpose was to keep **plaintext credentials out of the
server's memory**. codex challenged the complexity five separate times; on the
fifth it proposed an isolated helper process as the primary design, and checking
the premise properly is what actually resolved it.

**The premise was false.** The server process *already* holds credentials in
plaintext for its whole lifetime: `authToken`, the Telegram bot token, tunnel
tokens and the dashboard PIN are ordinary fields of the loaded config object —
and `authToken` is a credential this spec deliberately widened the index to
cover, because a tunnel URL plus that token is full remote control of the agent.
So the elaborate machinery bought plaintext-avoidance for the *vault subset*
only, inside a process that was already a bag of credentials. That is not a
security boundary; it is a lot of bespoke code standing next to an open door.

**What is built instead:**

- A process-lifetime `HeldCredentialIndex` built **at server construction**,
 holding the credential values in memory in the three normalized forms (§3.2).
- **PR-A indexes ONLY credentials already resident in the loaded config.** `authToken`, the Telegram bot token, tunnel tokens and the other
 config leaves are in this process's heap whether or not this feature exists,
 so indexing them adds **no new credential VALUES** — though it does add
 derived *forms* of them, which is not the same claim; see below — and
 `authToken` is the
 highest-value one, since it plus the tunnel URL is full remote control of the
 agent. **Vault-derived credentials are NOT loaded in PR-A**; they wait for the
 isolated matcher process, which becomes a required deliverable rather than a
 threshold-triggered upgrade. This costs reach — a vault secret pasted into a
 message is caught by B23 as a shape rather than by B22 as possession — and buys
 most of the property the earlier design overclaimed. **Stated precisely:** the index introduces
 **no credential this process did not already hold**, but it is NOT true that
 it "expands plaintext residency by nothing at all", and that phrasing is
 withdrawn. §3.2's matcher keeps **three normalized forms per credential**, and
 a separator-stripped form is a byte sequence that did **not** previously exist
 anywhere in the process — so a memory scan for it would have found nothing
 before and finds a hit now. The accurate claim is: **no new secrets, but new
 derived representations of existing ones, in one purpose-built structure.**
 The exposure delta is therefore real if bounded — an attacker already needed
 arbitrary read of this process, and already had the originals. Recorded as a
 correction rather than smoothed, because "zero" was the load-bearing word in
 every prior round's security argument and it was wrong.
- Matching is `String.prototype.includes` per credential per form — native,
 and at the real bound (≤4,096-char candidate × ≤512 credentials × 3 forms
 ≈ 1,536 native substring scans) comfortably sub-millisecond. **No fingerprint,
 no anchors, no buckets, no salt, no verification cap, no cap-exhaustion hold,
 no retrieval handle, no matcher benchmark, no rolling fallback.** A CI perf
 test still pins the hot path at 5 ms so a future regression is caught.
- The ≥12-character floor on the most-reduced form, the placeholder/template
 exclusions, and the 512-entry bound all carry over unchanged.
- **Least privilege on what gets loaded.** "The process already
 holds some plaintext" justifies dropping the fingerprint scheme; it does **not**
 justify making every credential ambient for the process lifetime. The index is
 built from an explicit **key-class allowlist** — credential classes that could
 plausibly appear in an outbound message *and* whose exposure is irreversible
 (API tokens, bot tokens, the agent's own `authToken`, tunnel tokens, provider
 keys). Classes outside it are **not loaded at all**: notably anything used
 exclusively at rest or in a subprocess that has no path into message text.
 The allowlist is code-declared with a written reason per class, ratcheted, and
 its resolved size is reported as `indexedCredentialCount` on the posture
 surface — so ambient growth is visible rather than silent. Diagnostics posture:
 the index is excluded from every dump/health/diagnostic payload by a tested
 exclusion. **Hardening is a STARTUP POSTURE CHECK, not only build-time tests.** The
 server evaluates the list below at boot; anything that would expose process
 memory makes the credential wall report **`readiness: degraded`** on
 `GET /guards` with the offending condition named — **and the index refuses to
 expand plaintext residency while that holds**. On a failed check the index builds **only from credentials already
 resident in the loaded config** — which the process holds regardless, so the
 wall keeps its most important coverage (`authToken`, bot and tunnel tokens) —
 and **does not load the vault subset at all** until the condition clears. The
 wall degrades in reach rather than in safety, and says so. The checklist: core dumps disabled by
 default for the server process; `--heapsnapshot-signal` and inspector
 attachment not enabled in production launch args; no diagnostic route emitting
 process memory, heap statistics with object contents, or `process.env`; the
 launchd/systemd unit not configured to write crash reports containing memory;
 and the index object non-enumerable so an accidental `JSON.stringify` of a
 parent object cannot serialize it.
- Rebuild triggers carry over unchanged: a 10-minute soft TTL checked without
 blocking, explicit `invalidate()` on `SecretStore.set/delete`, the secret-drop
 consume path, `SecretSync` inbound receive, `/credentials/*` re-pointing, plus
 an `fs.statSync` mtime backstop. Rebuild is async, off the request path, 2 s
 deadline, previous index served while it runs.
- The index build MUST use a **read-only key path** — `getCandidateKeys()` can
 fall into `getFileKey()`, which *generates and writes* a master key when none
 exists. An empty-vault agent must not gain a generated key file as a side
 effect of sending a message.
- The index is **never persisted, never logged, never served, never replicated**,
 and is excluded from every dump/diagnostic surface by an explicit tested
 exclusion. It dies with the process.

**Accessibility is an exposure increase even when residency is not.** PR-A's index adds no *new* credentials to the heap, but it does create
**normalized duplicates in a purpose-built, searchable structure** — and "already
resident somewhere in a config object" is not the same as "sitting in an array
built for matching". A heap snapshot, an accidental traversal, or a diagnostic
that walks the wrong object finds them more easily than before. The config-only
choice stands, and the delta is stated rather than smoothed over: it is
**accessibility, not residency**, and it is one more reason the isolated matcher
is the destination rather than a luxury.

**Honest statement of what this costs, since it is a real reduction.**

The index holds **only credentials already resident in the loaded config**, so
it adds **no** plaintext that was not already in this process. The cost is
therefore **not residency but accessibility**: those values now sit in one
normalized, purpose-built structure rather than scattered through the config
object, so an attacker with a heap dump or arbitrary read of this process finds
them more readily than before — the same subset, more conveniently arranged.
Vault values are **out of scope for PR-A entirely** and are reached only by the
isolated matcher, which carries its own exposure analysis rather than
inheriting this one. **The upgrade path, with concrete triggers rather than "if that ever matters":** an isolated matcher process holding the plaintext and
answering a yes/no over a local socket. It is the **preferred future
architecture**, not a hypothetical, and it is taken when **any** of these fires:
indexed credential count exceeds 128; a startup hardening check fails on more
than one boot in a week; or any production crash-dump or heap-snapshot exposure
is observed. Each is a counter this feature already reports, so the trigger is a
threshold rather than a judgement call. It is deliberately *not* built now,
because it buys a boundary the process does not otherwise have and costs a
supervised lifecycle, and because pretending an in-process fingerprint scheme
achieved that boundary was the actual error.

### 3.3 Dissent-on-block — the data path that costs nothing

**This is the new first phase, and it is the round-1 reviewers' strongest
contribution.** The operator's goal is the *dataset*; lowering walls is one way
to get it, not the only way. Dissent-on-block obtains a byte-identical dataset
with **zero authority transfer**:

- A **blocking** rule citation returns 422 as today, plus a token (§3.5) and an
 invitation to file a dissent.
- **Terminal judgments return a DISSENT-ONLY token.** A B22
 refusal, and any other terminal judgment, returns a token whose record carries
 `dissentOnly: true`. **Seam-level verdicts only:** the
 adapter-layer detector returns no token at all — it has no agent-facing
 caller, so a token there would be a promise nothing can redeem; an
 adapter catch is a refusal plus a local audit event (table row 1d). At the
 seam, the token is the same opaque id in the same pending store, and it can be
 exchanged for **exactly one thing: a dissent annotation**. It can
 never authorize delivery, on any code path — a resend presenting a
 `dissentOnly` token with an ack is refused `dissentOnlyToken: true` and
 delivers nothing. That gives every judgment a join key without giving any wall
 an exit.
- The author may resend with `metadata.agentDissentReason`. The message **stays
 held**. The dissent is recorded through the identical annotation path
 (`grade: 'unknown'`, `evidenceStrength: 'self-report'`).
- **Dissent is available on every FALSE-POSITIVE-REPORTABLE VERDICT, and
 nowhere else**.
 A verdict is false-positive-reportable when the gate **reached a conclusion
 about this message** that could be wrong. That means every
 LLM rule citation, every B23 citation, **and B22 itself** — a wall the agent
 cannot pass is precisely the place where a false positive would otherwise be
 invisible, and a dissent there transfers no authority whatsoever (the message
 still does not go out), so it is pure evidence at zero risk. It is **not**
 available on availability holds or `detectorIncomplete`, because those are not
 judgments — there is no verdict to disagree with, only a check that could not
 run. Dissent works in every stage, including while the widening is dark and
 including on rules that never graduate. It is the *conclusion*, not the
 *reasoning style*, that makes a verdict reportable.

Consequences: the grading corpus starts filling the day this ships, independent
of the widening's rollout; and the per-rule graduation in §3.8 has real evidence
to graduate *on* instead of a flat flip.

### 3.4 Override with a mandatory reason

The advisory resend contract:

```
metadata.toneAdvisoryAck = "<the cited rule id>" (existing)
metadata.agentOverrideReason = "<the agent's reason>" (NEW, required)
metadata.advisoryToken = "<the token from the 422>" (NEW, required — §3.5)
```

**What `scrubForStore` guarantees.** It is the shared durable-scrub chokepoint in
`src/core/durableSecretScrub.ts`: it walks the closed `DURABLE_SECRET_PATTERNS`
set over the input and replaces each match with a typed
`[REDACTED:<kind>]` marker; it bounds input at 1 MB and replaces the **whole**
field with `[REDACTED:oversize]` rather than persisting bytes it could not fully
walk; and it reports `error`/`truncated` so a caller can tell "nothing found"
from "the scan did not complete". It is a *secret-shape* scrubber — it is **not**
an instruction-neutraliser and not an encoding-attack defence, which is exactly
why the reason additionally travels inside the instruction-inert untrusted-data
envelope (§3.6) rather than relying on the scrub for that property.

- The reason is **trimmed and scrubbed first** (`scrubForStore`), and the ≥12-char
 floor is applied to the *scrubbed* result — a reason that scrubs to
 `[REDACTED:…]` fails the floor rather than passing it. Clamp 500 (matching
 `EVIDENCE_NOTE_CLAMP`).
- A missing/blank/short reason returns the advisory again with
 `reasonRequired: true`; a reason that itself trips B22 returns
 `reasonRejected: true` and `refusedField: 'reason'`, delivers nothing, and
 writes no annotation. `refusedField: 'message' | 'reason'` is always present so
 the author revises the correct field.
- **Backward compatibility (breaking-change decision).** B21's ack-only contract
 is live and pinned by an integration test. The reason requirement is gated on
 `toneGate.advisoryOverride.enabled`: at Stage 0 B21 keeps ack-only (byte-
 identical); from Stage 1 the reason is required for **all** advisory rules
 including B21, and the existing B21 integration test is amended in the same
 change rather than left to fail.

**Who "the author" is, stated because it matters.** The author
is **the agent**, not the operator. So the mandatory reason is one component of
this system justifying itself to another, and it can absolutely become
self-serving boilerplate. That is not a flaw to be designed away here — it is
precisely why the reason is recorded at the **`self-report`** evidence rung,
graded `unknown`, never treated as proof the gate was wrong, and handed to a
**stronger, later, unhurried judge** rather than believed. A system that graded
its own homework would be worthless; one that files its homework for marking is
the point. The counter-measures in §3.8 measure the boilerplate rate rather than
trying to prevent it at admission.

**What the reason is not.** A 12-character floor prevents an empty ack; it does
not prevent boilerplate. The floor is deliberately a **presence** check that makes
no quality judgment — reason *quality* is the bulk judge's problem, not the
admission gate's, and an LLM sufficiency check at admission would re-introduce the
very authority this spec removes. The anti-rubber-stamp force lives in §3.8's
counter-measures, not in the floor.

### 3.5 The advisory token — binding, not text-matching

A candidate-hash-keyed map is unsafe: identical text to two topics (routine — short
acks, templates, the very repetition the dedup feature exists for) collides, and
the override joins to the *wrong* conversation's decision. It is also
caller-forgeable and pre-ackable: an agent could attach a blanket
`toneAdvisoryAck` to every send, never see a nudge, and fabricate the entire
disagreement record.

The 422 therefore returns a single-use **`advisoryToken`**: an **opaque
256-bit CSPRNG identifier** (base64url) that is the *key* to a server-side
pending record holding `{ correlationId, candidateSha256, rule, channel,
topicId, issuedAt, expiresAt }`. The resend MUST carry it. The seam looks it up, validates **every** resend field
first, and **consumes the record only once all validation passes** — a rejected
reason (`reasonRequired`, `reasonRejected`) or a binding-tuple mismatch leaves
the record intact so the author can fix only the reason and retry the *same*
approved message without paying a fresh review. The
record is consumed on the delivering path and on a recorded dissent, and nowhere
else. It takes the `correlationId` **from the record** — never from the request and never from a text lookup. This closes
pre-ack, replay, and join confusion in one move.

**Implementation note.** The record has enough states —
issued, consumed, expired, evicted, dissent-only — to be a small approval
workflow, so the store sits **behind an interface** (`issue` / `consume` /
`expire`) with the in-memory implementation as the only one built. If the
single-process invariant (§3.5) ever breaks, the durable approval table (§3.5.1)
becomes a second implementation of that interface rather than a rewrite of the
seam.

**Why an opaque id rather than an HMAC over concatenated fields.** A keyed MAC over `a ‖ b ‖ c` raises a canonical-encoding question —
delimiter injection, field-splitting ambiguity, length-prefixing, a nonce, key
rotation — every one of which is a way to get it subtly wrong. The pending store
already exists here (bounded, swept, single-use by construction), so the token
carries **no** attacker-usable structure and the binding lives in server memory
where it cannot be re-interpreted. Unguessable by size (256 bits), unforgeable
without the store, and there is no key to manage. A token whose record is absent
(expired, consumed, evicted, or issued by a different process/machine) is simply
`override-uncorrelated`.

- TTL **15 minutes** (longer than an agent turn, far shorter than any retention).
- **A pending record answers exactly `{producer, rule, detectorKind,
 candidateSha256}` — and consuming it additionally requires the resend's
 `channel`, `topicId` and `messageKind` to MATCH the record.**
 The record always stored those fields; v9 described the *check* as rule + hash
 only, which would let a token leak across caller contexts and authorize
 identical text into the wrong conversation — the exact join confusion the
 token replaced a hash map to prevent. A mismatch is `override-uncorrelated`,
 counted, and never a delivery.
 The tuple is also what "the acked citation is answered" means: That tuple is what "the acked citation is
 answered" means in Phase B, and it resolves the ordering question precisely:
 on an unedited resend, in the same conversation, the **same producer + same
 rule + same detector kind** is
 suppressed; **any other kind — including a different B23 kind — still holds**
 (subject to the B23 rule), with its own fresh token. So an ack for `labeled-secret` never answers a
 `jwt` hit that the index surfaced on the second pass, and B22 (row 1) is
 unaffected by any of it.
- **Architectural invariant.** The advisory-override protocol
 **requires exactly one active server process per agent home**, which the
 existing single-instance lock enforces today. This is written as an invariant,
 not an observation: if the deployment model ever gains workers, hot restart
 overlap, or a sidecar that serves routes, then the in-memory pending record is
 no longer sound and the durable approval record (§3.5.1) becomes **mandatory
 before the feature may be enabled**. The invariant is asserted at startup — the
 feature refuses to resolve live if it ever detects a second server on the same
 home — so a future architecture change cannot silently degrade overrides into
 confusing fresh reviews.
- **Restart and multi-process semantics, stated.**
 Pending records are in-memory and die with the process. A resend carrying a
 token whose record is gone is **not** an error the author has to understand: it
 falls through to a **fresh review**, which re-cites the rule and issues a new
 token, so the author pays one extra round trip and **no message is lost**. The
 response says so explicitly — `tokenExpiredFreshReview: true` — and the case is
 counted separately from an ordinary first-pass advisory. **If that fresh review
 passes, the message DELIVERS** — intended, and stated because it is otherwise
 surprising: the author asked to override a verdict that no longer exists, and
 the current verdict is "fine". The helper says exactly that ("your token had
 expired; the message was re-reviewed and passed, so it was sent — the earlier
 disagreement was recorded but could not be joined"), so the author is never
 left guessing whether their reason counted.
 **What that record IS, named once.** This prose and row 22
 described the same thing in two different vocabularies — "recorded but could
 not be joined" here, "unjoined + unjudgeable machine-local attempt" there —
 which left its audit status genuinely ambiguous. Pinned: exactly ONE event,
 **`expired-token-override-attempt`**, written to the **machine-local**
 operational log and nowhere else. It is **telemetry, NOT evidence**: it never
 enters the graded corpus, is never joined to a decision, and is never counted
 as an override. It exists so the rate of expired-token attempts is visible
 (a rising rate means the token window is too short), and for no other purpose.
 The helper text above is a user-facing paraphrase of this event, not a second
 record.. That
 is the whole cost, and it is why persisting the records is not worth a durable
 store. Worker affinity is a non-issue by construction — the agent runs a single
 server process per agent home, enforced by the existing single-instance lock —
 and a token presented to a *different machine* already resolves to
 `override-uncorrelated` (§6).
- Pending-token store: bounded at 512 entries, insert-triggered sweep (no
 `setInterval`), oldest-first eviction with a counted `advisory-join-evicted`.
- An absent/expired/mismatched token ⇒ `override-uncorrelated`, counted, **never**
 a join on text alone.

**The resend skips the LLM review — and ONLY the LLM review (G7).** On a valid
token whose `rule` matches the ack and whose `candidateSha256` matches the resent
text, the seam skips `MessagingToneGate.review()` and annotates against the
record's `correlationId`. **The deterministic layers still run on every resend**:
the localhost-link guard, the 4096-length check, and the B22/B23 credential
detector are re-evaluated against the resent text before delivery. This is
stated explicitly because the short-circuit is otherwise a path that reaches the
adapter having consulted *no* check at all, and because the credential index is
rebuildable — an arm that was `unavailable` when the 422 was issued may be
`local` seconds later, and the wall must get that second chance. A B22 match on
a resend refuses terminally regardless of any ack or token (an advisory ack for
one rule can never launder a different rule's wall). This removes the second
gating LLM call, the doubled 20 s budget, the second spawn-cap acquisition, the
phantom second decision row, and the nondeterministic rule-churn loop. An **edited**
message fails the `candidateSha256` check and correctly receives a full fresh
review. A hard cap of **2 review passes per candidate** backstops it, with a
counted `advisory-review-loop-clamped`.

**Resend-until-pass is measured, not ignored.** A plain resend (no ack) within the
token TTL whose text hash matches a live pending record is recorded as
`advisory-evaded-by-resend` — otherwise the honest agent who acks is measured and
the one who re-rolls the stochastic gate is not, biasing the corpus toward
"overrides come with good reasons".

**Its residual, stated rather than implied:** the measure keys on an exact text
hash, so a one-character edit produces a fresh review and is invisible to it.
The counter therefore measures *lazy* re-rolling, not determined re-rolling, and
is a lower bound. A near-duplicate detector here would be the same brittle
authority §3.8 removes from the reason path, so the honest lower bound is the
right trade — but the number must be read as one, and the read surface labels it
`advisory-evaded-by-resend (exact-text only; lower bound)`.

### 3.5.1 Alternative considered — a durable approval/outbox table

Round-10 (codex) asked why this is not the industry pattern: a durable outbound
approval record with explicit state transitions, audit rows, TTL and idempotent
resend handling. Recorded here because "we already keep durable evidence
elsewhere, so why is *this* in memory" is a fair question with a specific answer.

| Axis | Durable outbox table | In-memory pending record (chosen) |
|---|---|---|
| What it protects | The **message** — a draft survives a crash and can be resumed | The **join** — which decision an override answers |
| Cost of losing it | The message would need re-composing | One extra round trip; the message is re-reviewed and a new token issued (§3.5) |
| Lifetime needed | Long — an approval may sit for hours | **Minutes** — it exists between a 422 and its immediate resend, inside one agent turn |
| New failure surface | A durable store to migrate, sweep, corrupt, replicate, and reason about across machines | None — dies with the process, by design |

The decision turns on the second row. The evidence this feature is built to
preserve is the **annotation**, and that *is* durable — it goes through the
existing provenance chokepoint, with the reason text in its own retained store
(§3.6). The token is not evidence; it is a short-lived pointer that exists so
the annotation attaches to the right decision. Making a minutes-long pointer
durable buys one avoided round trip and pays for it with a cross-machine
consistency problem (§6) and another store to sweep.

**An operational trigger with declared numbers.**
Two counters decide whether the in-memory choice is still right in practice:
`tokenExpiredFreshReview` and `advisory-join-evicted`. The ceilings are stated
rather than left as "a band": **more than 5% of overrides expiring, or more than
20 join-evictions, in any rolling week**. Crossing either requires durable
approval storage **before Stage 2** — not Stage 3, because the relay helper makes
restart-spanning turns plausible long before fleet rollout — because the failure it produces (an override that
silently became a fresh review) is confusing rather than loud, and the relay
helper makes restart-spanning turns more likely than the single-turn model this
section assumed.

**The condition under which this flips**, stated so a future reader can check
it: if overrides ever become *asynchronous* — a human or another agent approving
a held message minutes or hours later, rather than the composing agent resending
inside its own turn — then the pointer's lifetime stops being minutes, and the
durable outbox becomes the correct design. Nothing in this spec creates that
case; the §3.11 record is what a later judge reads, and it needs no live token.

### 3.6 Recording the disagreement

On a valid override *or* dissent, the seam calls the §5.4 annotate chokepoint once:

| field | value |
|---|---|
| `correlationId` | from the consumed token |
| `ruleId` | `tone-gate-agent-override-v1` (override) / `tone-gate-agent-dissent-v1` (dissent) |
| `gradedBy.component` | `OutboundGateOverride` |
| `grade` | `unknown` |
| `decisionPoint` | `messaging-tone-gate` |
| `evidence` | `{ citedRule, dispositionAtDecision, reasonLength, reasonHmac, candidateSha256, bodyCaptured, overrideAt }` |
| `evidenceNote` | **omitted — see containment below** |

Registry rows (both):

```
rung: 'self-report' // NOT 'agent-attested' — EVIDENCE_RUNGS is a closed set
evidenceStrength: 'self-report'
owningComponent: 'OutboundGateOverride'
windowMs: DECISION_POINT_EVIDENCE_WINDOW_MS // 6h, matching the point's other rules
```

`grade: 'unknown'` is deliberate and load-bearing. An override is the agent
disagreeing — not proof the gate was wrong. The agent is exactly as capable of
being wrong as the gate is, which is the entire reason both are being measured.
Recording an override as `wrong` would let the agent grade its own homework.

**Reason containment (corrects a factual error in v1).** v1 claimed the reason
"is not HTTP-served". That was **wrong**: `annotateOutcome` passes
`{...evidence, note: evidenceNote }` into `jpl.annotateOutcome`, which writes it
as `outcome`; `readRedacted()` strips only `contextFull`; and `outcome` is on
`REDACTED_PROVENANCE_FIELDS`, so it is returned by `GET /judgment-provenance`
**and replicated to every peer on `?scope=pool`**. The content class is the worst
case — the reason is free text *about a message flagged for leakage*, so the
most likely reason restates the flagged artifact.

Therefore the reason text is **not** passed as `evidenceNote`/`note` at all. The
served evidence carries `reasonHmac` (machine-local key — an unsalted sha256 over
short templated reasons is a cross-machine equality oracle) and `reasonLength`
only. The reason **text** lives in the **override-event log itself** (§3.8) —
one source of truth, not a second store. The log **is** the store, and
**no route reads it**.
An integration test asserts `GET /judgment-provenance` returns no override-reason
text at either scope.

**Override-event-log lifecycle:**

| Property | Contract |
|---|---|
| Path | `state/override-events/<yyyy-mm-dd>.jsonl` — the override-event log (§3.8), carrying the reason text on the `authorized` event. Directory mode `0700`, files `0600`, owned by the server process user. |
| Format | One JSON object per line, using the **canonical `authorized` event schema defined in §3.8** — not restated here. `reasonText` is scrubbed by `scrubForStore` and wrapped in the untrusted-data envelope at write time, so no reader can forget to wrap it. Privacy, permission and retention properties are defined **here, once**; the field list **there, once**. |
| Crash consistency | Append-only with `O_APPEND` single-writer + `fsync` on close; a torn final line is skipped by the reader and counted (`reason-store-torn-line`) — never repaired in place, never a parse abort. |
| Rotation | Daily file boundary; no rewriting of a closed file. |
| Retention | Deleted by a sweep when the correlated provenance outcome is past *its* retention (14 days), so the text can never outlive the record it explains, and can never be deleted while the record still cites it. The sweep logs counts only. |
| Backup | **Excluded** from the git-backup path and from any archive surface, by an explicit path exclusion with a test asserting the exclusion holds. |
| Access | No HTTP route reads it, at any scope. Read access is a local file read by the future bulk-judge process running on the same machine, which joins on `correlationId`; that ingestion contract is defined by ACT-1198 and is deliberately **not** built here. |
| Audit | Reads by the judge append a metadata-only line (`who`, `count`, `at`) to `logs/credential-wall.jsonl`'s sibling `logs/override-reason-access.jsonl`. |

**`reasonHmac` key lifecycle.** The key is generated once by
the server at first use via CSPRNG and stored at `state/reason-hmac.key`
(mode `0600`, never replicated, never served, excluded from backup on the same
path exclusion as the reason store). Its *only* job is equality-grouping of
reasons **within one machine** — it is not an authenticator and nothing verifies
against it. Rotation therefore has one consequence: hashes minted after the
rotation no longer group with hashes minted before it. Since the grouping is only
meaningful inside the outcome-retention window (14 days), the key is **not
rotated on a schedule** — rotating it would silently split a live corpus for no
security gain. It is regenerated only if the file is missing or unreadable, and
that event is counted (`reason-hmac-key-regenerated`) so a reader can tell a
genuine "these reasons differ" from an artefact of a key change.

**Untrusted-data envelope (required).** The reason is agent-authored free text,
produced right after the agent read attacker-influenceable inbound content, and
its sole consumer is a strong model deciding whether the agent was right.
FENCE/instruction-inert quoting is one of ACT-1198's own named preconditions. So:
the reason is stored and rendered inside an explicit instruction-inert
untrusted-data envelope (the `<replicated-untrusted-data>` precedent), the
bulk-judge contract treats reason text as **data, never instruction**, and a
reason alone can never determine a grade — the judge must receive candidate +
gate reasoning + reason together, or nothing.

**A body-less override is marked unjudgeable.** `recordCandidateBody` is opt-in
and OFF today. Without the body, the durable artifact is the agent's prose and the
thing it justified is absent — a judge could only grade rhetoric. The annotation
therefore carries `bodyCaptured: boolean`, and an override recorded without a
captured, non-budget-dropped body is counted `override-unjudgeable` and surfaced.
Overrides are additionally **budget-reserved** so an override-carrying provenance
row cannot be dropped by the point's `budget:500`/day valve while its parent's was
written; `overrideBudgetDropped` is surfaced and raises one deduped Attention item
when non-zero.

### 3.7 Read surface

`GET /decision-quality` gains two fields on the tone-gate row: `overrides` and
`overrideRate`, where **`overrideRate = overrides ÷ advisory-citations-in-window`**
(per rule; an all-decisions denominator reads ~0 forever and would never trip
anything). Both are added to `DECISION_QUALITY_POINT_FIELDS` — the pool-merge
allowlist — or peer counts read as *absent* rather than zero. `recordingLive`
(§3.8) is surfaced alongside. Reason text is never served.

### 3.8 Coupling, counter-measures, and rollout

**The trade must be enforced in code, not prose.** The annotate seam resolves
through `resolveDevAgentGate(provenance.uniformSeam.enabled)` with `dryRun`
defaulting **true** — so without coupling, the agent could gain override power
while the recording writes nothing. Therefore: `toneGate.advisoryOverride`
resolves **false unless the annotate seam resolves `enabled && !dryRun`**. If the
annotate seam goes dark while advisory is live, the affected rules revert to
`blocking` (fail-safe), and `recordingLive` reports it.

**`recordingLive` is a CONFIGURATION predicate, not a per-write guarantee.** v3 said both "advisory resolves false unless recording is live" and
"an annotate failure never blocks delivery", which read together implied a
message could deliver under an override while its record silently failed. Both
halves are kept, and the seam between them is named:

- `recordingLive` answers *"is the recording path enabled and non-dry-run?"* —
 checked before the advisory disposition is granted at all.
- **One append-only override-event log, with explicit states — replacing the
 ad-hoc coordination of several stores.** Two real
 defects were found together: (a) the write-ahead record was written *before*
 delivery, but the adapter-layer B22 can still refuse at egress and the network
 can still fail — so the corpus could contain records asserting an override
 delivered when nothing left the machine; and (b) the token store, write-ahead
 stub, reason text, provenance annotation, commitment row and adapter audit had
 **no atomicity model at all**, so a crash mid-sequence leaves them disagreeing
 with no defined reconciliation.

 Both are answered by the same simplification: the override lifecycle is
 recorded as **events appended to a single local log**, never as coordinated
 writes across stores.

**The `authorized` event's canonical schema — one write, everything on it:**
`{ correlationId, producer, citedRule, detectorKind, channel, topicId,
messageKind, disposition, authorAction, reasonHmac, reasonText (scrubbed),
candidateSha256, at }`. Both the join fields and the scrubbed reason text ride
the same append; there is no second write and therefore no second failure mode.

| Event | When | Meaning |
|---|---|---|
| `authorized` | after all resend validation passes, **before** the send is attempted | the override was granted; nothing has been sent |
| `sent` | after the adapter reports success | the message actually left the machine |
| `egress-refused` | the adapter-layer B22 refused at the send primitive | authorized, then correctly stopped at egress |
| `send-failed` | the send threw or timed out | authorized, attempted, not delivered |


 **The projector, specified.** Provenance rows are produced by
 an **idempotent projector** keyed on `correlationId`: it runs immediately after
 the terminal event, and again at startup over any record whose projection is
 missing. Until a record is projected the read surfaces show it as
 `pending-projection` rather than omitting it — an unprojected override must
 never read as an override that did not happen. Re-projection is a no-op, so a
 crash between the terminal event and projection repairs itself at the next boot
 without duplicates.
 A record with `authorized` and no terminal event is **incomplete, not
 delivered** — the reader treats it as unknown, and a startup reconciliation
 pass marks any such record `send-outcome-unknown` rather than guessing. The
 judgeable corpus counts only records with a terminal event, so **"the override
 was granted" and "the message was delivered" are never conflated**. The reason
 text and the provenance annotation are derived from this log rather than
 written independently, which removes the cross-store atomicity question
 instead of answering it.

- **The `authorized` event is WRITE-AHEAD and durable, or the override is not
 admitted.** v24 let a
 per-call annotate failure deliver while counting `override-unrecorded`. But the
 trade this spec rests on is *authority in exchange for evidence*: if the agent
 gets the authority and the corpus gets nothing, the trade did not happen — and
 the resulting rate understates overrides in exactly the direction that flatters
 the agent. So before delivery, the **`authorized` event** — the canonical schema above, carrying the join
 fields *and* the scrubbed reason text — is appended to the override-event log
 with `fsync`. It is small, it
 does not depend on the provenance seam, and if **it**
 cannot be written the override is **refused** (`overrideUnrecordable: true`)
 rather than granted.
- **`overrideUnrecordable` is an AVAILABILITY hold, and must be surfaced as one.**
 Naming it is not enough: while it holds, a rule that is advisory by design
 behaves as a wall, so an ordinary local fault (disk full, a permission change,
 a read-only mount) silently acquires authority the design deliberately refused
 to give any judgment rule. Required posture, all three:
 (a) it is classified an availability/security hold alongside
 `CAPACITY_UNAVAILABLE` and `GATE_UNAVAILABLE` in §3.1 — *not* a judgment, since
 nothing about the message was concluded;
 (b) the FIRST occurrence raises ONE deduped operator notice naming the cause
 (write failure, not "your message was refused"), because an agent silently
 unable to override is exactly the state nobody notices;
 (c) recovery is automatic and requires no operator action once the write
 succeeds again — the hold is a function of live writability, never a latched
 flag, so a freed disk restores advisory behaviour on the next send.
 Without (b) this is the failure the whole spec is against: an unappealable
 refusal, with no one told.
- The **rich** provenance annotation may still fail afterwards; that failure
 delivers and is counted `override-unrecorded`, because the override *fact* is
 already durable and only the detail is missing. Making the rich write a
 delivery gate would make observability a delivery gate, which §3.9 forbids — a
 full disk must not silence the agent. The write-ahead record is the line
 between "we lost detail" and "we lost the fact".
- The residual is therefore **bounded and measured, not assumed zero**:
 `override-unrecorded` is surfaced on the read surface beside `overrides`, and
 crossing a rate band raises ONE deduped Attention item. A corpus that quietly
 lost overrides would misstate the very rate the Stage-3 decision reads.

**Anti-rubber-stamp counter-measures (all structural):**
1. A reason that is a near-duplicate (normalized trigram similarity) of the last
 N reasons for that rule on that topic is **counted and surfaced**
 (`reasonRepeatRate` per rule, plus one deduped Attention item when it crosses
 a band) — it is **NOT refused**. The last-N buffer is bounded at 32 reasons per rule
 across at most 256 recently-active topics, LRU-evicted, in memory only.
2. Per-rule rolling override rate with a declared expected band; crossing it
 raises ONE deduped Attention item naming the rule.
3. **Per-rule fail-safe circuit — with the dormant-grading trap closed.** The
 intent: a sustained override rate above threshold with **zero graded
 outcomes** should restore that rule to `blocking`. But G8 says the
 `llm-interpreter` rung is dormant, so "zero graded outcomes" is
 **unconditionally true for every rule today** — v2's circuit would therefore
 fire on rate alone and revert permanently, since the condition that clears it
 cannot be met. A restoring force that can only ever ratchet one way is not a
 safety measure, it is a slow rollback of the operator's decision. So:
 - **While no non-`self-report` grading rung is registered on
 `messaging-tone-gate`** (the G8 state), crossing the threshold raises ONE
 deduped Attention item naming the rule, the rate, and the fact that grading
 is dormant — and **does not** revert.
 - **Once such a rung exists**, the circuit reverts the rule to `blocking` as
 designed, and a subsequent grade clears it automatically.
 - In **both** states the revert/hold is operator-clearable from the Attention
 item, and every transition is audited. The builder never leaves a rule in a
 state only a code change can exit.

**B23 and automated senders — corrected by the round-15 sweep.** v16 said a B23
citation on an automated message is "a hard stop in practice", because a
non-ack-capable caller degraded to a terminal block. Under the B23 rule that is
no longer true and no longer acceptable: an automated sender that cannot
acknowledge gets **observe-only**, so B23 never silently kills an automated
message. What follows therefore describes how such a sender *gains* the hold —
by adopting the shared helper — not how it survives one. That is now the whole pattern arm, so it
matters more after round 11's narrowing than before it: an automated template
containing a placeholder like `postgres://user:password@host` would be blocked
with no path forward for that sender. Three things, in order of preference:
(1) the shared protocol helper (below) is exactly what an automated sender
adopts to gain the path — it is not interactive-only by nature, only by initial
opt-in; (2) until a sender adopts it, **automated templates must not emit
credential-shaped examples** — a constraint that is cheap to honour and is
checked by the burst-invariant style template tests; **Per-sender-class policy for no-recourse egress.** "Observe-only where recourse
does not exist" rests on *the author being the only judge available*. That is
true for an interactive send. It is **false** for a system template, a relay, or
an automated health message, where there may be no author in the loop at all —
so for those senders the rule silently resolves to "deliver, and count it".
Today that is also what happens (no credential-shaped check exists on those
paths), so it is not a regression — but it should be the operator's call, not a
side effect of a rule written for interactive sends. So each sender class
carries a policy: **`observe`** (default — status quo plus a metric),
or **`fail-closed`** (the message is held; there is no author to answer, and the
operator has decided silence is preferable for this sender). `approval-queue`
is named as the third value and **not implemented** — see immediately below.
The classes are a **closed, code-declared map**:

| Sender class | Default | Why |
|---|---|---|
| `interactive` (telegram / slack reply paths) | n/a — has recourse | The author is present; the normal advisory path applies. |
| `relay` (composed elsewhere, relayed on) | **`observe`** | Round-25 correction — see below. |
| `system-template` (fixed-template notices) | **`observe`** | Round-25 correction — the template concern moved to build time, where it belongs. |
| `automated-job` (health alerts, reap notices, digests) | **`observe`** | Timeliness is the value, a hit is far more likely a placeholder than a credential, and the status quo has no check at all. |
| `lifeline-fallback` | **`observe`** | Reachability is this path's entire purpose — it must never become the thing that silences the agent. |

**Every default is `observe`; `fail-closed` is opt-in only.**
v28 defaulted `relay` and `system-template` to `fail-closed`, which meant the
**default** behaviour still contained unanswerable holds — relocated from rule
semantics to sender policy, but no more answerable for that. Relocation is not
resolution. So no class ships fail-closed; an operator who wants it opts in
explicitly, per class, and the opt-in is visible on the posture surface.

The `system-template` case that motivated the stronger default is real — a
credential-shaped string in a code-authored template is a bug — but a **runtime
hold is the wrong instrument for a code-authored artifact**. It is caught at
**build time** instead, by the template test in §3.10, which fails CI if a
shipped template emits credential-shaped text. A bug in code should be a build
failure; a runtime hold nobody can answer is a silence.

Operator-overridable per class in config; the resolved policy for every class is
on the posture surface so it is readable rather than inferred; one test per class
asserts its default is `observe`.

**An approval queue for no-recourse senders, considered and rejected.** The alternative to observe-only is to hold the message in a
durable outbox, notify someone, and release it through the same recorded-reason
path. It is a real pattern and it is rejected here for three reasons, stated so
it can be revisited on evidence rather than taste: it makes a **new durable
store plus a notification path** a precondition of PR-A, when the whole point of
PR-A is to start collecting evidence quickly; it converts a *recoverable*
class into a **delivery-latency** problem for automated senders whose value is
timeliness (health alerts, reap notices); and the population it protects is
credential-*shaped* text from senders that today have no credential check at
all — so observe-only is already strictly better than the status quo, while a
queue would be strictly worse on latency. **The re-evaluation trigger:** if
`b23-would-hold` on non-capable senders shows real credential-shaped traffic
rather than placeholders, the queue is the right next step and this paragraph is
the record of why it was not the first one.
(3) the `b23-would-hold` counter makes any sender that trips this **visible**
rather than mysteriously silent — `advisory-degraded-to-block` is reserved for
pre-existing LLM rules, which had a block to degrade *to*; B23 never did. No allowlist: a template-fixture allowlist would be a bypass keyed
on caller identity, and those rot into the default path.

**The widening's EFFECTIVE reach, stated honestly.**
"All twenty-one rules become advisory" describes the disposition table, not the
behaviour change. Because non-ack-capable callers degrade an advisory citation
back to a terminal block (below), and because B11 (`style`) and B12–B14
(`health-alert`) are cited almost exclusively against **automated** senders that
are not ack-capable, those four rules are advisory *on paper* and blocking *in
practice* until an automated sender learns the protocol. The rules whose
behaviour actually changes at Stage 2 are B1–B9, B15–B21 on the two interactive
routes. The `advisory-degraded-to-block` counter is broken out **per rule** so
this gap is measured rather than assumed, and a rule whose entire volume lands
in that counter is reported as `advisory-inert` on the read surface.

**Non-agent callers (G6).** `evaluateOutbound` takes `advisoryCapable?: boolean`,
default **false**. A citation of an advisory rule from a non-capable caller
resolves to the existing terminal `tone-gate-blocked` — never a 422 advertising a
path the caller cannot take — and is counted under `advisory-degraded-to-block`
so the resulting dataset bias is measurable rather than invisible. Only the
interactive `/telegram/reply` and Slack paths opt in initially. A
`tone-gate-advisory` 422 is explicitly **non-retryable** and excluded from
`DeliveryRetryManager`'s retry classification (a retrier would otherwise pay a
fresh 20 s-budgeted gating call per attempt, forever, for an unchanging verdict).

**The relay scripts learn the protocol through ONE shared helper (G5; round-9,
codex — four shell scripts each hand-parsing 422 variants is drift by
construction, and the protocol is the one thing that must be identical
everywhere).** A single installed helper — `.instar/scripts/tone-protocol.mjs` —
owns 422-body discrimination (`tone-gate-advisory` vs `tone-gate-blocked` vs an
availability hold vs a dissent-only terminal), the exit-code-per-class mapping,
and the resend construction (ack + reason + token + the binding tuple). Every
relay script (`telegram`, `slack`, `whatsapp`, `imessage`) **delegates** to it
and gains a `--tone-override "<reason>"` / `--tone-dissent "<reason>"` flag;
none of them parses the protocol itself. A unit test drives the helper directly
so the protocol has test coverage independent of any channel. Without this the feature is inert on the agent's mandated send path. **Migration parity, named per artifact.** Every agent-installed file this change
touches gets an explicit entry in `PostUpdateMigrator`, each idempotent:

| Artifact | Migration | Note |
|---|---|---|
| `.instar/scripts/tone-protocol.mjs` (NEW shared helper) | `migrateScripts` — **always overwrite**, like built-in hooks | A stale copy of the protocol is exactly the drift the shared helper exists to prevent; install-if-missing would strand existing agents on the old behaviour (the `hook-event-reporter.js` lesson) |
| `telegram-reply.sh`, `slack-reply.sh`, `whatsapp-reply.sh`, `imessage-reply.sh` | `migrateScripts` | Rewritten to delegate to the helper; content-sniffed so a customized script is not clobbered silently but is reported |
| CLAUDE.md template (the override/dissent protocol) | `migrateClaudeMd` | Content-sniffing guard, per the standard |
| `toneGate.*` config defaults (`recordDecisionContext`, sender-class policy, `credentialWall.emergencyDisable`) | `migrateConfig` | Existence checks only — never overwrite an operator's value |

A migration test asserts each entry is present and idempotent, because a feature
that only works for new agents is a broken feature. v1's "no hook or CLAUDE.md template change is
required" was wrong and is reversed.

**Config path (critical correction).** v1's `messaging.outboundGate.advisoryOverride`
is **structurally unreachable** — `InstarConfig.messaging` is an *array*, a fact
`MessagingToneGate.ts` documents as the cause of the 2026-07-24 candidate-body
wiring gap, and which `scripts/lint-no-unreachable-messaging-gate.js` already
fails in CI. The flag is top-level **`toneGate.advisoryOverride: { enabled, dryRun }`**,
resolved through `resolveToneGateOperatorConfig()` — **whose knob whitelist must be
extended in the same change** (that resolver's docstring names "whitelisted only
three of the four knobs" as the cause of the same 2026-07-24 gap).

**The build lands as TWO sequenced PRs against this one spec.** The
objection is about implementation drift, not about the design, and the honest
answer is a build-sequencing commitment rather than more prose:

- **PR-A — the wall and the data path.** B22/B23 detection (both layers), the
 live-credential index, dissent-on-block with dissent-only tokens, the
 judgeable-record completeness capture, and the posture surface. This is
 Stage 0: it ships the irreversible-exposure protection and **starts the
 grading corpus filling on day one**, with zero authority transferred.
- **PR-B — the widening.** Advisory dispositions, the override protocol with
 reasons and tokens, the relay-script protocol, the capability plumbing, and the
 counter-measures. Ships dark (Stage 1), then dry-run, then live on the
 development agent.

The normative table (§3.8.1) is the shared contract both PRs are tested against.
**Complete row ownership**:

| PR | Rows |
|---|---|
| **PR-A** — detection, dissent, capture | 1a, 1d, 2, 2a, 3, 4, 5, 6, 7, 8, 8a, 8b, 20, 20a, 21, 23, 23a |
| **PR-B** — widening + override protocol | 3a, 8c, 9, 10, 11, 12, 13, 13a, 14, 15, 16, 17, 18, 18a, 18b, 18c, 18d, 19, 22 |

Every row is owned by exactly one PR, and the partition test **parses the table**
rather than comparing against a hand-written list — it asserts the union of the
two sets equals the row ids actually present and the intersection is empty.
 Splitting the *spec* was
considered and rejected — the two halves share one seam, one detector, one
record shape and one table, and two specs would have to restate all of it and
then drift. Splitting the *build* gets the drift protection the reviewer is
asking for while keeping one reviewed contract.

**Stages:**

- **Stage 0 (ship state).** Advisory widening `enabled: false`. **Dissent-on-block
 is live** — data starts immediately. B22 ships **ON**, with its emergency
 lever. It enforces from day one because it is **proven possession verified by
 exact comparison** — not matcher inference — which is also why round 11's
 narrowing (§3.2) removed the shadow-mode staging round 9 had added: that
 staging existed only to let an *inferring* arm earn wall authority, and no
 inferring arm holds wall authority any more.

 **THE B23 RULE.** B23 is **advisory
 wherever the author has recourse**. Where recourse does not exist, the rule no
 longer decides on its own — **the sender class's policy does**: `observe` (the
 default, and the original rule's answer) or `fail-closed`.

 *That correction matters and is not cosmetic.* Round 22 gave `relay` and
 `system-template` a `fail-closed` default, which creates **deliberate
 unanswerable holds** — and I went on quoting "B23 never holds without recourse"
 as an absolute for two more rounds while the document contradicted it (codex
 found it; the hand-check did not, because it compares rows to rows and this was
 a principle contradicting a table). The honest form is: **an unanswerable hold
 is never created by the rule, only by an operator's explicit policy for a
 sender that has no author in the loop** — and the default for every class is
 the answer the rule would have given. Recourse means
 the override protocol is reachable: the advisory machinery is enabled
 (Stage ≥1), recording is live, and the caller can carry an acknowledgement.
 Where it is not reachable, **the reason it is not reachable decides**:

 - **Temporally absent** — Stage 0, or recording dark, or the advisory flag off.
 The absence is a rollout state, the same for every sender, and the operator
 has not been asked about it. ⇒ **observe-only** (rows 3, 4).
 - **Structurally absent** — the caller can *never* carry an acknowledgement
 (a relay, a system template, a job, the lifeline path). This is a permanent
 property of that sender, so it is a policy question the operator can
 meaningfully answer. ⇒ **the sender-class map decides** (rows 5, 8b, 23a).
 This single rule replaces what had been four separately-argued cases —
 Stage 0, the adapter layer, the protocol-skipped paths, and a caller that
 cannot acknowledge. Each was answered the same way after the reviewers found
 it, one at a time; stating it as a rule is what stops a fifth case being
 discovered later. **A new deterministic hold with no way to answer it is never
 created by this rule** — not because it is temporary, and not because the
 caller is a script. Where one exists at all, it exists because an operator
 chose `fail-closed` for a sender that has no author in the loop, and that
 choice is theirs, visible on the posture surface, and reversible.

 Applied to Stage 0: v13 had B23 holding terminally at Stage 0 because
 the override machinery ships in PR-B; v14 called that an honest delta. Codex's
 objection lands: a terminal hold on a regex, even temporarily, **is** the
 brittle-signal-with-blocking-authority pattern this spec exists to remove — an
 honest label does not make it acceptable. So at Stage 0, B23 **records a
 would-hold and blocks nothing**. That is not a safety regression: there is no
 credential-shaped check on this path today, so observe-only is exactly current
 behaviour plus data. B23 starts holding at **Stage 2** — the first stage where
 recording is live and the override that makes a hold answerable is actually
 reachable. **Authority and
 recourse arrive together, or neither does.** B22 still enforces from Stage 0,
 because possession is proven and its recourse (dissent) does not depend on
 PR-B. Honest delta:
 this is *not* byte-identical — B22 can newly refuse a message. The delta is
 exactly "a message carrying a live credential is refused", and B22 false
 positives are monitored with a named rollback (the emergency lever).
- **Stage 1.** `enabled: true, dryRun: true` — widened dispositions computed and
 logged as `would-advise`; blocking-today rules still block. An unresolvable flag
 resolves to **blocking**, never advisory.
- **Stage 2.** Live on the development agent.
- **Stage 3 (fleet).** **The operator's decision, never the builder's**, and gated
 on two conditions: (a) measured Stage-2 evidence — override rate inside the
 declared band over ≥7 days with a reason-quality sample reviewed; and (b) **G8**
 — ACT-1198's preconditions landed and at least one `RULE_REGISTRY` rule on
 `messaging-tone-gate` whose rung is **not** `self-report`. Until (b), the
 widening is authority-loosening with no compensating measurement, and this spec
 says so plainly.

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

**The same ordering as illustrative pseudocode — NOT authority.**
**
The table below is the authority on every individual *outcome* **and on the
order they are consulted in**. **The test plan (§3.10) derives its cases from
the table**, not from this sketch
— a reviewer noted that "the table wins" resolves prose-vs-table conflicts but
does nothing for an implementer misreading precedence across rows 8/8a/8b,
13/13a, 15/22 and 18/18a/18c/18d. If this pseudocode and the table ever
disagree, that is a defect in one of them, not a choice.

```
evaluate(request):
 # Phase A — deterministic wall. Runs on EVERY request, resends included.
 # Nothing downstream can waive a Phase A outcome.
 if b22_matches(request): return REFUSE_TERMINAL # rows 1a / 1d
 if b22_threw(request): return HOLD_DETECTOR_INCOMPLETE # row 2
 # NOTE: a missing or stale index is NOT a hold — it narrows the wall's
 # reach and is surfaced. See row 2a; holding every message because a
 # vault is unreadable is worse than the exposure it prevents.

 # Phase A ALSO evaluates the deterministic ADVISORY detector, every time.
 #
 current = b23_findings(request) # set, possibly empty; each a tuple
 # {producer, rule, detectorKind,
 # candidateSha256} per §3.5

 # Phase B — override resolution. Only when a token is presented.
 if token_presented(request):
 # Consuming a token needs MORE than the answering tuple: §3.5 additionally
 # requires channel + topicId + messageKind to match the record, or the
 # token could authorize identical text into the wrong conversation.
 # A record that is absent/expired/consumed/evicted, or a context mismatch,
 # is `override-uncorrelated` — counted, never a delivery.
 #
 if not token_record_found(request):
 return HOLD_FRESH_UNCORRELATED # override-uncorrelated
 if not context_matches(request, token): # channel/topic/kind
 return HOLD_FRESH_UNCORRELATED # override-uncorrelated
 if text_edited(request): return HOLD_FRESH # ack binds to the hash
 # An ack answers EXACTLY the one finding it cites. Every other current
 # finding is unanswered and still holds (row 13a).
 unanswered = [f for f in current if f != acked_tuple(token)]
 if unanswered: return HOLD_FRESH # new citation, new token
 if not authorized_event_appendable():
 return REFUSE_OVERRIDE_UNRECORDABLE # row 18 (availability hold)
 return DELIVER # acked citation answered

 # Phase C — review. Reached only if Phase B did not resolve the request.
 return llm_review(request) # dispositions per §3.1
```

Within each phase the **first matching row wins**; the phases themselves are
strictly ordered A → B → C and never revisited.

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
| 15 | Resend, **no token presented at all**, **NO ack+reason**, **and NO live pending record matches this text** | true | n/a | true | **Ordinary fresh review.** No override was attempted, so nothing override-flavoured is emitted: **no** `tokenExpiredFreshReview`, no telemetry. Counted as a first-pass advisory. ** |
| 15a | Resend, a token **was** presented but its record is **expired/consumed/evicted**, **NO ack+reason** | true | invalid | true | Fresh review; response carries `tokenExpiredFreshReview: true`; counted separately; never a join on text. This is the only row that may claim expiry, because it is the only one that saw a token. |
| 15b | Resend, token presented but **context mismatch** (`channel`/`topicId`/`messageKind` differ from the record, §3.5) | true | invalid | true | **`override-uncorrelated`** — counted, never a delivery, never `tokenExpiredFreshReview`. A valid token in the wrong conversation is not an expired token; conflating them would hide the exact cross-context leak the token replaced a hash map to prevent. |
| 15c | **ack+reason present but NO token at all** | true | n/a | true | **Malformed override.** Fresh review, and counted as `override-malformed` — distinct from row 22, which had a token that aged out. An ack citing a rule with no token was never a valid override attempt and must not inflate the expired-attempt rate. |
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
| 22 | Resend with ack + reason and a token **that was presented but whose record is expired/consumed/evicted** | true | invalid | true | Fresh review (**row 15a**) **and** `expired-token-override-attempt` recorded machine-local, explicitly marked unjoined + unjudgeable, so the corpus does not silently over-represent overrides whose token happened to survive. ** |

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
- **PARTIAL disclosure of a held credential is a nudge at best, and sometimes
 nothing.** B22 matches a held value as a normalized substring, so it fires only
 on the value *in full*. Most of a token, a fixed prefix or suffix alone, or the
 value with one character altered does **not** reach the wall — and where the
 value is pattern-light (bare hex, no recognizable vendor prefix) it may not
 reach B23's nudge either, so nothing fires at all. This is an **accepted
 limit**, not an oversight: the alternatives are a prefix/window matcher whose
 false-positive rate on ordinary hex-looking text has no bound anyone has
 measured, and false positives on a NON-overridable wall have no recourse by
 construction (§3.1's whole reason for keeping the wall narrow). Recorded here
 rather than implied away. Revisit only with a measured false-positive bound.
- **In-memory plaintext has exposure channels the startup checklist does not
 cover.** §3.2.1's hardening addresses heap snapshots, the inspector, route
 exposure and crash reports. It does **not** address swap, ptrace or equivalent
 debug entitlements, `/proc`-style access where the platform offers it, child
 process inheritance, or platform-level crash collection. These are **accepted
 residuals for as long as the normalized index lives in this process** — the
 isolated matcher §3.2.1 already requires for vault values is the real fix, and
 it retires this bullet rather than shrinking it. Anyone with the local access
 these channels need can generally read the config the index is built from
 anyway, which bounds the added exposure without eliminating it.
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
