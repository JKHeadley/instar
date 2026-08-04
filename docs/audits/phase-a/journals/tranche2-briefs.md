# Tranche 2 — per-standard briefs for the 16 `documented-only` standards

**For the architect's ruling** (requested: *"what the standard promises, what surface could carry a guard,
why none exists"*, batched). **Measured 2026-08-04 06:22Z** against the repo at `origin/main` d1b7af3c6.

---

## ⭐ HEADLINE: THE QUESTION HAS A THIRD ANSWER

You framed the judgment as **unguardable vs merely unguarded**. The evidence says a third category
dominates:

> ### GUARDED-BUT-UNCITED — the guard exists in the repo; the standard's prose does not name it.

The conformance audit classifies by `enforcementBasis: named-ref-existence` — *does the prose name a ref
that resolves?* A standard can therefore be **well guarded and still read as `documented-only`**, purely
because it never cites its own guard.

**Verified present in the repo, for standards currently counted as gaps:**

| standard | guard that exists | verified |
|---|---|---|
| User-Facing Fixes Ship Live | `scripts/lint-dev-agent-dark-gate.js` | ✅ 12 matches |
| Observability | `scripts/lint-llm-attribution.js` | ✅ 7 matches |
| Near-Silent Notifications | `tests/integration/notification-flood-burst-invariant.test.ts` | ✅ exists |
| LLM-Supervised Execution | `supervision` field on `JobDefinition` (`src/core/types.ts`) | ✅ 5 matches |
| Session Input Is a Principal | `src/core/InputGuard.ts` | ✅ exists |
| Deferral = Deletion | orphan-deferral scan in `scripts/instar-dev-precommit.js` | ✅ 4 matches |

**So ≥6 of 16 are citation gaps, not enforcement gaps.** The cheapest correct fix for those is one line of
prose each — not building anything.

⚠️ **Confidence, stated honestly:** I verified each guard **exists and is topically matched**. I did NOT
verify each one actually enforces *that specific standard's* promise — that is the per-node rung-2/3 work.
**A topical match is a candidate, not a verdict**, and treating it as one would be the same error as
reading `enforced` off the audit.

⚠️ **One correction to my own probe:** I expected `scripts/convergence-check.sh` (the sycophancy /
stand-ground detector) in the repo. **It is not there** — it ships to agents under `.instar/scripts/`.
So *The Right to Stand Ground* has a **deployed agent-side** guard with no repo-side counterpart, which is
a genuinely different situation from the six above and from a true gap.

---

## THE BRIEFS

### The Substrate (8)

**1. The Body and the Mind** — *promises:* the agent is body (code + docs) and mind (the reasoning
instance); the body informs, the mind decides, the decision is audited. *Surface:* already executable —
the instar-dev **tier signal → agent declares → audited to `instar-dev-decisions.jsonl`** is literally
this standard running. *Why uncited:* the standard predates the mechanism and never adopted it.
**→ GUARDED-BUT-UNCITED (high confidence — the skill doc names this standard by name).**

**2. Documentation IS Being** — *promises:* undocumented presence is erased presence. *Surface:* the
**Agent Awareness Standard** already requires a CLAUDE.md-template update for every feature, and
`Docs Coverage` runs in CI. *Why uncited:* the enforcement lives in a *different* standard's prose.
**→ GUARDED-BUT-UNCITED (medium — the coverage check's scope needs confirming).**

**3. Deferral = Deletion** — *promises:* "I'll note it later" equals never. *Surface:* the orphan-deferral
scan in the pre-commit gate, which blocks deferral language lacking a tracked marker.
**→ GUARDED-BUT-UNCITED (high — verified, 4 matches).** Note the sibling standard *No Deferrals* cites the
same script and is classified `gate`; these two should share the ref.

**4. Name the Gravity Wells** — *promises:* enumerate predictable self-deceptions explicitly. *Surface:* a
ratchet that the gravity-wells enumeration is non-empty and injected at session start. *Why none:* nothing
currently asserts the list exists or is reached. **→ GENUINELY UNGUARDED, and guardable cheaply.**

**5. Architectural Agency in the Gap** — *promises:* the agent shapes its own architecture rather than
relying on willpower. *Surface:* none obvious; it is a *meta*-principle about how other guards get built.
**→ CANDIDATE UNMEASURABLE-BY-INJECTION.** Proposed alternative test per your ruling 1: a **live, dated
instance** of a willpower-reliance being converted into a structural guard, inside the anti-decay window.
Tonight supplies one: the architect amendment moved *"a verdict does not transfer"* from my discipline into
the node template.

**6. Sovereignty — "I own what is mine"** — *promises:* the test for a privileged action is "is this
mine?" *Surface:* **`SelfUnblockChecklist`** — which exists but **is not initialized on this machine**
(`/blockers/self-unblock-runs` 503s, `monitoring.blockerLedger.selfUnblockChecklist.enabled` false).
**→ GUARD EXISTS BUT IS DARK** — a fourth state, distinct from all three above.

**7. The Right to Stand Ground** — *promises:* hold a position with warmth rather than capitulate.
*Surface:* the sycophancy detector in the **agent-deployed** `convergence-check.sh`. **Not in the repo.**
**→ GUARDED AGENT-SIDE, UNGUARDED REPO-SIDE.** Worth your ruling: does a deployed-to-agents hook count as
enforcement for a constitutional standard, when the repo carries no ratchet that it stays deployed?

**8. Session Input Is a Principal** — *promises:* anything that can type into a session is a principal
whose authority must be established. *Surface:* **`src/core/InputGuard.ts`** (verified present; it appears
in live feature-metrics with real calls). **→ GUARDED-BUT-UNCITED (high).**

### Building (3)

**9. Cross-Store Coherence Is an Invariant** — *promises:* two stores answering the same question need a
declared, cadence-checked agreement invariant. *Surface:* `/state/conflicts` + the machine-coherence guard
partially implement it. *Why not counted:* neither is declared as *this* standard's invariant, and no
enumeration of store-pairs exists. **→ PARTIALLY GUARDED; the missing piece is the declared pair list.**
⚠️ Tonight's 16-of-89 guard divergence is a live instance of exactly this standard being violated.

**10. LLM-Supervised Execution** — *promises:* every critical pipeline carries ≥ Tier-1 supervision.
*Surface:* the `supervision` field exists on `JobDefinition`; a lint could require it on jobs marked
critical. *Why none:* the field is optional and nothing asserts coverage.
**→ GUARDABLE CHEAPLY; currently unguarded (the field is a *hook* for a guard, not a guard).**

**11. Observability** — *promises:* every feature ships metrics making its effectiveness auditable.
*Surface:* `scripts/lint-llm-attribution.js` (verified) already ratchets attribution coverage.
**→ GUARDED-BUT-UNCITED (high) — though it guards the LLM-call slice only, so partial.**

### Shipping (2)

**12. Bug-Fix Evidence Bar** — *promises:* never claim fixed until the original failure is reproduced and
verified to stop; unit tests are not evidence. *Surface:* a commit-gate requirement that a fix-tagged
change carries a **control run** (tests failing against pre-fix code). **Nothing enforces it today.**
**→ GENUINELY UNGUARDED, and the most valuable buildable guard in this tranche.** PR #1850 tonight did
exactly this by hand — 3 of 6 tests failing pre-fix for the right reasons — which shows the artifact is
producible and mechanically checkable.

**13. User-Facing Fixes Ship Live** — *promises:* UX fixes ship fleet-wide; the dark gate is for new
capabilities only. *Surface:* `scripts/lint-dev-agent-dark-gate.js` (verified, 12 matches).
**→ GUARDED-BUT-UNCITED (high).**

### Interaction (3)

**14. Never-Waste Feedback** — *promises:* user corrections never evaporate. *Surface:* the correction/
preference learning loop + `/corrections`. *Why not counted:* the loop **ships off by default**
(`monitoring.correctionLearning.enabled`), so a citation would be to a dark guard.
**→ GUARD EXISTS BUT IS DARK** (same class as Sovereignty).

**15. Near-Silent Notifications** — *promises:* only action-required events are pushed. *Surface:*
`tests/integration/notification-flood-burst-invariant.test.ts` (verified) + the topic-creation budget.
**→ GUARDED-BUT-UNCITED (high).**

**16. Truthful Provenance — Speak Only as Yourself** — *promises:* no message impersonates a sender.
*Surface:* topic-operator binding (auth-bound, refuses blank uids) + the principal-coherence recorder —
the latter **ships dark**. **→ PARTIALLY GUARDED, partly dark.**

---

## SUMMARY FOR YOUR RULING

| classification | count | standards |
|---|---|---|
| **Guarded-but-uncited** | **7** | Body/Mind · Documentation IS Being · Deferral=Deletion · Session Input · Observability · Ship Live · Near-Silent |
| **Guard exists but DARK** | **2** | Sovereignty · Never-Waste Feedback |
| **Partially guarded** | **2** | Cross-Store Coherence · Truthful Provenance |
| **Genuinely unguarded, cheaply guardable** | **3** | Gravity Wells · LLM-Supervised Execution · **Bug-Fix Evidence Bar** |
| **Guarded agent-side only** | **1** | Right to Stand Ground |
| **Candidate unmeasurable-by-injection** | **1** | Architectural Agency in the Gap |

**The 16 "gaps" contain at most 3 genuine build-a-guard items.** The rest are citation, rollout, or scope
problems — which is a materially different backlog from what the audit's headline implies, and the reason
you asked for briefs rather than accepting the count.
