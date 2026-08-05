# Instar Constitutional Alignment — Phase B: The Remediation Tree

**Parent:** `ALIGNMENT-PLAN-ROOT.md` (ratified 2026-08-03) · `ALIGNMENT-PLAN-LEVEL1.md`
**Author:** Echo — Pathway (topic 29723), window seven
**Written:** 2026-08-05, from Phase A ground truth
**Status:** DRAFT — awaiting the ratified exit gate (multi-model plan review to 80/20 convergence)

---

## 0. What Phase A actually found, and why it changes the tree's shape

Phase A was chartered to find **absent** guards. It found **unevenly applied** ones. That single
correction determines this entire tree.

> **Where someone hit a failure and built structure in response, the structure is excellent — better
> than my own working practice. Where nobody has hit it yet, there is prose.**

Three times Phase A found the codebase *ahead of the auditor on method*: `lint-chain-completeness`
already names the exact failure class the phase existed to hunt; `standards-coverage-ratchet` carries
11 explicit negative controls that the auditor re-derived four hours later by making the mistake;
`reviewer-fail-closed-ratchet` injects a forced provider error on **every build** where the auditor's
equivalent happened once, by hand, and depended on remembering.

**Therefore the tree's organising principle is PROPAGATE PROVEN PATTERNS — never invent-guards-
everywhere.** Every build node below must name the *existing, injection-verified* pattern it extends.
A node that cannot name one is a design smell and must justify itself explicitly.

### The eight findings the tree is built from

| # | finding | evidence |
|---|---|---|
| F1 | **The failures are at the EDGES** — principles with unguarded perimeters, not absent principles | repo-side vs agent-side split; ratchet scope boundaries; a register checking presence not truth |
| F2 | **Leverage is propagation** — 5 patterns proven by injection | `COMPONENT_CATEGORY` declare-or-fail (1 register → 6 obligations, no default); lint-chain-completeness; B-case controls; forced-error injection; shrink-only pending sets |
| F3 | **64 of 90 runtime guards are unaskable** — the gap is MEASUREMENT, not brokenness | counter-method sweep; `{looked, wouldAct, didAct}` proven on 8 guards |
| F4 | **Positional ceiling** — 10 of 27 non-lint guards cannot be tested from an agent workstation | need a PR description, CI event payload, staged diff, or release moment |
| F5 | **8 of 16 leaves are `unmeasured`, not `false`** — the guard never had an opportunity | settling them requires a staged violation → a harness that does not exist |
| F6 | **Load-bearing gaps DIFFER per machine** — a fleet-wide verdict would be wrong about both | `orphanedWorkSentinel` blind on Mini, OFF on laptop; laptop `resumeQueue` off-runtime-divergent |
| F7 | **The audit's dominant risk was the auditor's own error rate** — 12 false results, 0 genuine guard failures by injection; 6 retractions in 90 min | 3 were repeats of lessons already written down |
| F8 | **Live faults with measured harm** | interactive-pool argv ceiling (100% of 23 sends); memory threshold mismatch; `CrashLoopPauser` never constructed while 21 jobs ran away (top 477 consecutive) |

### The one thing Phase A asked to have decided

> *"Either the scope is 'the enforcement tiers an agent workstation can observe' — much of which is
> genuinely done, with the remainder named — or the scope is the whole system, which needs CI access
> and the `{looked, wouldAct, didAct}` schema change before another hour of sweeping is worth
> spending."*

**Ruled (operator, window-seven charter): the whole system. The schema change goes first.** B0 is the
answer to that question, and it is why B0 precedes everything.

---

## 1. Node contract (inherited, binding at every depth)

1. **Scope + measurable exit + derived status.** Status is DERIVED from child evidence at read time —
   never asserted, never cached.
2. **80/20 leaf sizing.** Not single-session-completable → not a leaf → split it.
3. **Convergence-gated completion.** A node completes only when a re-sweep of its full scope finds
   zero new. Judged intelligently (fundamentals vs echoes), never by a fixed round count.
4. **Three-rung verdict.** EXISTS → WIRED → EFFECTIVE. Only rung three is aligned; one and two are
   findings.
5. **Anti-decay.** Every verdict carries source + timestamp; any claim consuming a verdict re-measures
   at claim time.
6. **Node journals.** Append-only: examined / found / decided (and why) / **what surprised it**.
7. **Per-machine truth (Phase A amendment).** `aligned` requires `effective` on **every machine on the
   node's critical path**. F6 demonstrated this rather than argued it.

### Execution-lane rule (operator standing policy, 2026-08-04)

**Execution work — schema implementation, node builds, sweeps — routes to Codey and parallel Codex
lanes by default**, placed on whichever machine has memory headroom, laptop-first while Codey's Mini
conversational-spawn fault is open. **Claude sessions hold the manager, reviewer, and collaborator
seats.** This is designed into the lanes below from the start, not retrofitted.

---

## 2. The tree

Ordering principle for a *remediation* tree: **a branch whose completion unblocks other branches goes
earlier** (the mirror of Phase A's downstream-effect ordering).

```
Phase B — Remediation
├── B0  MAKE THE SYSTEM ASKABLE          [prerequisite — everything downstream cites it]
├── B1  CLOSE THE PERIMETERS             [F1 — the dominant finding]
├── B2  PROPAGATE THE PROVEN PATTERNS    [F2 — the leverage]
├── B3  BUILD WHAT IS CLASSIFIED BUT ABSENT
├── B4  CROSS-MACHINE ALIGNMENT          [F6 — the amendment]
├── B5  LIVE FAULTS WITH MEASURED HARM   [F8]
└── B6  MAKE THE METHOD DURABLE          [F7 — the meta-finding]
```

---

### B0 — MAKE THE SYSTEM ASKABLE

**Scope:** the measurement surface every later verdict rests on.
**Why first:** 64 of 90 runtime guards cannot currently be asked whether they work. Phase A's §15
states plainly that further sweeping is not worth spending until this lands.

⚠️ **ORDERING CORRECTED 2026-08-05 — B0.5 now precedes B0.1.** The adversarial review and the
conformance gate independently converged on the same dependency: **a counter proves a guard is
instrumented; only a staged violation proves the counter is honest.** Shipping the schema first would
produce 72 guards reporting numbers nobody can trust — strictly worse than today, because the numbers
would carry an unearned appearance of rigour. The harness is a **prerequisite**, not a follow-on.

**This was the tree's first structural error, and it was found by review rather than by planning** —
which is the argument for the exit gate being an adversarial pass rather than a self-check.
**Branch exit:** every guard in the `/guards` inventory answers `{looked, wouldAct, didAct}` or is
explicitly classified `unknown` with a named reason — and the ambiguous-zero class is empty.

| node | scope | measurable exit | lane |
|---|---|---|---|
| **B0.1 — the `{looked, wouldAct, didAct}` schema** ⭐ FIRST BUILD ITEM | every guard inventory row gains the three counters | a guard with 0/3 or 2/3 counters fails a lint; `/guards` rows carry the triple; control run proves the lint bites AND allows the compliant form | build → Codex lane; spec + review → me |
| **B0.2 — counter-surface census** | which guards expose which counters TODAY | a machine-readable row per guard with `evidence: file:line`; `partial` class explicitly flagged | Codex lane (**IN FLIGHT**, laptop) |
| **B0.3 — health-window honesty** | readouts that cannot distinguish "broken now" from "was broken, fixed" | `/health` llmReliability distinguishes current from historical; a fixed component stops reporting `failing` within one window | build → Codex lane |
| **B0.4 — positional-ceiling resolution** | the 10 guards untestable from a workstation | a DECISION artifact: CI-side observation, or scope explicitly narrowed and recorded | **operator/architect decision — not a build** |
| **B0.5 — staged-violation harness** | the 8 `unmeasured` leaves | a throwaway agent + demo channel that can stage a violation on demand; one previously-unmeasured leaf settled through it | build → Codex lane |

**B0.3 is a live finding, not a hypothetical.** At 03:35Z Codey's Mini `/health` reported
`PromptGate failing, 90.7% error rate`. Narrow-window measurement showed **0 errors in the last hour,
all 32 errors predating a repair that had already landed**. An instrument that keeps reporting a
solved fault for hours will cause exactly the wrong escalation — and nearly did.

---

### B1 — CLOSE THE PERIMETERS  *(F1 — the dominant finding)*

**Scope:** standards that are rigorously enforced on one surface and freely violable on another.
**The general form:** *repo-side and agent-side surfaces are enforced by SEPARATE machinery with no
bridge. A standard can be rigorously enforced in one and freely violated in the other, and each side
looks clean from inside itself.*
**Branch exit:** for every standard with a named guard, the guard's scope is measured against the
standard's actual surface area, and every uncovered surface is either covered or recorded as a
deliberate, justified exclusion.

| node | scope | measurable exit | pattern extended |
|---|---|---|---|
| **B1.1 — repo↔agent enforcement bridge** | the general form; both known instances are symptoms | a scope-coverage check that fails when a standard's guard scope excludes a surface where the standard applies | *(new — must justify; see §3 risk)* |
| **B1.2 — grounding-gate keyword matcher** | 6 literal phrases `grep -qiE`'d to BLOCK a send | the matcher no longer holds blocking authority with brittle logic; measured precision reported | Signal-vs-Authority (existing doctrine) |
| **B1.3 — use vs mention** | grounding gate + `dangerous-command-guard` share one blind spot | both distinguish *using* a phrase from *talking about* one; blast-radius asymmetry recorded | Intelligence-Infers-Keywords-Only-Guard ratchet |
| **B1.4 — `NOT_A_GUARD` presence-vs-truth** | register validates a reason EXISTS (≥12 chars), never that it is TRUE | declared value validated against a closed set; an out-of-set value is rejected | closed-set validation, **already proven on two other guards** |

**Measured harm at B1.2/B1.3 (why this branch is not theoretical):** 11–13 blocks in one night,
**precision 15–25% and falling at every re-measurement**. Four fired on phrases appearing only
*inside a quotation*, including one on the message documenting the defect. The false blocks cost
meaning-preserving rewrites — **which trains an agent to route around the check rather than read it.**

---

### B2 — PROPAGATE THE PROVEN PATTERNS  *(F2 — the leverage)*

**Scope:** five patterns verified by injection in Phase A, each currently applied to a subset.
**Branch exit:** for each pattern, the full population where it *should* apply is enumerated, and
every member either has it or carries a recorded exemption.

| node | pattern (proven) | propagation question | measurable exit |
|---|---|---|---|
| **B2.1 — declare-or-fail** | one `COMPONENT_CATEGORY` key → **six** independent ratchets, **no default on any** | which other registers carry an obligation *with* a default? | every register enumerated; each has no-default or a recorded reason |
| **B2.2 — the B-case** | `standards-coverage-ratchet` carries 11 explicit negative controls | which rung-3 claims lack a negative control? | no guard claims EFFECTIVE without a control proving it ALLOWS the compliant form |
| **B2.3 — forced-error injection** | `reviewer-fail-closed-ratchet` injects a provider error every build | which fail-closed paths are never exercised? | each fail-closed path exercised on every build, not by hand |
| **B2.4 — shrink-only + owner** | `durable-output-chokepoint-ratchet`: pending items carry an owner; the set may only shrink | which pending/deferred sets can grow silently? | every durable pending set is shrink-only and owner-bearing |

**B2.2 is load-bearing for the whole audit.** Phase A adopted the B-case rule mid-phase and
**downgraded three of its own earlier passes to provisional** on discovering they lacked one. A catch
without a negative control cannot be distinguished from a guard that rejects everything.

---

### B3 — BUILD WHAT IS CLASSIFIED BUT ABSENT

| node | scope | measurable exit |
|---|---|---|
| **B3.1 — `CrashLoopPauser`** | classified in the guard manifest; **never constructed** (control passed) while 21 jobs failed, top **477 consecutive**, none paused | constructed, wired, and demonstrated pausing a seeded crash-loop; its manifest exclusion reason removed |

**Why this is one node and not a branch:** Phase A called it *"the one clean buildable gap"*. It is
also the sharpest illustration of B1.4 — it stayed invisible to the audit because its exclusion
rationale **asserts an observability that does not hold**, and `lint-guard-manifest` checks that a
reason EXISTS, never that it is TRUE. **Fixing B1.4 is what prevents the next `CrashLoopPauser`.**

---

### B4 — CROSS-MACHINE ALIGNMENT  *(F6 — the amendment, measured)*

**Branch exit:** every node's verdict carries a per-machine breakdown; no node claims `aligned` on a
single machine's evidence.

| node | scope | measurable exit |
|---|---|---|
| **B4.1 — version parity** | laptop ran 2 versions behind the Mini for the whole of Phase A | both machines on the same version, or the skew is surfaced automatically at verdict time |
| **B4.2 — laptop `resumeQueue` off-runtime-divergent** | an autonomous run interrupted there is **not revived**; the guard self-reports exactly as designed and nobody had looked | posture reconciled; the divergence class raises an item rather than waiting to be noticed |
| **B4.3 — per-machine verdict discipline** | the ledger currently holds Mini-only rows | ledger schema requires a per-machine cell; a single-machine row cannot render as `aligned` |

Posture at Phase A close — **the amendment's premise demonstrated, not argued**:

| | Mini | Laptop |
|---|---|---|
| missing | 0 | **2** |
| off-runtime-divergent | 0 | **1** |
| on-confirmed | **20** | 18 |
| on-unverified | 40 | **48** |

---

### B5 — LIVE FAULTS WITH MEASURED HARM  *(F8)*

**Branch exit:** each fault is fixed with a control run, or explicitly parked with its harm stated.

| node | fault | status |
|---|---|---|
| **B5.1 — interactive-pool argv ceiling** | every pool prompt is **2.5× over the ~16KB `tmux send-keys` argv limit** (skeleton alone 40,049B; ceiling measured ~16,256B). 23 sends, 23 failures, 100% | **remedy PROVEN at real size** — `load-buffer`+`paste-buffer` delivered 40KB and 200KB where the current path failed. One function at the send site. Not started. |
| **B5.2 — memory threshold mismatch** | spawn gate refuses at `free<25%`; the reaper calls the same reading `normal` until `free<12%` | will throttle the machine again on the next tight period |
| **B5.3 — headless `claude -p` in agent home** | hangs >150s; 4s from a clean dir | **characterized, cause UNPROVEN.** An INVESTIGATION node — must not be written as a build node |

**B5.1 carries an independent confirming case** that was not constructed for the purpose: Codey runs
the same codebase, same version, same physical machine, in a *different mode*, and shows **zero**
occurrences of the signature against the Pathway session's 23 failures.

---

### B6 — MAKE THE METHOD DURABLE  *(F7 — the meta-finding)*

**Scope:** the audit's dominant risk was the auditor's own error rate — and three of the twelve false
results were **repeats of lessons already written down**. A lesson that must be remembered is not
applied.

**Branch exit:** each standing rule adopted during Phase A is enforced by structure rather than by the
auditor's memory.

| node | rule adopted mid-Phase-A | structural form |
|---|---|---|
| **B6.1 — B-case mandatory** | a catch without a negative control proves nothing | folded into B2.2 — a rung-3 claim without a control is refused |
| **B6.2 — keyword classification is a search aid, never a finding** | keyword bucketing failed twice, in both directions (undercounted a class 4.5×; nearly invented a problem in the strongest guards) | a classification derived from keywords cannot be cited as evidence in a verdict row |
| **B6.3 — machine-stamped times** | 7+ journal timestamps were fabricated by hand before `jlog.sh` | already structural; verify it cannot be bypassed |
| **B6.4 — a lint that looks broken is mis-invoked until proven otherwise** | cost hours across three separate incidents | the invocation must be read from source before a lint is called broken |

**This branch is the self-hosting test.** Phase A's headline was that Instar's *built* structures
outperform its *written* ones. B6 asks whether that is true of the audit method itself — and the
honest answer today is no: the method lives in a document.

---

## 3. Known risks in this tree (stated for the reviewers, not defended)

1. **B1.1 is the only node that cannot name an existing proven pattern it extends.** By this tree's
   own organising principle that is a smell. It may be that the bridge should be a *scope-coverage
   obligation* on the existing declare-or-fail register (B2.1) rather than new machinery — which
   would fold B1.1 into B2 entirely. **Flagged for the multi-model review to resolve, not decided here.**
2. **B0.4 is a decision node in a build tree.** It is the architect's/operator's call, and no
   downstream node should be sized until it is answered — B0.5's cost in particular depends on it.
3. **Branch sizing is uneven.** B3 holds one node; B0 holds five. That may be honest (the findings are
   uneven) or may mean B3 belongs inside B1 as the worked example of B1.4.
4. **The tree inherits Phase A's coverage bound.** 433 GET routes exist; ~40 were examined. Every
   count in §0 is a floor, not a total, and the census (B0.2) will move several of them.
5. **B5 is arguably not remediation at all** — three unrelated live faults parked in one branch
   because they share a property (measured harm) rather than a cause. A reviewer may reasonably say
   they belong outside the alignment tree entirely.

---

## 4. What happens next

1. **B0.1 spec** → `/spec-converge` → operator pre-approval → build under full `/instar-dev`
   discipline with a control run → PR **held** for pre-approval. *(charter's first build item)*
2. **B0.2 census** lands from the Codex lane and makes F3's "64 unaskable" precise.
3. **Exit gate:** this tree goes through multi-model plan review to 80/20 convergence, per the
   ratified Phase B exit condition. §3 exists to give that review its starting targets.

**Every workstream in window seven maps to a node above, or is named out loud as substrate or weeds.**

---

## Appendix — B0.2 census result (landed 2026-08-05 ~03:54Z)

A Codex execution lane surveyed the guard population against current source
(v1.3.1126, head `2197591`) and classified each guard's counter surface:

| class | count | meaning |
|---|---|---|
| **full** | **4** | all three counters present — verifiable today |
| **partial** | **7** | 1–2 counters — **the dangerous class** |
| **none** | **62** | no counters at all |
| **unknown** | **7** | honestly undetermined |
| total | **80** | |

**This sharpens F3 considerably.** Phase A's "20 of 90 verifiable" counted guards verified by any
means (including hand-run injection). Measured purely on *self-service counter surface*, the number is
**4 of 80**.

**The partials are the finding, not the zeros.** Examples read from source:

| guard | looked | wouldAct | didAct |
|---|---|---|---|
| `monitoring.sessionReaper` | **—** | `sessions[].verdict` | `reapsLastHour` |
| `monitoring.orphanedWorkSentinel` | **—** | `orphanedCount` | **—** |
| `monitoring.agentWorktreeReaper` | **—** | `reclaimable` | `reapedLastPass` |
| `monitoring.mcpProcessReaper` | **—** | `reapEligible` | `reapedLastPass` |
| `monitoring.completionClaimVerification` | `stats.candidateTurns` | `stats.flaggedTurns` | **—** |
| `intelligence.testRunnerCap` | **—** | `skipHistogram` | **—** |

`sessionReaper` reporting `reapsLastHour: 0` is indistinguishable from a reaper that never evaluated a
session — which is precisely Phase A's "two of three is worse than none", now with named instances.

**Denominator caveat, stated:** the census counted **80** guards; Phase A's runtime tier was **90**, and
`GUARD_MANIFEST` holds **72** entries. These three populations are drawn differently and have not been
reconciled. **No total in this appendix should be treated as the authoritative guard count** until that
reconciliation is done — it is a tracked item under B0.2, not a rounding difference to wave away.


---

## Dependency re-analysis (2026-08-05, after the B0.1 review)

The adversarial review found **one** ordering error in this tree (B0.5 before B0.1). That prompted the
obvious question — *was it isolated?* — and it was not. Applying the same lens to every node:

**The question that exposes it:** *"to claim this node is DONE, what must be staged?"*

| node | needs a staged violation to verify? | consequence |
|---|---|---|
| **B0.1** schema | **YES** — a counter proves instrumentation, not honesty | already reordered |
| **B2.2** B-case propagation | **PARTLY** — cheap for lints (inject a file); needs the harness for every RUNTIME guard | runtime half blocked on B0.5 |
| **B3.1** `CrashLoopPauser` | **YES** — "constructed" is not "works"; proving it pauses a runaway job means staging a crash-loop | blocked on B0.5 |
| **B1.2 / B1.3** grounding gate, use-vs-mention | **NO** — harm is already measured (precision 15–25% from live blocks) | independent, can proceed |
| **B1.1** repo↔agent bridge | **NO** — a scope-coverage comparison is static | independent |
| **B4.x** cross-machine | **NO** — posture is directly readable per machine | independent |

> ### B0.5 is the tree's SPINE, not one of its nodes.
> Three branches cannot make a DONE claim without it. It was drawn as a peer node sitting in B0
> alongside four others, which understated it badly — and that mis-drawing is exactly what let B0.1 be
> scheduled ahead of it.

### And a second error the review's lesson exposes — in B1.4

**B1.4's stated remedy is already known to be insufficient.** The node says: fix `NOT_A_GUARD`'s
presence-vs-truth defect by *"applying closed-set validation, proven on two other guards."*

**The B0.1 design arc refuted precisely that.** A closed set was version 2 of seven, and it fell for the
same reason all the others did: the author still picks the member. Writing this node's remedy before
that arc happened means **B1.4 currently prescribes a fix this project has since disproved.**

Corrected framing for B1.4: the remedy is not a stronger validator over an author-supplied reason — it
is to change **who produces the claim**, or to accept that the claim is unverifiable and make *that*
visible. The concrete design is deliberately left open rather than re-guessed here.

> **The general lesson for this tree:** a remediation node written before its own domain was
> investigated will tend to prescribe the FIRST plausible fix. Two of ~20 nodes did. Every remaining
> node's stated remedy should be treated as a **hypothesis**, not a plan — and the exit gate's
> adversarial pass is what converts one into the other.

### B1.4 — a corrected direction (grounded, 2026-08-05)

Having refuted B1.4's original "apply closed-set validation" remedy, here is what the same
change-the-producer lens yields instead. Two parts, and the difference between them matters.

**Part 1 — the contradiction check (cheap, real, and available today).**
Verified by control: `NOT_A_GUARD` appears in 4 source files, and **nothing anywhere cross-references
it against the live `GuardRegistry`.** But a component classified "not a guard" that **registers a
guard runtime getter** is a *self-contradiction the system can detect without asking the author* —
`GuardRegistry.registeredKeys()` already exposes exactly what is needed
(`src/monitoring/GuardRegistry.ts:53`).

This is producer-independent: the claim is the author's, the contradicting evidence is the running
system's.

**⚠️ And it would NOT have caught `CrashLoopPauser`** — the incident that motivates the whole branch.
That component was *never constructed*, so it registers nothing, so there is nothing to contradict.
**Stating this plainly because a check that misses its own motivating case must not be presented as the
fix.** It closes a different, real hole; it does not close that one.

**Part 2 — what would actually close it: make the reason a PREDICATE, not prose.**
`CrashLoopPauser` hid because its exclusion rationale *asserted an observability that did not hold*,
and prose cannot be tested. The fix is not a stronger validator over a sentence — every version of that
was refuted in the B0.1 arc. It is to change **what the author produces**: an exemption declares a
*machine-evaluable predicate* ("this component is observable at X, and X reports Y"), which the system
then evaluates. **When the reason IS a test, "the reason is present" and "the reason is true" stop
being different questions** — which is the property this entire branch has been trying to buy.

Part 2 is the real remedy and is **not yet designed**. It is recorded as a direction with its rationale,
not scheduled as a plan, because that is the honest state.

---

## F9 — a ninth finding, discovered while scoping B0.5 (2026-08-05)

### We have no record of our guards deciding anything

Scoping the staged-violation harness, I bounded it to guards whose test case could be derived from a
**recorded incident** — the most trustworthy source available. Then I measured the corpus. All 26
non-empty JSONL logs, control passed (8,600 hits for a term known present):

| FUNNEL guard | incident records |
|---|---:|
| `models.tierEscalation` | **2** |
| the other eight | **0** |

**Eight of nine have nothing.** *(The first pass reported 1,141 for `tierEscalation` via a loose
substring; 1,139 were false positives. Fourth keyword failure of this audit — the strict/loose
comparison caught it.)*

**What the corpus actually contains is operational history** — reaps, sentinel transitions, posture
changes, restarts. Rich, and about *what the system did*. **It contains almost nothing about guards
evaluating anything**, because guards do not record their evaluations. That is the same absence this
entire phase is about, and I found it in the place I went looking for evidence *of* it.

### Why this is a tree-level finding, not a harness detail

It is the **empirical confirmation of F3**, arrived at independently. F3 said 62–64 guards are
unaskable because they expose no counters. F9 says: *and there is no historical record either* — so
there is no back door. You cannot reconstruct guard effectiveness from logs after the fact, because the
logs never contained it.

**Consequences that belong to the tree, not to one node:**

1. **B0.5's A-cases must come from specifications, not history.** Weaker, and now unavoidable. The
   harness spec states it as the weakness it is rather than dressing it up.
2. **The harness's own output becomes the corpus that does not exist.** First verification is derived
   from a description; subsequent ones need not be. That makes B0.5 self-improving in a way the tree
   did not anticipate — and slightly raises its value relative to B0.1.
3. **Any future node proposing to "analyse guard behaviour from the logs" is unbuildable as written.**
   Recorded here so it is refuted once, at the tree, rather than rediscovered per node.

> **The cost of finding this was about three minutes of grep.** The cost of not finding it would have
> been a harness scoped to a corpus that does not exist — discovered during implementation. This is the
> "check the premise before building" rule paying for itself, and it is the second time in this window
> a scope decision I had already written down was refuted by one cheap measurement.

---

## PROPOSED AMENDMENT to the ratified node contract (needs the architect's decision)

**This is a change to something Justin ratified on 2026-08-03, so it is proposed here, not adopted.**

The node contract's rule 4 defines the guard verdict as three rungs:

> EXISTS → WIRED → **EFFECTIVE**. *Only rung three is "aligned"; rungs one and two are findings.*

**Tonight's B1.2 measurement found a guard that does not fit.** The grounding gate:

- caught **2 of 2** genuine faults — it bites, correctly, on what it targets;
- blocked **3 of 5** honest messages — including the conclusion of a measurement and an in-session
  tool observation.

**By the three-rung model this guard is EFFECTIVE, which means ALIGNED.** It is not aligned. It is
actively costing correct work and training the agent to route around it.

### The gap

The ladder measures only whether a guard **acts when it should**. It has no cell for whether a guard
**refrains when it should** — and a guard is a two-sided instrument. A rung-3 verdict obtained from an
A-case alone certifies half of a guard and reads as certifying all of it.

**This is the same shape as everything else this phase has found**: a check whose passing condition is
narrower than what it certifies.

### The proposed amendment — one rung becomes two axes

| | acts when it should | refrains when it should |
|---|---|---|
| **yes / yes** | **aligned** | |
| **yes / no** | `over-blocks` — effective AND harmful | |
| **no / yes** | `inert` — the current "not effective" | |
| **no / no** | broken in both directions | |

Rungs one and two (EXISTS, WIRED) are unchanged. Only rung three splits, and the B-case — already
mandatory in practice since Phase A adopted it mid-audit — becomes the thing that supplies the second
axis rather than an informal quality bar.

**Cost of not amending:** every `effective` verdict this phase produces means "acts when it should,
and nobody checked the other half." Since Phase A already downgraded three of its own verdicts for
exactly this, the model is behind its own practice.

**This is the architect's call.** Recorded with its evidence rather than adopted.

---

## Node-premise validation pass (2026-08-05) — 4 of ~20 nodes were already wrong

Acting on "every remaining remedy is a hypothesis," I checked the tree's own node premises against live
state. **Four of roughly twenty do not survive**, and they fail in three distinct ways worth
distinguishing.

| node | premise as written | status |
|---|---|---|
| B0.1 ordering | schema before harness | **wrong** — harness is a prerequisite |
| B1.4 remedy | "apply closed-set validation" | **disproved** by the B0.1 design arc |
| **B4.1** | "the laptop is 2 versions behind" | **STALE** — both machines on 1.3.1126 |
| **B4.2** | "laptop `resumeQueue` is off-runtime-divergent" | **STALE** — now `on-confirmed`, `divergence: none` |

### The new failure mode: a node built from a TRANSIENT state

B4.1 and B4.2 were not fixed by any plan action. **They self-resolved** — an update propagated, a
restart reconciled a posture. Phase A measured the laptop at one moment; by the time the tree was
written the moment had passed.

> **A remediation tree that captures transient state as structural problem manufactures work that does
> not exist.** Two of its twenty nodes were obsolete within hours of being written, and nobody would
> have discovered that until someone was assigned to "fix" a machine that was already fine.

**Nodes must therefore declare whether their premise is STRUCTURAL or TRANSIENT:**

- **Structural** — persists until deliberately changed *(guards have no counters; a register checks
  presence not truth)*. Safe to plan against.
- **Transient** — a snapshot of live state that may self-heal *(version skew, a runtime divergence, a
  quota level)*. **Must be re-measured at the moment of scheduling**, never planned against directly.

Every node in this tree should carry that label. The four B4.x nodes are transient; most of B0/B1/B2
are structural.

### ⚠️ A near-miss that belongs in the record

Checking B4.2, I found the laptop's `scheduler.enabled` in state **`missing`** — enabled in config,
never registered at runtime — with **zero jobs, zero "Scheduler started" markers, and no activity log.**
That reads unambiguously as *the laptop's scheduler is dead and jobs silently do not run there.*

**It is not.** The Mini holds the serving lease (`holdsLease: true`, 42 jobs, 4 scheduler starts); the
laptop is standby, and jobs run on the lease holder only. **The laptop having no scheduler is correct
behaviour.**

I was one step from filing a false defect against healthy infrastructure. The control that caught it
was checking *whether the thing is supposed to be running* before calling it dead.

**And that makes `missing` itself a finding.** The state conflates two conditions:

| reality | current state | correct reading |
|---|---|---|
| enabled, should be running, isn't | `missing` | a genuine anomaly |
| enabled, correctly not running because this machine is standby | `missing` | **normal** |

`missing` certifies "anomaly" while measuring "not registered." **That is the same defect this entire
phase keeps finding — a condition narrower than what it certifies — now in the guard-posture surface
itself, and it produces false alarms on every standby machine in the fleet.** Filed as a new node
under B0 (instrument truth), where it belongs.

### B2.1 premise — CONFIRMED, with a named second instance

B2.1 asks: *which other registers carry an obligation with a weak or absent check?* The answer is at
least one, and it is the same defect that hid `CrashLoopPauser`.

**`COHERENCE_MANIFEST_EXCLUSIONS`** (`src/core/machineCoherenceManifest.ts:274`) — 24 entries, each
`{ configPath, reason }`, declaring which multi-machine flags are deliberately outside coherence
checking. Structurally identical to `NOT_A_GUARD`. Its only enforcement
(`tests/unit/machine-coherence-manifest.test.ts:129-131`):

```js
for (const e of COHERENCE_MANIFEST_EXCLUSIONS) {
  expect(e.reason.length).toBeGreaterThan(20);
}
```

| register | the check | what passes it |
|---|---|---|
| `NOT_A_GUARD` | reason ≥ 12 **non-whitespace** chars | any 12 characters |
| `COHERENCE_MANIFEST_EXCLUSIONS` | `reason.length > 20` — **raw** length | **21 spaces** |

**The second is strictly weaker than the first**, because dropping the non-whitespace normalisation
means pure whitespace satisfies it.

**Credit where due:** the 24 reasons currently in that list are *good* — 45 to 248 characters, mean 106,
each arguing specifically why its exclusion is correct (*"receive-only by default + per-machine sealed
keys; a non-receiver simply re-enters a secret, no silent data-loss"*). **The content is not the
problem. The absence of anything that would notice if it stopped being good is.**

> **This is the whole phase in one comparison.** Two registers, same architecture, same obligation, both
> checking that a justification is *long* and neither checking that it is *true* — and the one incident
> we know about (a guard classified and never built) came through exactly this door. Where someone hit a
> failure they built well; where nobody has hit it yet, there is a length check.

**Verified with controls:** `NOT_A_GUARD` resolves in 6 files vs this register's 2, confirming the
search works and the sparse referencing is real, not a missed grep.

**Node status: B2.1 is LIVE** (unlike B4.1/B4.2, whose premises were stale). Its remedy must NOT be
"add a closed set" — that was refuted in the B0.1 arc. The direction is the same as B1.4's: change what
the author produces, or make the claim machine-evaluable.

---

# SYNTHESIS — these are not seven defects. They are one defect, seven times.

Every substantive finding of this window has the identical shape. Setting them side by side is the most
useful thing produced tonight, because it changes what the remediation should be.

| # | surface | what it MEASURES | what it CERTIFIES | the gap |
|---|---|---|---|---|
| 1 | `NOT_A_GUARD.reason` | ≥12 non-whitespace chars | "this exclusion is justified" | any 12 characters |
| 2 | `COHERENCE_MANIFEST_EXCLUSIONS.reason` | `.length > 20` (raw) | "this exclusion is justified" | **21 spaces** |
| 3 | `/guards` → `missing` | no runtime getter registered | "should be running, isn't" | every standby machine |
| 4 | three-rung `effective` | acts when it should | "aligned" | never asks if it *refrains* |
| 5 | B0.1 v1 counter paths | a counter exists at a path | "this guard is instrumented" | borrow any positive number |
| 6 | `enforcedRatio: 72%` | a ref of that shape resolves | "the standard is enforced" | ref ≠ running, asserting, or in CI |
| 7 | `/health` `llmReliability` | error rate over a 6h window | "this component is failing **now**" | a fix inside the window |

**One sentence, seven times: the passing condition is narrower than what the result certifies.**

And they are not clustered in one subsystem — they span **verification** (1, 2, 5), **alerting** (3, 7),
**classification** (4), and **reporting** (6). A defect that appears independently across four unrelated
surfaces is not a series of mistakes. **It is the default failure mode of the way we build checks**, and
it recurs because writing a check that measures the easy proxy is always cheaper than writing one that
measures the claim.

## What this changes about the remediation

**Fixing seven things individually is the wrong response**, and this tree originally proposed roughly
that. Two consequences:

1. **The remedy is a STANDARD, not seven patches.** Something of the form: *a check must state what it
   measures and what it certifies, and the two must be argued equal.* Instar already has the enforcement
   vocabulary for this — the spec-converge gate flagged exactly this class against my own spec five
   times tonight, under *Verify the State, Not Its Symbol*. **The standard exists; what is missing is
   its application to CHECKS themselves rather than to features.**

2. **The B-case is the general antidote, and it is already proven.** Every one of the seven would have
   been caught at authoring time by asking *"what input passes this check while failing the claim?"* —
   which is precisely the negative control Phase A adopted mid-audit and `standards-coverage-ratchet`
   already carries eleven of. **This is a propagation target, not an invention** — exactly the framing
   the charter set.

> **The honest reframing of Phase B:** the problem was never that Instar lacks guards. It is that a
> guard's *passing condition* is written by the same person, at the same moment, under the same
> assumptions as the guard itself — so the check inherits the author's blind spot by construction.
>
> **Everything that worked tonight worked by breaking that coupling**: an adversarial reader who did not
> write the design, a control the author had to run against their own search, a B-case that asks what
> passes-while-failing. **Not more care. A different producer.**

That is the same conclusion the B0.1 design arc reached after seven attempts, arrived at independently
from the finding set — which is the strongest evidence available that it is the right one.

---

## B5 — GUARD-INVOCATION RE-ARCHITECTURE (new branch, created by ruling at window-7 cycle 1)

**Created:** 2026-08-05, by operator ruling on the B0.1 fork. **Status: named, unscoped, not started.**

**Scope.** Move guard families onto shared invocation chokepoints, so a caller outside the guard can
count that it looked. Today 28 of 72 guards have such a caller; this branch is how that number grows.

**Why it is its own branch and not a task inside B0.1.** It changes **how Instar runs guards**, not how
it describes them. The ruling was explicit that this earns the plan's full discipline — its own spec
through complete multi-model review — rather than being settled inside another node's design pass.

**Relationship to B0.1 — they compose, and the ordering matters:**

- B0.1 under ruling (a) applies the schema to the **28** and reports the **44** as
  `unverifiable-by-construction` with individually named reasons
  (`docs/audits/phase-b/guard-verifiability-28-and-44.md`).
- **Nothing in (a) forecloses (b).** A guard moved onto a chokepoint by this branch simply changes
  invocation class and becomes adoptable. **The 28 is a floor, not a ceiling.**
- Each of the 44 rows is a candidate for this branch, and its `class` column is the difficulty estimate:
  **SELF-DRIVEN (26)** needs an external tick owner; **EVENT-DRIVEN (16)** needs a funnel that does not
  yet exist; **UNKNOWN (2)** needs its invocation path determined first.

**Premise class: STRUCTURAL.** Unlike B4.1/B4.2, this does not self-resolve — a guard that owns its own
timer will own it until someone deliberately changes that.

**Known coupling, recorded so it is scheduled once rather than twice:** B0.5's reach is bounded by this
branch. The 26 SELF-DRIVEN guards cannot be staged against either, so the harness and the
re-architecture cover the same population. Tracked as `ACT-1755` (re-surfaces 2026-08-26).

**Explicitly not designed here.** Naming a branch is not scoping it, and this tree has already been
caught twice prescribing the first plausible remedy for a node whose domain nobody had investigated.

### B2.4 premise — REFUTED. The pattern is already saturated.

B2.4 proposed propagating the shrink-only pending-set discipline (*"which pending sets can grow
silently?"*). Measured against source:

| population | shrink-only? |
|---|---|
| lint baselines (`BASELINE` constants in `scripts/*.js`) | **4 of 4** |
| ratchet tests (`tests/unit/*ratchet*.ts`) | **8 of 8** |

**Every baseline in the codebase already ratchets down.** One of them (`lint-rollout-evidence-resolvable.js`)
records in its own comments that its baseline reached **empty** *"the way the design intended:
shrink-only."*

**So B2.4 has no propagation target left in this domain** and should be closed rather than scheduled.
That is node **five** of roughly twenty whose premise does not survive contact with the code:

| node | premise | fate |
|---|---|---|
| B0.1 ordering | schema before harness | wrong — harness is prerequisite |
| B1.4 remedy | "apply closed-set validation" | disproved by the B0.1 arc |
| B4.1 | laptop 2 versions behind | stale — self-resolved |
| B4.2 | laptop resumeQueue divergent | stale — self-resolved |
| **B2.4** | **pending sets can grow silently** | **refuted — already saturated** |

**Five of twenty. The tree was 25% wrong within a day of being written**, and every single error was
found by a cheap check rather than by planning. The pattern in the failures is consistent: **a node
written before its domain was investigated proposes work that is already done, already impossible, or
already obsolete.**

This is the strongest argument available for the rule the tree adopted mid-window — *every remaining
remedy is a hypothesis until measured* — and for spending the cheap check before the expensive build.

### B2.3 premise — LIVE, but the node asks the wrong question

B2.3 was written as *"which fail-closed paths are never exercised?"* That question is unbounded: 129
source files reference fail-closed behaviour, and deciding per path whether its test truly injects a
failure (rather than merely mentioning one) is exactly the per-item judgment that has burned this audit
four times by keyword.

**The proven pattern is narrower and better than the node assumed.** `reviewer-fail-closed-ratchet.test.ts`
does not spot-check paths — it **enumerates a complete population and injects into every member**:

> *"This ratchet drives every registered reviewer through a forced error and fails the build if any
> returns a verdict without the abstain tag — so a future reviewer (or a future override) cannot
> silently reintroduce the fail-open this work removed."*

Two properties make it strong, and both are about **population**, not paths:

1. **It is exhaustive over a named set** — every registered reviewer, discovered rather than listed.
2. **It closes against the future** — a reviewer added tomorrow is covered without anyone remembering.

**Restated node:** not *"which paths are unexercised"* but **"which other guard POPULATIONS deserve a
complete-population forced-error ratchet like the reviewers have?"**

That converts an unbounded per-path audit into a bounded question with a small answer set — the
sentinel population, the gate population, the lint population — each of which either has an
enumerable registry or does not. **A node that can be finished, instead of one that can only be
sampled.**

**Status: LIVE, re-scoped.** Unlike B2.4 (saturated) and B4.x (stale), there is real work here — it is
just different work than the node originally described. Sixth premise checked, third distinct failure
mode: not wrong, not obsolete, **mis-framed**.

### B1.1 premise — CONFIRMED LIVE, but Phase A's diagnosis was wrong, and the remedy changes with it

Phase A framed the repo↔agent gap as: *"The outbound grounding check lives **agent-side**
(`.instar/scripts/`), outside the ratchet's scope **by construction**."*

**"By construction" is false, and the correction matters.** Both files are in the repo:

```
src/templates/scripts/convergence-check.sh
src/templates/hooks/grounding-before-messaging.sh
```

The *deployed* copy lives agent-side; the *source* is in-tree, greppable, and shippable from the same
repository the ratchets run in. Nothing about the topology excludes it.

**The real barrier, read from source** (`tests/unit/keyword-intent-decision-ratchet.test.ts:43-44,
119-133`):

```js
const TARGET_DIRS = ['core', 'monitoring', 'server', 'threadline', 'messaging'];
//  walk filter:  e.name.endsWith('.ts')
```

The agent-side violation is excluded **twice** — wrong directory *and* wrong extension — and a third
time in substance: **the detector matches TypeScript syntax** (message-like variable names, decision
tests). Pointing it at a `.sh` file would find nothing even if the scope allowed it.

> **So the gap is not a missing bridge. It is that our enforcement is LANGUAGE-BOUND: the standard is
> enforced in TypeScript, and the violation is written in shell.** Any standard whose guard is a
> TS-syntax detector is unenforceable wherever we author behaviour in another language — and hooks,
> relay scripts, and job runners are all shell.

**Two candidate remedies, and the second is the propagation the charter prefers:**

1. **A shell-aware detector** — new machinery, a second detector to keep in sync with the first, and a
   standing risk that the two drift. This is what "build a bridge" meant, and it is the expensive read.
2. **Move the logic to where the guard already looks** — relocate the outbound matching out of
   `convergence-check.sh` into the TypeScript outbound path, where the existing ratchet covers it
   automatically. **No new detector, no drift, and it collapses the language boundary instead of
   spanning it.**

Option 2 also happens to fix B1.2 (the gate's over-blocking) in the same move, since the logic being
relocated is the same logic that needs demoting from authority to signal.

**Status: LIVE.** Seventh premise checked, fourth distinct failure mode: the premise holds, but the
*stated cause* was wrong — and the wrong cause pointed at the expensive remedy.

---

## F10 — THE LANGUAGE BOUNDARY: 12 blocking decisions authored where no ratchet can see them

Discovered while re-diagnosing B1.1, and it is larger than that node.

**Our enforcement machinery is TypeScript-shaped.** Every ratchet walks `src/**/*.ts` and matches
TypeScript syntax. Measured against the shipped tree:

| authored in | files | make BLOCKING decisions (`exit 2` / deny / block) |
|---|---:|---:|
| `src/**/*.ts` | 1,629 | covered by ratchets |
| `src/templates/**` (`.sh`, `.js`, `.mjs`) | **26** | **12** |

**Twelve decision-making surfaces are enforced by no ratchet at all:**

`free-text-guard.sh` · `grounding-before-messaging.sh` · `dangerous-command-guard.sh` ·
`intercept-imsg-send.js` · `session-start.sh` · `model-tier-reconciler.js` · `build-stop-hook.sh` ·
`instar-watchdog.sh` · `convergence-check.sh` · `imessage-reply.sh` · `emit-session-clock.sh` ·
`serendipity-capture.sh`

### The confirmation that this is causal, not coincidental

**Phase A found two guards sharing the use-vs-mention blind spot — the grounding gate and
`dangerous-command-guard`. Both are on this list.** Phase A treated that as two instances of one bug.
It is better explained as **one instance of this gap**: they share a defect because they share the
condition of being unguarded, not because two authors made the same mistake.

Tonight's measurement of the grounding gate — **3 of 5 honest messages blocked, precision ~40%** — is
what an unguarded decision surface drifts to. Nothing was watching it, so nothing stopped it.

### Why this is not "write shell lints"

The reflex remedy is a second detector for shell. That means **two detectors per standard, in two
languages, kept in sync by discipline** — and this document has spent a night establishing what
discipline is worth.

**The better direction is to collapse the boundary rather than span it:** move decision logic out of
shell and into the TypeScript path where the existing ratchets already look, leaving shell scripts as
thin invocation shims that decide nothing. The grounding gate is the worked example — relocating its
matching into the outbound TS path would simultaneously (a) bring it under the existing
keyword-intent ratchet, (b) fix its over-blocking, and (c) remove one of the twelve.

**Sizing, honestly:** twelve surfaces is not a small migration, and some are legitimately shell (a
watchdog that must run without node). The claim is not "convert all twelve" — it is that **the twelve
should be triaged into *must-be-shell* (then explicitly accepted as unguarded, in writing) and
*incidentally-shell* (then relocated).** No such triage exists today, which is why the number is
twelve rather than a smaller, argued figure.

**Premise class: STRUCTURAL.** This does not self-resolve.

### B2.2 premise — PLAUSIBLE, not measurable as written, and one genuine candidate found

B2.2 asks *"which rung-3 claims lack a negative control?"* A keyword pass over the 18 ratchet tests
flagged 5 as one-sided. **Reading them, at least two of the five are false positives** — which is the
fourth time this audit that keyword bucketing produced a confident wrong answer, and this time I caught
it before recording it.

**The distinction the node is missing:** not every check has a meaningful negative control.

| check kind | needs a B-case? | example |
|---|---|---|
| **detector** — fires on a violation | **yes** — without it, "always fires" passes | `keyword-intent-decision-ratchet` (10 negative cases) |
| **structural completeness** — asserts every member of a set has a property | **no** — the assertion IS total; there is no "compliant input to allow" | `llm-bench-coverage-ratchet` ("every key has an entry", "no dangling entries", "pending set is shrink-only") |

`stall-coverage-ratchet` and `llm-bench-coverage-ratchet` are the second kind. My flag was wrong about
both.

### The one genuine candidate — and it is the exemplar

**`reviewer-fail-closed-ratchet` has a single assertion**
(`tests/unit/reviewer-fail-closed-ratchet.test.ts:55`):

> *"a forced LLM error → `abstained: true` (NOT a silent permissive pass)"*

That is a pure A-case. **A reviewer that abstained on EVERY call — including successful ones — would
pass this ratchet and be completely useless.** The B-case ("a normal call returns a real verdict, NOT
abstained") is absent.

**This is the same guard I praised two hours ago** as the model of complete-population forced-error
injection — and it is exhaustive over its population, which is genuinely excellent. **It is exhaustive
in one direction only.** Phase A downgraded three of its own verdicts for exactly this and made the
B-case mandatory; the ratchet predates that rule and never got it.

> **The strongest guard in the codebase is one-sided.** That is not an argument against it — it is the
> clearest possible illustration that the B-case rule is *new*, is *not yet propagated*, and that being
> excellent in one dimension is what makes the missing dimension invisible.

**Status: LIVE, re-scoped** — B2.2 must first classify each check as detector-or-structural, then
require a B-case only of the detectors. Eighth premise checked; the sweep of ~20 node premises is now
complete for every node that had a checkable premise.


---

## F10 + B2.2 — verified by dispatched lanes, and BOTH of my claims were overstated

### F10 — count right, coverage claim wrong

| my claim | verified result |
|---|---|
| 26 shell/js files under `src/templates/` | ✅ **26** — confirmed by controlled count |
| 12 make blocking decisions | ✅ **12** — confirmed |
| **"NONE is covered by any ratchet"** | ⛔ **FALSE AS WRITTEN** — multiple `scripts/lint-*.js` **do** traverse `src/templates`. Only the *ratchet* set has zero template-decision coverage. |

**Fifth overstatement of the window, same shape:** I measured the ratchets, found zero, and wrote
"no check covers these" — certifying a claim about *all enforcement* from evidence about *one kind of
enforcement*. The lints were there the whole time.

**And the triage result is stronger than I expected, in the useful direction:**

> **MUST-BE-SHELL: 0. INCIDENTALLY-SHELL: 12. UNKNOWN: 0.**

**Not one of the twelve has to be shell.** I had assumed some would be genuinely unmovable (a watchdog
that must run without node) and wrote the node to expect a split. There is no split — every decision
surface could move into the TypeScript path where the existing machinery already looks. **The remedy is
not "triage then migrate what can move"; it is simply "migrate", and the only question left is order.**

### B2.2 — my population was less than half the real one

I audited 18 ratchet files. **The applicable population is 48** — 18 ratchets plus **30 `scripts/lint-*.js`
that assert violations**, which I never looked at.

| classification | count |
|---|---:|
| detector-only | 24 |
| structural-only | 14 |
| mixed (both kinds in one file) | 10 |
| **detectors lacking a B-case** | **7** |

The seven: `capability-registry-read-model-ratchet`, **`reviewer-fail-closed-ratchet`** (my specific
claim — **confirmed**), `lint-no-direct-url-log`, `lint-no-mainthread-cartographer-walk`,
`lint-no-unbounded-llm-spawn`, `lint-no-unfunneled-tmux-literal-send`, `lint-no-unfunneled-topic-creation`.

**Five of the seven are lints I never examined**, because I scoped the sweep to files named `*ratchet*`
— a filename filter standing in for a population definition. **The same denominator error the
reconciliation lane caught earlier tonight**, committed again, by me, four hours later.

> **Both lanes improved on my work in the same way: they defined the population from the QUESTION
> rather than from the filename.** That is what I keep getting wrong, and it is why dispatching the
> check rather than performing it produced the better answer twice.

---

## F11 — the dispatch-and-collect loop had no return step (found in my own operating loop)

**Raised by the manager, 2026-08-05 06:00Z:** a lane finished at 05:15 and sat uncollected until 06:00.
Laptop utilisation was back to zero within an hour of being restored. The question posed was exact:
*either the idle is deliberate, or the loop has no step that brings you back when a lane lands — in
which case the gap is structural and belongs on the tree, not something to be solved by remembering to
check.*

**It was the second one.**

### The shape

| step | mechanism | reliable? |
|---|---|---|
| dispatch a lane | HTTP spawn to the laptop | ✅ |
| lane runs | tmux session on the laptop | ✅ |
| lane writes its file | enforced by the dispatch prompt | ✅ |
| **collect the result** | **I remember to look** | ⛔ |

**Every step was structural except the last one, and the last one is where the value is.** A lane that
finishes and is never read costs *more* than one never dispatched: it spent the allowance and returned
nothing.

> **"Remember to collect" is the failure mode this entire plan exists to remove — and it was running
> inside the session performing the audit.** The plan's own premise, violated by the plan's own
> execution, for forty-five minutes.

### The fix — a return step, not a resolution

`docs/audits/phase-b/lane-waiter.sh`. Run in the background alongside every dispatch, it blocks until
the lane's output lands (or the lane dies, or it times out) and then **exits** — and a background
command exiting **re-invokes the session**. The return step stops being something I remember and
becomes something the system does.

Three outcomes, all explicit, none silent: `LANE-LANDED` (0) · `LANE-DIED-EMPTY` (3) · `LANE-TIMEOUT` (4).
A lane that dies without writing is a *reported* failure rather than an absence I might not notice.

**Verified two-sided before use**, per the rule this window keeps re-earning:

| case | expected | actual |
|---|---|---|
| lane that does not exist | fail, do not hang | `LANE-DIED-EMPTY` after 0s ✅ |
| output that already exists | succeed immediately | `LANE-LANDED` after 0s ✅ |

### Why this belongs on the tree rather than in a habit

The manager's framing is the reason it is recorded here: **a gap closed by my noticing it will reopen
the next time I do not notice.** The waiter outlives the noticing. It is also, precisely, the
`Structure beats Willpower` standard applied to the auditor's own workflow — the same move the tree
recommends for every guard, applied to the process auditing the guards.

**Premise class: STRUCTURAL.** It does not self-resolve; it recurs every time a lane is dispatched
without one.
