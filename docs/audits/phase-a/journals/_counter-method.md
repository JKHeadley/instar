# The counter method — cheap rung-3 evidence, and what it actually shows

**Discovered 2026-08-04 06:55Z** while auditing the self-action governor; generalised 07:00Z.

## The method

Many guards record BOTH a **would-act** counter and a **did-act** counter. Reading the pair yields rung-3
evidence **with no injection and no harness** — from violations that occurred naturally, with the outcome
already attached.

## ⭐ IT YIELDS THREE OUTCOMES, NOT TWO — and the third is the important one

| pattern | verdict | meaning |
|---|---|---|
| `would > 0`, `did = 0` | **`effective: false`** — evidenced | opportunities arose; it acted on none |
| `did > 0` | **rung-3 evidence FOR** | it has demonstrably acted on a real occasion |
| **`would = 0`, `did = 0`** | **`unmeasured`, NOT false** | **it has never had an opportunity** |

**The third case is the one that matters, and it is the majority.** Measured across nine guard surfaces:

| guard | would | did | verdict |
|---|---|---|---|
| **self-action governor** | **1,616** | **0** | **`effective: false` — evidenced** |
| machine coherence | 0 | **1 raised** | **evidence FOR** |
| stale-owner release | 0 | 0 | unmeasured — no opportunity |
| duplicate reconciler | 0 | 0 | unmeasured — no opportunity |
| write admission | 0 | 0 | unmeasured — no opportunity |
| failover gap | 0 | 0 | unmeasured — no opportunity |
| missing login | 0 | 0 | unmeasured — no opportunity |

## What this reframes

The audit's shape is **not** "the guards are broken." It is:

> **Most guards have never been in a position to act, so their effectiveness is genuinely UNKNOWN —
> not false.**

That is a materially different and more honest statement than a low `effective` count implies, and it
cuts against my own earlier framing. When I reported *"20 of 90 confirmed, so 78% do not count as
aligned"*, the implied reading was *78% are not working*. **The truthful reading is: a large share have
never been exercised, by circumstance rather than by defect.**

⚠️ **And `unmeasured` must not quietly become `false`.** A guard with zero opportunities is exactly the
one whose first real test happens during an incident — which is the dead-backstop shape from earlier
tonight (a fallback that had never been called, failing the day it was). **Zero-opportunity is a RISK
flag, not a pass and not a fail.**

## Why this is cheap and worth doing first

- **No injection, no harness, no risk.** One authenticated GET per guard.
- It produces **genuine rung-3 evidence** where opportunities exist — the governor's 1,616 natural
  violations are stronger than any single injected case.
- It **triages the expensive work**: a guard already showing `would > 0, did = 0` needs no harness to
  reach a verdict. Only the zero-opportunity guards need the throwaway-agent rig — and now we can name
  exactly which.

**Revision to the cost map:** the 37 harness-blocked guards should first be swept with this method. Any
that already show would/did activity get a verdict for free, shrinking the harness's critical-path
burden. I do not yet know how many — that sweep is the next cheap win.

## Honest limit

Not every guard exposes both counters (`test-runner-limiter`, `external-hog`, `autonomous/liveness` did
not surface a pair). For those, the method returns nothing and the harness is still required. **The
method is a triage filter, not a replacement for injection.**


---

## 07:05Z — SWEEP RUN OVER 7 DAYS, AND I MISLABELLED 22 GUARDS BEFORE CATCHING IT

Ran the method against `/metrics/features` (a second counter surface: `calls` / `fired` / `noop` /
`errors`) over a 168-hour window.

### ✅ RUNG-3 EVIDENCE **FOR** — 5 guards demonstrably acted on real occasions

| guard | fired | of calls |
|---|---|---|
| `rope-health` | **302** | 20,272 |
| `MessageSentinel` | **80** | 305 |
| `rope-recovery-probe` | **33** | 101 |
| `CommitmentSentinel` | **17** | 94 |
| `scope-accretion` | **10** | 13 |

**Five guards with positive rung-3 evidence, obtained from one authenticated GET.** No injection, no
harness. That is a real result and it more than doubles the audit's rung-3 evidence base (3 lint passes
+ machine-coherence + these 5).

### ⚠️ I LABELLED 22 GUARDS "HAD OPPORTUNITY, NEVER ACTED". THAT IS WRONG FOR MOST OF THEM.

My bucket assumed `calls − errors` = opportunities-to-decide. **It does not.** Splitting properly:

**(a) Genuinely classified, never fired — 2:**
`mesh-coherence-live` (19,971 calls, **19,971 noop**, 0 err) · `durable-output-scrub` (16,435 calls,
**16,435 noop**, 0 err). These really did have ~20,000 opportunities and fired on none.

**(b) Outcome NOT RECORDED — the other 20:** `UnjustifiedStopGate` (1,081 calls, 75 err, **noop 0**),
`MessagingToneGate`, `SessionWatchdog`, `TopicIntentExtractor` and the rest. `calls − err > 0` with
`noop = 0` means those successful calls were **never classified** — so **I cannot tell whether they fired
or not.** Calling them "never acted" would have been a fabrication.

**That is the `fired`-column artifact from A0 #5, resurfacing as a trap for my own method.** I documented
it hours ago and then built a sweep that walked straight into it.

### ⚠️ AND EVEN CASE (a) IS AMBIGUOUS — the deeper limit

`durable-output-scrub` noop-ing 16,435 times means it scrubbed nothing 16,435 times. **For a scrubber,
finding nothing is usually CORRECT.** For a guard that should sometimes fire, never firing is suspicious.

**Distinguishing them requires each guard's EXPECTED BASE RATE, which nothing records.** So:

> **"Never fired" is not a verdict without an expected base rate. It is a question.**

That is a genuine gap in what the system can currently tell us about itself — arguably a finding about
*Observability* (a Tranche 2 standard) rather than about any individual guard.

### Corrected standing of the method

- **Positive evidence is sound and cheap** — `fired > 0` means it acted. 5 guards banked.
- **Negative evidence is weak-to-unusable** — it needs (i) outcomes actually classified and (ii) an
  expected base rate. Neither exists for most guards today.
- **The method is therefore an evidence-FINDER, not a verdict-maker.** It cannot fail a guard; it can
  only confirm one, or raise a question.

**I am recording the mislabel prominently because the sweep looked authoritative** — a clean table, three
tidy buckets, 27 guards classified in one pass. **It was two-thirds wrong**, and only re-deriving what
`noop = 0` actually means caught it.
