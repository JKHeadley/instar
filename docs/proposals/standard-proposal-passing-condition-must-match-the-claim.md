# PROPOSED STANDARD — not yet ratified

**Status:** PROPOSAL. Per *How a new standard joins this registry* step 2, the agent proposes and **the
operator ratifies**. This document is deliberately NOT written into `docs/STANDARDS-REGISTRY.md`, so it
cannot be mistaken for an adopted entry.

**Proposed by:** Echo — Pathway, 2026-08-05, from the Phase B window-7 finding set.
**Proposed family:** The Substrate (sibling to *Verify the State, Not Its Symbol*).

---

### A Check's Passing Condition Must Cover What It Certifies

**Rule.** Every check — a lint, a gate, a ratchet, a test assertion, a classifier, a status field, a
reported ratio — must state (a) the condition it actually **evaluates** and (b) the claim its result is
**read as certifying**, and the two must be argued equal. A check whose passing condition is *narrower*
than its certified claim is a **false assurance**: it converts "I could not detect a problem" into "there
is no problem," and it does so most confidently in exactly the cases it cannot see. The obligation is
symmetric to *Verify the State, Not Its Symbol*, one level up: that standard governs what a detector may
conclude about the **world**; this governs what a check may conclude about **itself**.

**In practice.** Three teeth, applied at authoring time because that is when the gap is cheapest to
close. **(A) The passing-condition question is mandatory** — every check must answer *"what input passes
this check while failing the claim?"* If an answer exists and is not argued out of scope, the check is
mis-scoped and must be narrowed in claim or widened in condition. This is the B-case Phase A adopted
mid-audit, generalised from tests to every check. **(B) Length, presence, and resolution are never
evidence of truth** — a justification is not valid because it is long, an exemption is not correct
because a reference resolves, a standard is not enforced because a ref of the right shape exists, and a
component is not idle-by-fault because it registered nothing. Each of these certifies a *proxy*; where
only a proxy is available, the result must be named as the proxy (`ref-resolves`, `not-registered`),
never as the claim (`enforced`, `missing`). **(C) A check's report must be readable as what it measured**
— a neutral condition must not be given an alarming or reassuring name, because the name is what a
reader acts on. Enforcement: the `/spec-converge` gate already flags this class under *Verify the
State*; the addition is that it applies to the check's OWN passing condition, not only to the detector's
subject.

**Earned from.** Not one instance — **seven, in a single window (2026-08-05, topic 29723), across four
unrelated surfaces**, which is why it crystallises rather than being fixed point-wise for the eighth
time:

| surface | evaluates | certified as | passes while failing |
|---|---|---|---|
| `NOT_A_GUARD.reason` | ≥12 non-whitespace chars | "exclusion is justified" | any 12 characters |
| `COHERENCE_MANIFEST_EXCLUSIONS.reason` | `.length > 20`, raw | "exclusion is justified" | 21 spaces |
| `/guards` → `missing` | no runtime getter registered | "should be running, isn't" | every standby machine |
| three-rung `effective` | acts when it should | "aligned" | a guard that never refrains |
| guard-observability v1 | a counter exists at a path | "guard is instrumented" | any borrowed positive number |
| `enforcedRatio: 0.72` | a ref of that shape resolves | "the standard is enforced" | a guard not in CI, not running |
| `/health` `llmReliability` | error rate over 6h | "failing **now**" | a fix landed inside the window |

The crystallizing case is the first: `CrashLoopPauser` sat classified-but-never-constructed while 21
jobs failed — worst **477 consecutive** — because its exclusion rationale asserted an observability that
did not hold and the check asked only whether the sentence was long enough. **The same window then
produced six more instances, and the design intended to fix the first reproduced the defect four times
before an outside reader stopped it.** Recurrence across seven independent instances is well past the
registry's promotion signal.

**Traces to the goal.** A self-evolving agent must be able to trust its own instruments, because every
decision downstream compounds on them. *Verify the State, Not Its Symbol* makes a detector honest about
the world. This makes a check honest about **itself** — and that second honesty is what the first
depends on, because a detector's own passing condition is the last thing anyone audits. Its deeper
claim: **a check's passing condition is written by the same author, in the same sitting, under the same
assumptions as the thing it checks — so it inherits that author's blind spot by construction.** That is
not carelessness; it is structural, and it is why *Structure beats Willpower* must extend to the
structures themselves. Sibling to *Signal vs. Authority* (which governs *who may block*): a check may be
correctly scoped and still hold the wrong authority — and, as the grounding gate showed, may be
genuinely useful while over-blocking.

**Applied through.** ENFORCEMENT FIRST, and stated honestly: **this standard is NOT yet enforced, and
adding it to the registry would not make it so** — which is itself instance #6 in the table above. The
proposed real surfaces, in the order they can actually land:

1. **The `/spec-converge` gate already fires on this class** — it raised it against this window's own
   spec five times under *Verify the State, Not Its Symbol*. The change is scope, not machinery: the
   lessons-aware reviewer asks the passing-condition question about the **check** a spec introduces, not
   only about the detector's subject. Smallest real step; available now.
2. **A B-case obligation on new checks.** `standards-coverage-ratchet` already carries eleven explicit
   negative controls — the pattern is proven by injection. Propagating it is the tree's B2.2 node.
3. **Two named repairs already evidenced**, which are the test of whether this standard bites:
   `COHERENCE_MANIFEST_EXCLUSIONS`'s raw-length check, and `missing`'s lack of lease-awareness.

**If this standard is ratified and those three do not change, it is prose** — and that is the honest
test the registry's own process demands.

---

## What I am NOT claiming

- **Not that the standards are wrong.** They are scar tissue and they are good. The flaw is in the
  checks enforcing them, and it is one flaw.
- **Not that seven instances proves universality.** They are seven found in one window by one agent
  looking for one thing. A reviewer may reasonably argue the class is narrower than stated.
- **Not that this is the operator's obvious next action.** Two decisions already await him. This is a
  proposal filed where it can be found, not a request for attention now.
