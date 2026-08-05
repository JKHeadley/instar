---
title: "Staged-Violation Harness — the prerequisite that makes a guard verdict falsifiable"
slug: "staged-violation-harness"
author: "echo"
eli16-overview: "docs/specs/staged-violation-harness.eli16.md"
approved: false
review-status: "DRAFT — not yet through adversarial review"
---

# Staged-Violation Harness

## Constitutional fit

**Parent standard: "Verify the State, Not Its Symbol" (The Substrate).** Every other guard-verification
mechanism in this phase produces a *symbol* — a counter, a registration, a posture. This harness is the
only proposed mechanism that produces the *state*: it creates a condition a guard is supposed to catch
and observes whether the guard caught it.

Also serves **"A Dark Feature Guards Nothing"** (a guard that has never been exercised guards nothing
in practice, whatever its posture says) and **"Testing Integrity"** (the Tier-3 "is the feature actually
alive?" question, applied to guards rather than routes).

## Problem statement

Phase A left **8 of 16** Level-2 leaves at `unmeasured` — *not* `false`. The guard never had an
opportunity to act, so no verdict was possible. Settling them requires **staging a violation**, and no
mechanism exists to do that.

This is not a gap in coverage. It is a **ceiling on the entire audit**:

> **A counter proves a guard is instrumented. Only a staged violation proves the counter is honest.**

The B0.1 design arc established this the expensive way. Three design generations tried to make a
guard's self-report trustworthy through schema, ownership, and arithmetic. The final adversarial review
closed the question:

> *"A guard can report `wouldAct = 0` forever. The invariant holds, the row is arithmetically
> consistent, and the guard may still be useless."*

**No amount of accounting distinguishes a diligent guard in a quiet world from a broken one.** Only
making the world briefly un-quiet does.

## The insight that makes this tractable

The chokepoint survey (`docs/audits/phase-b/chokepoint-survey.md`) was commissioned to answer a
*different* question — where a caller-owned `looked` counter could come from. It classified all 72
guards by how they are invoked.

**That same classification determines how hard each guard is to stage a violation against**, because
staging a violation means reaching the guard's evaluation path:

| invocation class | count | how you stage a violation | cost |
|---|---:|---|---|
| **FUNNEL** | **9** | Call the funnel with a crafted input. The evaluation path is a function you can reach directly. | **cheapest** |
| **EVENT-DRIVEN** | 16 | Emit the event the guard listens for. | moderate — needs the event surface |
| **TICK-LOOP** | 19 | Create the condition, then force or await a tick from the shared driver. | moderate — bounded by tick cadence |
| **SELF-DRIVEN** | 26 | Create the condition and wait on a timer you do not control. | **most expensive** |
| UNKNOWN | 2 | undetermined | — |

**One survey answers both questions.** This was not designed; it fell out, and it is the reason this
spec can propose an incremental path instead of an all-or-nothing harness.

## Proposed design

### Start with the FUNNEL nine

A funnel guard's evaluation is **a function with a caller**. Staging a violation is calling it with an
input that should trip it, and asserting it trips. That is an ordinary test — the reason it has not
been done is that nobody framed guard verification as testable, not that it is hard.

The nine, with their funnels (read from source, `chokepoint-survey.md`):

| guard | funnel |
|---|---|
| `writeAdmission` | `StateManager.ts:160` |
| `intelligence.selfActionGovernor.enabled` | `selfaction/governor.ts:1673` |
| `apprenticeship.stallCoverageGate.enabled` | `ApprenticeshipProgram.ts:652` |
| `messaging.attentionTopicGuard` | `TelegramAdapter.ts:3995` |
| `messaging.topicCreationBudget` | `TelegramAdapter.ts:1489` |
| `monitoring.completionClaimVerification.enabled` | `routes.ts:24594` |
| `monitoring.correctionLearning.selfViolationSignal` | `routes.ts:3174` |
| `models.tierEscalation.enabled` | `AgentServer.ts:3105` |
| `subscriptionPool.proactiveSwap.antiThrash.enabled` | `ProactiveSwapMonitor.ts:325` |

### Every staged violation is TWO-SIDED — the B-case is not optional

Phase A adopted this rule mid-audit and **downgraded three of its own completed verdicts** on
discovering they lacked it. A catch alone cannot be distinguished from a guard that rejects everything.

Every verification therefore runs a pair:

- **A-case** — an input that SHOULD trip the guard → the guard must act.
- **B-case** — a compliant input that should NOT trip it → the guard must allow it.

**A verdict from an A-case alone is refused, not recorded as weaker.** This is the single rule most
responsible for the audit's low false-positive rate, and it is structural here rather than remembered.

### Where it runs — and the honest limit on what a verdict means

Staging a violation mutates state. It runs against a **throwaway agent**, never the operator's live
agent.

⚠️ **And that carries a limit which must travel with every verdict this harness produces.** Phase A
stated it precisely: *`bob` exists on the current build, but 62 of its 87 guards are off, and a verdict
there proves the MECHANISM, never THIS MACHINE.*

So the harness produces exactly one claim, and it is narrower than it looks:

> **"This guard's mechanism catches this violation on a machine configured this way."**
> **NOT** "this guard is protecting your machine."

A guard verified on a throwaway agent and *disabled* on the operator's machine is verified and
worthless simultaneously. **The verdict must therefore carry the config fingerprint it was obtained
under**, and a consumer comparing it to a different machine's posture must treat it as inapplicable
rather than inherited. *(This is the cross-machine amendment — `aligned` requires `effective` on every
machine on the node's path — applied to the harness's own output.)*

### What a run records

```
{ guard, invocationClass, aCase: {input, expected, observed, passed},
  bCase: {input, expected, observed, passed},
  verdict: 'catches' | 'does-not-catch' | 'over-blocks' | 'inconclusive',
  configFingerprint,
  provenance: 'harness-throwaway',   // a CLASS marker, never a real identity
  at }
```

⚠️ **`agentId` and `machineId` were in the first draft and are REMOVED — the gate caught a repeat of a
real incident.** The harness runs on throwaway agents; recording their identities and then *replicating
the record* would walk test identity into durable shared state. That is the exact failure that clobbered
the user registry on 2026-07-01, after which test/fixture identities were refused at both the write and
load layers.

So: **a verdict carries a class marker, never a throwaway identity**, and it inherits the existing
test-identity refusal rather than inventing a parallel rule. Two consequences, both deliberate:

- **The verdict is keyed by `(guard, configFingerprint)`** — which is what actually determines
  applicability. The identity of the disposable agent that ran it was never load-bearing; I included it
  out of habit, and habit is how test identity gets into production state.
- **Teardown is not a tracked obligation**, because there is nothing durable to tear down. A harness
  whose records must be cleaned up later is a harness that will one day not be.

`over-blocks` is a first-class outcome, not a footnote: a guard that fails its B-case is **not** a
working guard, and the grounding-gate finding (precision 15–25%, falling) is what that failure looks
like in production.

`inconclusive` is required and must never collapse to `does-not-catch`. A harness that cannot tell
"the guard did not act" from "I could not stage the condition" reproduces the ambiguous zero it exists
to remove.

## Decision points touched

| # | decision point | classification | justification |
|---|---|---|---|
| 1 | **Did the A-case trip the guard?** | **invariant** | An observable side effect occurred or did not. Deterministic. |
| 2 | **Did the B-case pass through?** | **invariant** | Same. |
| 3 | **Is the staged condition a faithful instance of what the guard protects against?** | **judgment-candidate** | The genuinely hard one. A crafted input can trip a guard for the wrong reason. **Floor:** the A-case must be derived from a *real recorded incident* where available, not invented; conservative default is `inconclusive`; the ladder terminates at "refuse to record a verdict". **Arbiter:** the reviewing agent/human, never the harness. |
| 4 | **Does a verdict from a throwaway agent apply to this machine?** | **invariant** | **No.** Deterministic and deliberately absolute — the config fingerprint either matches or it does not. |

## Multi-machine posture

| surface | posture | notes |
|---|---|---|
| harness definitions (A/B cases per guard) | **unified** | Source-tracked; identical everywhere by construction. |
| a run's recorded verdict | **unified (replicated), per-machine keyed** | ⚠️ **Corrected — the first draft said `machine-local BY DESIGN` with a `hardware-bound-resource` marker, and that was wrong twice.** A verdict is not hardware-bound, and more importantly I had conflated *must not be INHERITED* with *must not be REPLICATED*. They are different: a peer holding my verdict as **data** is useful (it answers "is this guard verified anywhere?" and feeds a pool view); a peer **adopting** my verdict as its own is the error. So verdicts replicate, keyed by `(guard, machineId, configFingerprint)`, and the no-inheritance rule is enforced **semantically at read** — a verdict whose fingerprint does not match the reading machine renders as `inapplicable-here`, never as that machine's status. Withholding the data was the lazy way to prevent a misread. |

## Frontloaded Decisions

1. **FUNNEL guards first**, in the order listed. Cheapest evaluation path, and they overlap the 28
   guards viable for caller-owned counters — so the two workstreams reinforce rather than diverge.
2. **B-case mandatory from the first verification.** No "add controls later" phase; that is the phase
   that never happens.
3. **Throwaway agent only.** No staged violation ever runs against the operator's live agent.
4. **`inconclusive` is a required outcome**, never folded into a negative.
5. **Verdicts carry a config fingerprint** and are not inheritable across machines.

**Cheap-to-change-after:** the record shape, the per-guard A/B inputs. **Not cheap:** the two-sided
requirement and the no-inheritance rule — both are the difference between a harness and a
verdict-generator.

## Resolved here (previously open)

**1. How is a faithful A-case derived? — MY FIRST ANSWER WAS REFUTED BY MEASURING IT.**

The draft bounded scope to guards whose A-case derives from a *recorded incident*, and called that a
resolution. **Then I checked the corpus, and the bound is unworkable.**

Surveyed all 26 non-empty JSONL logs (control passed: 8,600 hits for a term known to be present):

| FUNNEL guard | incident records found |
|---|---:|
| `models.tierEscalation` | **2** |
| the other **eight** | **0** |

**One of nine, with two records.** A scope bound of "incident-derived only" would make this spec cover
approximately nothing. *(And the first pass of that survey reported 1,141 records for `tierEscalation`
using a loose substring — 1,139 were false positives. The real number is 2. Fourth time in this audit a
keyword match produced a confidently wrong count; caught by re-running strict against loose.)*

**The honest consequence:** the incident corpus does not describe these guards at all. It records
reaps, sentinel transitions, and posture changes — **operational events, not guard evaluations.** That
is itself a finding: *we have no record of our guards making decisions*, which is the same absence this
whole phase is about, showing up in the place I went looking for evidence.

**So the corrected answer, weaker and true:** A-cases derive from the guard's **specified behaviour**
(its manifest `description`, its `criticalPath`, and the condition its code branches on), not from
history. Faithfulness then rests on the specification being accurate — which is a real, stated weakness,
and it is the actual state of the world rather than a bound I wished into place.

**Corollary worth carrying:** once the harness runs, its own records become the incident corpus that
did not exist. The first verification is unavoidably derived from a description; later ones need not
be.

**2. What happens to the 26 SELF-DRIVEN guards? — RESOLVED: explicitly out of scope, and the coupling
is named.** They are not deferred within this spec; they are **excluded from it**, because reaching
them requires the guard-invocation re-architecture that the B0.1 fork's option (b) contemplates. If the
operator picks option (a) — narrow — then these 26 remain unstageable and must be reported as
`unverifiable-by-construction`, which is a truthful end state rather than a backlog.
**The coupling the tree did not show: B0.5's reach is bounded by B0.1's fork decision.** Recorded so
the two are scheduled as one decision rather than two.

**3. Is a throwaway-agent verdict worth its cost? — RESOLVED as a deliberate two-half design.**
It verifies the MECHANISM. That is explicitly half the value, and this spec claims only that half. The
second half — "is this guard protecting THIS machine?" — is answered by the *combination* of a
mechanism verdict and that machine's live posture, which `/guards` already reports. **Neither half is
sufficient alone, and the composition is the deliverable**, not a follow-up. A reviewer who thinks the
mechanism half is not worth building alone is arguing against the composition; that argument should be
made now rather than discovered later.

## Genuinely open

- **Does a specification-derived A-case carry enough faithfulness to support a verdict?** This is
  decision point 3 and it is now the spec's load-bearing weakness rather than a footnote, because the
  incident-derived alternative was measured and found empty. A reviewer who thinks
  specification-derived A-cases are too weak is arguing that this spec should not ship — and that
  argument is now well-posed enough to actually have.
