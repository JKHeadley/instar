# Tranche 4 — class-A nodes (cheap, no harness). Batch 1.

Measured **2026-08-04 07:15Z**, Mini. All three are **`on-confirmed`** — the system's highest trust tier.

## 1. `intelligence.selfActionGovernor` — **`effective: FALSE`, evidenced**

**1,940 self-actions evaluated · 1,616 judged deniable · 0 denied.** Every one of 9 classes is
`mode: observe`. Full node: `tranche4-self-action-governor.md`.

## 2. `monitoring.blockerLifecycleLedger` — **`unmeasured`, no opportunity**

Every counter zero: `completed: 0`, `missing: 0`, `excluded: 0`, `coverage: null`,
`outcomes.observed: 0`. The ledger is constructed and ticking and **has never recorded a single
observation.**

**Verdict `unmeasured`, NOT false** — per the counter method's three-way rule. But it is the risk-flag
case: a ledger with zero observations is one whose first real entry happens during an incident.

## 3. `monitoring.throughputFloor` — **`effective: FALSE` by design, and busier than it looks**

`enabled: true`, `mode: pull-audit-only`, `flatlineMinutes: 75`.

It **did** evaluate — both live autonomous runs on this machine (topics 29723 and 36966). It returned
**`decision: ineligible, reason: scope-or-ownership-ineligible`** for both. So it is actively assessing
and has **zero effective coverage**: every run it has seen was out of its scope.

Per its own documentation it "has no lane authority and cannot grant HOLD" — **so this is by design.**

## 4. `intelligence.testRunnerCap` — **`effective: TRUE`. THE PATTERN BREAKS.**

**The first Tranche 4 guard measured that genuinely ACTS.**

| evidence | value |
|---|---|
| posture | **`enforcing`** (not dry-run, not observe) |
| **real blocks** | **30** |
| `would-block` (dry-run era) | 21 |
| would-clamp | 348 |
| acquires / releases | 2,418 / 2,381 |

**30 recorded blocks.** It has refused real test runs, on this machine, in enforcing mode.

**Plus first-hand evidence:** when I ran the PR test suite tonight, its own line appeared in my output —
`[test-runner-bound] targeted-lane slot acquired (posture: enforcing, cap 6, pid 50603)`. **I personally
rode through this guard while auditing it.**

**And the counters record the soak→arm transition cleanly:** 21 `would-block` (when it was watching) then
30 `block` (once armed). That is the graduated-rollout ladder working end-to-end and leaving evidence —
the only guard tonight that shows it.

⭐ **This is why Ruling 4 said FULL audit, not sample.** I wrote three entries above finding
"`on-confirmed` means ticking, never acting", explicitly refused to extrapolate to the other 17, and said
*"the next one might break the pattern."* **The next one broke the pattern.** Had I sampled and stopped
at three, I would have reported a false universal.

---

## ⭐ THE PATTERN ACROSS THE FIRST THREE — and its limit

| guard | trust label | what it actually does |
|---|---|---|
| self-action governor | `on-confirmed` | evaluates 1,940, denies 0 (observe-only) |
| blocker-lifecycle ledger | `on-confirmed` | observes 0 |
| throughput floor | `on-confirmed` | evaluates 2, both ineligible (audit-only) |

> **Three for three, `on-confirmed` meant "ticking", never "acting" — and then the fourth genuinely
> acted, with 30 recorded blocks.**
>
> **So the honest finding is NOT "trusted guards don't act". It is: `on-confirmed` does not tell you
> which.** Some enforce, some observe, and the label is identical.

This is the A0 heartbeat finding confirmed from the other direction. There I showed `on-confirmed`
correlates perfectly with carrying a heartbeat; here I show what that buys in practice on the guards the
system trusts most — **nothing yet, in every case examined.**

⚠️ **And in every case it is DELIBERATE** — observe-only, audit-only, awaiting a rollout flip. **Not one
is broken.** The finding is not "these guards fail"; it is:

> **The system's highest trust label is applied to guards that are, by design, incapable of acting — and
> nothing on the posture surface distinguishes "trusted and enforcing" from "trusted and observing".**

That is a labelling defect on the instrument, not a defect in the guards, and it is exactly the class
Ruling 4 predicted would be most dangerous.

**Sample: 4 of 20 — and the fourth refuted the first three's pattern.** That is the strongest possible
argument for Ruling 4's full-audit call, delivered by the audit itself within an hour of the ruling.

**What survives is narrower and more useful than what 3-for-3 suggested:** the trust label is
**uninformative**, not wrong. `intelligence.testRunnerCap` and `intelligence.selfActionGovernor` carry the
*same* `on-confirmed` marker; one has blocked 30 real runs and the other has denied nothing in 1,616
opportunities. **A reader cannot tell them apart from the posture surface.** That is the defect.


---

## 5. `multiMachine.seamlessness.ws13Reconcile` — **`unmeasured`, and I nearly recorded a PASS**

`on-confirmed`, `dryRun: false`, ticking. And `GET /pool/placement?topic=29723` reports
**`reason: pinned`, `pinState: actuated`, `pinHeldSince` set** — the pin is live and holding.

**My first read was "the reconciler is maintaining a real pin, therefore effective."** That is wrong.

⚠️ **`actuated` means desired == actual. It does not mean the reconciler ever CORRECTED anything.** A pin
that has never been disturbed reads `actuated` too. To claim `effective` I would need a **correction
event** — a moment where actual diverged from desired and the reconciler pulled it back. **No such event
is recorded.**

**Verdict: `unmeasured`.** Correct end-state, no evidence of intervention. This is the same trap as the
"never fired" ambiguity, wearing a different mask: **a guard whose job is to maintain a state looks
identical, from the state, to no guard at all.**

## 6. `apprenticeship.stallCoverageGate` — **`unmeasured`, with an open question**

`on-unverified`. One instance exists (`echo-to-codey`, **status `active`**, rung 0).

**`logs/apprenticeship-decisions.jsonl` does not exist.** Per its own documentation *"every verdict is
audited to logs/apprenticeship-decisions.jsonl"* — so **the gate has never logged a verdict.**

⚠️ **The open question:** that instance is `active`, which means it transitioned out of `pending` — and
the gate is supposed to evaluate exactly that transition. So either it was created before the gate
existed, or the gate did not run on that transition, or the audit lands somewhere else. **I am not
resolving that from absence of a file** — three explanations fit and I have made that mistake three times
tonight already.

**Verdict: `unmeasured`, with a named follow-up** (read the transition path and find where, if anywhere,
its verdict was written).

---

## CLASS-A BATCH COMPLETE — 6 of 6

| # | guard | verdict |
|---|---|---|
| 1 | self-action governor | ❌ **`effective: false`** — 1,616 would-deny, 0 deny (evidenced) |
| 2 | blocker-lifecycle ledger | ⚪ `unmeasured` — zero observations ever |
| 3 | throughput floor | ❌ `effective: false` by design — audit-only, both runs ineligible |
| 4 | **test-runner cap** | ✅ **`effective: TRUE`** — **30 real blocks**, watch→enforce transition visible |
| 5 | ws13 reconcile | ⚪ `unmeasured` — correct state, no correction event |
| 6 | stall-coverage gate | ⚪ `unmeasured` — no verdict ever logged; open question |

**1 pass · 2 fails (both by deliberate design) · 3 unmeasured.**

**The distribution is the finding.** Half could not be assessed at all, and the two fails are intentional
rollout states rather than defects. **Exactly one guard of the six is demonstrably doing its job** — and
it is the one that also shows its own watch→enforce history in its counters.

⭐ **Every guard I could measure cheaply, I measured. Three I could not — and I recorded `unmeasured`
rather than inventing a verdict, three separate times, in a single batch.** That restraint is the
difference between an audit and a report.
