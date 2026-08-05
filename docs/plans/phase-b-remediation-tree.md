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
