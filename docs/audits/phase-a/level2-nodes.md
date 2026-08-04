# LEVEL 2 — per-standard audit nodes. **APPROVED** (architect review, 2026-08-04 ~05:20Z)

**Status:** APPROVED with one amendment + four rulings, all incorporated below. **Audits may run once the
amendment is in the template — it now is.** Submitted to topic 36966 for review against the node contract,
per the charter: *"Send me the Level 2 draft for review against the node contract BEFORE any audit runs."*
**Author:** Echo (orchestrator), run `run-mse33vhj-508c345f`, 2026-08-04.
**Rests on:** `.instar/phase-a/A0-instruments.md` (A0 complete, 17 instruments, 7 effective, both machines).

---

## ⚠️ FIRST — A CORRECTION TO MY OWN A0, BECAUSE IT CHANGES THE BASELINE

The node contract defines rung 3 precisely:

> **EFFECTIVE: it demonstrably bites — a deliberately introduced violation gets caught, on the CURRENT
> code, with coverage checked against live paths.**

**My A0 pass did not apply that bar to the guard set.** I reported *"20 of 90 guards are `on-confirmed`"*
— but `on-confirmed` is the **product's own** label for "runtime says it is on", which is nearer rung 2
than rung 3. **Nobody injected a violation and watched it get caught.**

So the honest baseline is:

- **20 of 90** clear the product's confirmation bar.
- **An unknown number ≤ 20** clear the contract's rung-3 bar.
- **The contract's rung 3 has not been measured for a single guard.** That measurement is what Level 2 is
  *for*, and it does not exist yet.

I am flagging this against my own report because "20/90" is quotable, I produced it, and it would have
been read as a rung-3 number by the next reader — including me.

---

## THE NODE TEMPLATE (satisfies all six rules)

Every Level 2 node — one per constitutional standard — is instantiated with exactly this shape:

```yaml
node: L2/<family>/<standard-slug>
standard: "<exact article heading from the registry>"
family: The Root | The Fractal | The Substrate | Building | Shipping | Interaction

# RULE 1 — scope + measurable exit + status derived at read time
scope:
  standard_text: <registry anchor>          # the prose whose promise we are testing
  code_surface: [<paths/routes/symbols>]    # the live surface it claims to govern
  named_guard: <ref the prose names, or NONE>
exit_condition: >                            # measurable, not prose
  A three-rung verdict recorded for <named_guard> with source+timestamp, where rung 3 is
  decided by an INJECTED VIOLATION on current code — or, if the standard is unmeasurable,
  an explicit `unmeasurable` verdict naming which rung could not be reached and why.
status: DERIVED                              # never asserted, never cached; recomputed from journal at read

# RULE 4 — three-rung, never binary
# ⭐ ARCHITECT AMENDMENT: every rung carries a MACHINE field. A verdict does not transfer.
machines_on_critical_path: [mini, laptop]    # which machines this standard's path actually runs on
verdicts_by_machine:
  mini:
    exists:    {result: ~, source: ~, at: ~, machine: mini}
    wired:     {result: ~, source: ~, at: ~, machine: mini}
    effective: {result: ~, source: ~, at: ~, machine: mini}   # injected violation caught on CURRENT code
  laptop:
    exists:    {result: ~, source: ~, at: ~, machine: laptop}
    wired:     {result: ~, source: ~, at: ~, machine: laptop}
    effective: {result: ~, source: ~, at: ~, machine: laptop}
aligned: false   # TRUE only if `effective` passes on EVERY machine in machines_on_critical_path

# RULE 5 — anti-decay
measured_at: <ISO>
max_age_before_remeasure: 24h                # any claim consuming this re-measures first

# RULE 6 — append-only journal
journal: .instar/phase-a/journals/<family>/<standard-slug>.md
```

**Rule 2 (80/20 sizing)** is enforced at instantiation, not inside the node — see sizing below.
**Rule 3 (convergence)** is the node's *completion* rule — see below.

### ⭐ THE AMENDMENT, AND WHY IT WAS MINE TO CATCH

The architect's one amendment: **every verdict rung carries a machine field; a node spanning both machines
records per-machine verdicts; `aligned` is true only if `effective` passes on every machine the critical
path runs on.**

**This came from my own A0 finding (#15)** — the machines enumerate 90 vs 93 guards, run different builds,
and use different provider accounts — where I wrote *"every Level 2 node must state which machine it
measured."* **I wrote the rule and then left the template relying on discipline to enforce it.** I have
since had to correct my own A0 twice for exactly that (the provider verdict, then a systematic scope
table). Structure over willpower, applied to the artifact that argues for it.

### RULING 1 — non-guard standards: `unmeasurable-by-injection` has teeth

Approved as proposed, **plus**: an `unmeasurable-by-injection` verdict REQUIRES a **named alternative test
that is still falsifiable against current behaviour** — a **live, dated instance of the standard
demonstrably shaping an outcome, inside the anti-decay window**. A prose assertion of compliance is NOT
acceptable.

**And every such verdict feeds the Root-and-Fractal branch as a finding about the constitution itself:**
a standard that cannot be measured *any* way is a candidate for **restructuring, not a permanent
exemption.**

```yaml
unmeasurable_by_injection:
  reason: <why no violation can be injected>
  alternative_test: <named, falsifiable against current behaviour>
  live_instance: {what: ~, dated: ~, machine: ~}   # REQUIRED — inside the anti-decay window
  feeds: root-and-fractal   # as a finding about the constitution, not an exemption
```

### RULING 2 — cluster-leaves: sweep may be shared, verdicts may not

Confirmed: rule 1's unit is **scope-per-node**. Clustering 2–4 standards sharing one guard and one surface
is correct sizing. **Hard constraint: record per-STANDARD verdicts inside a cluster node**, so synthesis
stays honest at standard granularity.

### RULING 3 — two echo rounds is a FLOOR, not a ceiling

The two-round rule exists to make single-pass closure **impossible**, not to replace the
fundamentals-versus-echoes judgement. **An echo round is judged by content, and the journal must record
WHY each closing round was echoes.** Derived status already handles reopening.

⚠️ **Directly relevant to A0:** I classified round 5 as an echo while it surfaced a real thing (11,610
feedback items in a non-terminal state) on the grounds that it changed no Phase A verdict. **That
judgement is exactly what rule 3 now requires me to journal rather than bury in the word "echo" — and I
did journal it.** The floor would not have permitted closing at round 4 regardless.

### RULING 4 — tranche 4: FULL AUDIT, not a sample

**The 20 confirmed guards are the ones the system currently trusts, so wrong trust there is the most
dangerous class in the set** — precisely where confirmation-is-not-effectiveness pays out. Sequenced last;
cluster where surfaces overlap. If quota pressure materialises it is revisited **with data at a management
pass**, not pre-decided as weakness.

---

## RULE 3 — WHAT "CONVERGED" MEANS FOR A NODE

A node completes when a re-sweep of its **full scope** surfaces zero new findings — judged by whether the
round produced **fundamentals or echoes**, never by a fixed round count.

Operationally, per node: run the sweep, fix/classify each finding, **re-run the whole scope**, repeat.
The node's journal records each round's yield. A round that returns only restatements of prior findings
is an echo round; **two consecutive echo rounds close the node.** A round that surfaces a new fundamental
resets the count.

⚠️ **This is the expensive rule and it is the one most likely to be quietly dropped under time pressure.**
A single-pass node is incomplete by definition and must be journaled as `single-pass, NOT converged`
rather than closed.

---

## SIZING (Rule 2) — WHY NOT 82 NODES

82 standards, one session each, is not deliverable and would drift. Proposed sizing:

- **A leaf is one standard** where the standard names a specific guard against a specific surface.
- **A leaf is a cluster of 2–4 standards** where they share one guard and one surface (auditing them
  separately would re-walk the same code three times).
- **A standard whose scope cannot be swept in one session is split** by code surface, not by sub-clause —
  splitting by prose produces nodes that cannot be independently measured.

### ✅ CLUSTERING PASS RUN — THE LEAF COUNT IS NOW REAL: **68**

Ordered by the architect ("run it now so the leaf count becomes real instead of estimated"). Computed from
the live conformance data (82 standards, each with its resolving guard refs), applying ruling 2 —
2–4 standards sharing one guard and one surface become one leaf, per-standard verdicts recorded inside.

| | |
|---|---|
| standards | 82 |
| **distinct guard-sets** | **63** |
| unguarded standards | 16 |
| oversized sets needing a split | 0 |
| **LEAVES** | **68** |
| leaf sizes | 60×1 · 4×2 · 2×3 · 2×4 |

⚠️ **My estimate was 45–55. The real number is 68 — I was low by 24–51%.**

**Why the estimate missed, and it is worth knowing before lanes are sized:** I assumed guards are widely
shared, so clustering would collapse the tree substantially. **They are not — 63 distinct guard-sets cover
66 guarded standards. Almost every standard has its own guard.** Only **3 guarded clusters** exist
(6 standards total); the other 5 clusters are the *unguarded* standards grouped by family.

**So the tree is nearly flat.** That is itself a finding about the constitution's structure: guards are
per-standard rather than shared infrastructure, which means Level 2 is 68 largely-independent sweeps
rather than a few broad ones. **Parallel lanes help here; clustering does not.**

**The 8 multi-standard clusters:**
- `ownership-gated-spawn…` → Ownership-Gated Side Effects · Judgment Within Floors
- `INSTAR-DESIGN-PRINCIPLES…` → Friction Is a Spec · Notice + Solve Inefficiencies
- `instar-dev-precommit.js` → No Deferrals · Side-Effects Review Gate
- *unguarded* Substrate ×2 (4+4) · Building (3) · Interaction (3) · Shipping (2)

Full tree: `/tmp/leaves.json` → to be placed in the plan document where the architect's reads verify it.

---

## PROPOSED TRANCHE ORDER — and the reasoning, which is the part to review

I am **not** proposing to start at family 1 and walk to family 6. Ordering by measured risk:

### Tranche 1 — LOAD-BEARING AND NOT CONFIRMED (9 nodes)
Guards A0 found are load-bearing (a critical path depends on them) and **not** `on-confirmed`:

| guard | posture | critical path |
|---|---|---|
| mesh reachability recovery | on-dry-run | mesh partition recovery |
| durable operator inbound delivery | on-dry-run | **operator messages not being lost** |
| topic reachability when owner dies | on-dry-run | conversation survives a dead machine |
| serving-lease hand-back | on-dry-run | lease returns to intended captain |
| correction-derived instance fixes | on-dry-run | corrections actually applied |
| apprenticeship sign-off gate | on-unverified | onboarding sign-off |
| mesh partition alerting | on-unverified | partition is noticed |
| deliberate placement persistence | on-unverified | operator pins hold |
| autonomous execution on a peer | off | peer worker lanes |

**Why first:** these are the ones where "looks protected, has never been exercised" is already measured
true — the exact shape that produced tonight's dead backstop.

### Tranche 2 — THE 16 DOCUMENTED-ONLY STANDARDS (≈8 nodes, clustered)
Standards the conformance audit finds with **no structural guard named at all**:

- *The Substrate* (8): The Body and the Mind · Documentation IS Being · Deferral = Deletion · Name the
  Gravity Wells · Architectural Agency in the Gap · Sovereignty · The Right to Stand Ground · Session
  Input Is a Principal
- *Building* (3): Cross-Store Coherence Is an Invariant · LLM-Supervised Execution · Observability
- *Interaction* (3): Never-Waste Feedback · Near-Silent Notifications · Truthful Provenance
- *Shipping* (2): Bug-Fix Evidence Bar · User-Facing Fixes Ship Live

**Why second:** rung 1 already fails, so these are cheap to verdict — but each needs a judgement about
whether it is *unguardable* or merely *unguarded*, which is architect territory.

### Tranche 3 — THE 40 `on-unverified` GUARDS
Where rung 3 has never been attempted and `runtimeReason: not-instrumented` on 62/90. **The largest
tranche and the real body of Phase A.**

### Tranche 4 — THE 20 `on-confirmed` — **FULL AUDIT (ruling 4)**
Not skippable and **not sampled**. These are the guards the system currently trusts, so wrong trust here
is the most dangerous class. Expect this tranche to demote some of the 20.

⚠️ **A0 sharpened what these 20 actually are:** `on-confirmed` correlates **perfectly** with carrying a
runtime heartbeat (20/20 of the confirmed are among the 26 enriched; 0/64 of the non-enriched are
confirmed). **So all 20 are rung-2-by-pulse.** This tranche is not re-checking rung 3 verdicts — it is
establishing rung 3 for the first time on the guards most likely to be assumed safe.

---

## WHAT NODES MAY NOT CITE (A0's binding constraint)

From A0, and this is a hard constraint on every node:

1. **No node may take a verdict from the conformance audit's `enforced` field.** Its basis is
   ref-existence (rung 1) and it self-declares `assessmentTrustworthy: false`. It is a **work list**, not
   evidence.
2. **No node may cite the doc map.** 2,120 nodes, 0 authored.
3. **No node may rest on output from the model-backed checks** until the primary/backstop failures clear —
   which includes anything downstream of intent classification and outbound review.
4. **Every node re-derives rung 1 and 2 from source**, or records `unmeasurable` and says which rung
   failed and why.

---

## LANES (placement policy)

- **Orchestration: Mini.** Node instantiation, journal reconciliation, synthesis up the tree.
- **Workers: laptop.** Per-node sweeps. The test-run limiter there was armed this run and verified
  `enforcing`, so concurrent worker suites are now bounded — that was a prerequisite, not a chore.
- **Codey lanes: NOT PLANNED.** The route to him is unverified this window (the operator-account browser
  seat is held). Per the charter, no Codey lanes on an unverified channel.

---

## FIVE QUESTIONS FOR THE ARCHITECT

1. **Is rung 3 by injected violation right for every standard, or only for guards?** Several Substrate
   standards ("The Right to Stand Ground") have no injectable violation. Proposal: those get an explicit
   `unmeasurable-by-injection` verdict with a named alternative test, rather than being quietly graded on
   a weaker bar — but that is a contract question, not mine.
2. **Does a cluster-leaf (2–4 standards, one guard) violate rule 1's "one standard, one surface"?** I read
   it as scope-per-node, not standard-per-node. Confirm.
3. **Two consecutive echo rounds as the convergence close** — is that the right operational reading of
   "fundamentals or echoes", or does it re-introduce the fixed round count rule 3 rejects?
4. **Tranche 4 (the 20 confirmed) — audit or sample?** Full audit is the honest reading; sampling is the
   affordable one. Sampling weakens the whole exercise, so I lean full, but it is a cost you own.
5. ~~**The 82-standard registry is stale** … **This blocks Tranche 2**~~
   **✅ ANSWERED BY MEASUREMENT — and the answer reverses the question. Tranche 2 is UNBLOCKED.**

   The registry is **not stale**. The packed asset (252,764 bytes, 2026-08-03 19:25) is **byte-identical**
   to the `fix-lease-poll-intent-republish` checkout — same sha256 `5413a0c6ef9ba2bd`.

   The audit reports `assessmentTrustworthy: false` **only because it is configured to compare against
   `convergence-tier1`, a 2026-07-25 worktree that is behind.** The drift it detects is exactly **one**
   heading — *User-Facing Fixes Ship Live* — present in the current registry and absent from that old
   checkout. So the comparison is against a **stale checkout**, not a stale asset.

   **Consequences:**
   - **Tranche 2 stands.** At most ONE of the 16 documented-only standards could be a drift artifact; the
     other 15 are not explained by it.
   - The audit's own `confidenceReason` ("the asset is stale relative to what is written right now") is
     **backwards for this configuration** — the asset is current; the tree it is pointed at is not.
   - **Concrete fix, one line:** repoint this topic's project binding (which drives `guards.projectDir`)
     at a current checkout, and the audit becomes trustworthy without touching the registry.
   - ⚠️ Not applied — repointing a topic binding has coherence-gate side effects and the charter is
     measurement. Ready on your word.

---

## WHAT I HAVE NOT DONE, DELIBERATELY

- **No audit has run.** No node instantiated beyond this template.
- **No clustering pass**, so the leaf count is an estimate and labelled as one.
- **No rung-3 measurement attempted on any guard** — that is the first act after review, not before it.

---

## THE TREE — all 68 leaves, as instantiated

Per the architect: *"put the tree in the plan document where my reads verify it."* Generated from live
conformance data 2026-08-04 06:00Z, ruling-2 clustering applied. **Leaf = one audit node.**


### Multi-standard clusters (8 leaves, 22 standards) — ruling 2: shared sweep, per-standard verdicts

| # | shared guard / basis | standards |
|---|---|---|
| 1 | `docs/specs/ownership-gated-spawn-and-judgment-within` | Ownership-Gated Side Effects · Judgment Within Floors |
| 2 | `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` | Friction Is a Spec — Productize the Workarou · Notice + Solve Inefficiencies — Efficiency I |
| 3 | `scripts/instar-dev-precommit.js` | No Deferrals · Side-Effects Review Gate |
| 4 | `unguarded-The Substrate` | The Body and the Mind · Documentation IS Being · Deferral = Deletion · Name the Gravity Wells |
| 5 | `unguarded-The Substrate` | Architectural Agency in the Gap · Sovereignty — "I own what is mine" · The Right to Stand Ground · Session Input Is a Principal |
| 6 | `unguarded-Building` | Cross-Store Coherence Is an Invariant · LLM-Supervised Execution · Observability — you can't tune what you can' |
| 7 | `unguarded-Shipping` | Bug-Fix Evidence Bar (verify before you clai · User-Facing Fixes Ship Live |
| 8 | `unguarded-Interaction` | Never-Waste Feedback — corrections compound · Near-Silent Notifications · Truthful Provenance — Speak Only as Yourself |

### Singleton leaves (60) — one standard, one guard, one surface

| # | standard | guard ref |
|---|---|---|
| 1 | Structure beats Willpower | `scripts/standards-coverage.mjs` |
| 2 | Self-Hosting | `DispatchManager` |
| 3 | Close the Loop | `src/core/FeatureMaturationPlanGate.mjs` |
| 4 | Observation Needs Structure | `src/monitoring/ApprenticeshipCycleStore.ts` |
| 5 | Autonomous Throughput Floor | `src/monitoring/AutonomousThroughputFloor.ts` |
| 6 | No Silent Degradation to Brittle Fallback | `IntelligenceRouter` |
| 7 | Intelligence Infers, Keywords Only Guard | `CoherenceGate` |
| 8 | Intelligent Prompts — An LLM Gate Must Not String-Ma | `MessagingToneGate` |
| 9 | Quantitative Claims Must Bind a Subject | `src/core/time-claim.ts` |
| 10 | Bounded Blast Radius | `SpawnCapIntelligenceProvider` |
| 11 | Capacity Safety — No Unbounded Self-Action | `SELF_ACTION_CONTROLLERS` |
| 12 | The Operator Channel Is Sacred — Critical-Path Gates | `MessageSentinel` |
| 13 | The Agent Is Always Reachable — A Guaranteed Reachab | `ResumeQueueDrainer` |
| 14 | An Autonomous Run Must Outlive Its Session | `GUARD_MANIFEST` |
| 15 | Iterative Audit to Convergence | `scripts/instar-dev-precommit.js` |
| 16 | Live-User-Channel Proof Before Done | `docs/specs/live-user-channel-proof-standard.md` |
| 17 | A Wall Is a Hypothesis | `B16_UNVERIFIED_WALL` |
| 18 | Never a False Blocker | `B17_FALSE_BLOCKER` |
| 19 | The Stop Reason Is the Work | `B18_AUTONOMY_STOP` |
| 20 | Self-Unblock Before Escalating | `AuthorityCheckEvidence` |
| 21 | Distrust Temporary Success — A Recurrence Is a Root  | `MessagingToneGate` |
| 22 | Verify the State, Not Its Symbol | `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` |
| 23 | Know Your Principal — An Unverified Identity Is a Gu | `UserManager` |
| 24 | Framework-Agnostic — and Framework-Optimizing | `ALLOWED_INJECTION_PROCESSES` |
| 25 | Cross-Machine Coherence — One Agent, Robust Under De | `FencedLease` |
| 26 | An Instar Agent Is Always a Multi-Machine Entity | `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` |
| 27 | Testing Integrity | `docs/E2E-TESTING-STANDARD.md` |
| 28 | Test Identity Never Enters Production State | `src/users/UserManager.ts` |
| 29 | Scrape/Parser Fixture Realness — feed the parser the | `docs/specs/scrape-fixture-realness.md` |
| 30 | Zero-Failure | `scripts/pre-push-smoke.mjs` |
| 31 | Expected Capacity Enforcement Is an Outcome, Not a D | `CapacityEnforcementResult` |
| 32 | Observable Intelligence — No Autonomous LLM Action I | `CircuitBreakingIntelligenceProvider` |
| 33 | A Refusal Stays a Refusal — conservation of negative | `src/core/SessionRouter.ts` |
| 34 | Runtime End-to-End Proof — the canary standard | `src/core/RopeRecoveryProber.ts` |
| 35 | Migration Parity | `scripts/protect-migration-guarantee.js` |
| 36 | Migration-Consumer Completeness | `docs/canonical-migration-contracts.json` |
| 37 | Canonical Pipeline Operational Completeness — Accept | `docs/canonical-pipelines.json` |
| 38 | Compaction Parity | `PostUpdateMigrator` |
| 39 | Tiered Development | `scripts/instar-dev-precommit.js` |
| 40 | Constitutional Traceability — No Unconstitutional Wo | `POST /spec/conformance-check` |
| 41 | Bounded Notification Surface — no feature may flood  | `AgentWorktreeDetector` |
| 42 | Notices Route to the Alerts Topic, Never a New One | `AttentionTopicGuard` |
| 43 | Conservative Outbound: Act, Don't Notify | `TelegramAdapter` |
| 44 | No Unbounded Loops — Every Repeating Behavior Carrie | `AgeKillBackoff` |
| 45 | Keep the Doorway/Model Map Current | `docs/LLM-ROUTING-REGISTRY.md` |
| 46 | Decision Provenance & Outcome Review | `docs/specs/ownership-gated-spawn-and-judgment-` |
| 47 | Stall Coverage Is Enumerated, Not Discovered | `IntelligenceFramework` |
| 48 | Maturation Path — Test Agent → Development Agent → F | `DARK_GATE_EXCLUSIONS` |
| 49 | A Dark Feature Guards Nothing | `POST /guards/:key/accept-fallback` |
| 50 | Token-Audit Completeness — An Unmetered LLM Call Is  | `scripts/lint-llm-attribution.js` |
| 51 | The User Experience Is the Product — Reachability, R | `MessagingToneGate` |
| 52 | No Manual Work (user *or* agent) | `docs/UX-AND-AGENT-AGENCY-STANDARD.md` |
| 53 | Mobile-Complete Operator Actions | `GET /permissions/users` |
| 54 | Operator-Surface Quality | `docs/STANDARDS-REGISTRY.md` |
| 55 | Dashboard UX Standard — Reachable, Self-Explanatory, | `docs/specs/dashboard-ux-standard.md` |
| 56 | Agent Proposes, Operator Approves | `AuthorizationRequestStore` |
| 57 | The Agent Carries the Loop | `B19_PARKED_ON_USER` |
| 58 | Agent Awareness | `src/server/CapabilityIndex.ts` |
| 59 | Signal vs. Authority | `docs/signal-vs-authority.md` |
| 60 | Self-Heal Before Notify — The Operator Hears Only Wh | `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` |

**Total: 68 leaves covering 82 standards.** Machine-readable form: `.instar/phase-a/level2-tree.json`.
