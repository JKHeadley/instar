# Window-8 external-review settlement — the five rulings and their cases

**Status.** Justin ruled **YES TO ALL FIVE** on 2026-08-07 00:53 PDT, with one condition attached
to ruling 4. This document is the single case-study source for the five changes; each amended
registry article points HERE rather than restating its case, so there is one copy to keep true
(*Remove What Demands Attention*, ratified 2026-08-06).

**Provenance of the findings.** An external reviewer was dispatched over the amended Substrate
family **with the answer withheld** — it was never told which articles were new, what was
expected, or that acceptance was wanted (*A Dispatch Supplies the Question and Withholds the
Answer*, ratified 2026-08-06). It returned **NOT ACCEPTED** with five findings. Four were about
PRE-EXISTING articles and were escalated as operator-class rulings rather than resolved by the
author of the change under review. Full transcript:
`docs/audits/phase-b/substrate-family-review-2026-08-06.txt`.

**Why the findings were not settled by the agent.** Every one of them is a question about what the
constitution should SAY, not about whether the code matches it. The reviewer found a
decision-authority conflict between two ratified articles; an agent picking a winner between two
ratified articles is legislating. They went up, and they came back as rulings.

---

## §1 — EMERGENCY-STOP: the floor/intelligence split

**Finding 1, verbatim.** *COHERENCE — No. Intelligence Infers, Keywords Only Guard says whether a
message is a command "is made by an LLM" and a keyword/regex list is "NEVER the decision-maker."
Yet The Operator Channel Is Sacred says "a message-CONSUMING decision requires a DETERMINISTIC
match, never a bare-LLM guess," and specifically permits pause consumption "ONLY on a
deterministic fast-path match." For benign pause commands, this is an unqualified conflict over
who decides.*

**The ruling.** Resolve as the floor/intelligence split: **the literal-match floor always stops and
can never be vetoed by the model layer; the model layer may only ADD stops it infers from any
phrasing.** Amend whichever article contradicts this.

**Which article contradicted, and why it was that one.** *The Operator Channel Is Sacred* already
scoped itself to consume/pause gates and disclaimed emergency-stop. The contradiction was in
*Intelligence Infers*, whose survivor (2) described the safety floor as *"Deterministic first
strike for safety, **never the sole decision**"* and required *"an LLM stage behind it."* Under the
ruling the floor **is** the sole decision for emergency-stop and is un-overridable. That clause was
struck where it sat rather than corrected in a new sentence (trap 6).

**The case — and it is a case about doctrine, not about a defect.** The code was measured before
the text was written, and **the implementation already conformed to the ruling**:
`MessageSentinel.classify()` returns the fast-path result *before* the intelligence provider is
consulted at all, and `decideInboundDisposition()` kills on `emergency-stop` regardless of whether
the verdict came from the floor or the model. So the conflict was never live in behaviour — it was
live in the **text two ratified articles presented to a reader**, and a reader resolving it either
way would have been able to cite the constitution for the opposite conclusion.

That is the case worth recording: **a decision-authority conflict costs nothing until someone
reads it, and then it costs the whole decision.** The 2026-06-25 lockout (topic 28130) is the
standing proof of what an inbound-gate misjudgment costs — the operator sealed out of their own
channel in an inescapable loop. A future engineer resolving this conflict in the direction of "the
LLM decides, the keyword list never does" would have removed the un-vetoable floor and rebuilt the
conditions for exactly that incident, with a ratified article to justify it.

**What was built.** `tests/unit/emergency-stop-floor-intelligence-split.test.ts` — a ratchet
pinning both arms of the union plus a discriminator, so the split cannot silently regress to
either single-layer reading.

**The proof, and the trap it walked into.** The guard was proven two-sided by injection, not by
reading. **The first injection attempt failed to COMPILE** — the suite never ran, and the run
reported `Tests no tests` while exiting non-zero. Checked by exit status alone it would have been
recorded as a passing injection proof, which is window-8 trap 2 (*an injection proof can pass for
the wrong reason*) reproduced within a day of it being written down. The injections that actually
discriminate:

| injection | arm broken | observed failure | other arms |
|---|---|---|---|
| floor stops matching `stop` | (a) un-vetoable floor | `expected 'route-through' to be 'kill'` | 2 still passed |
| `emergency-stop` requires `method === 'fast-path'` | (b) model may add | `expected 'route-through' to be 'kill'` | 3 still passed |

Each injection failed **for its own reason**, and the surviving arms in each run are what prove the
harness discriminates rather than failing indiscriminately. Tree restored and re-verified green
after each.

**What it does not certify** — named here rather than left for whoever trusts it next: the ratchet
pins the *disposition contract*, not the *contents* of the literal stop set. A stop phrasing that
neither the floor matches nor the model infers is still missed, and no test in this file would
notice.

---

## §2 — BLOCKER STANDARDS: one obligation, one owner

**Finding 2, verbatim.** *REDUNDANCY — Yes. A Wall Is a Hypothesis, Never a False Blocker, and
Self-Unblock Before Escalating all require inventorying and exhausting existing means before
declaring a blocker or involving a human: "first inventory the mechanisms," "inventory the means
already in hand and try them," and "Exhaust every unblock path… before requiring anything from a
human." Their feasibility/agency/resolution labels do not establish a clear governing boundary for
an ordinary escalation.*

**The ruling.** Fold the three into the self-unblock ladder as the single governing article. *"Remove
what demands attention — delete the duplication, do not reconcile it."*

**The interpretive fork, and the evidence that closed it.** The ruling admits two readings: DELETE the
two sibling articles, or delete the duplicated OBLIGATION and leave one owner. This is recorded rather
than silently resolved, because the two readings produce materially different registries.

The measurement that decided it: those two article NAMES are referenced across **~20 files** —
`docs/specs/wall-is-a-hypothesis-standard.eli16.md`, `docs/specs/never-a-false-blocker-standard.md`,
`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (which the `/spec-converge` lessons-aware reviewer
reads), the **B16_UNVERIFIED_WALL** and **B17_FALSE_BLOCKER** tone-gate rules named after them, and
four test files that assert them BY NAME
(`tests/unit/messaging-tone-gate-b16.test.ts`, `-b17`, and two integration siblings).

Deleting the headings would therefore either **strand ~20 stale references** — the precise rot this
phase has spent two days fighting — or **drag a rename of two live safety guards into a documentation
ruling**. Neither is what the finding asked for. What the reviewer actually named as the defect is the
missing **governing boundary**, and that is what is now fixed: the obligation has one owner, the
siblings keep only what each uniquely detects, and each disclaims and hands off explicitly.

**If the operator meant heading-deletion, that is a second and larger change.** Named here rather than
quietly foreclosed, because a fork resolved silently is indistinguishable from a fork never noticed.

**Why this is deletion and not reconciliation.** Reconciling would mean writing a paragraph explaining
how three articles coexist and which wins when — *more* words to keep in agreement, which is the exact
failure mode *Remove What Demands Attention* was earned from. What was done instead: the restatement
was removed from two articles so there is nothing left to reconcile.

**What was built.** `scripts/lint-single-governing-obligation.mjs`, wired into the `lint` chain.
Prose saying "one owner" is exactly the class of claim that rots — the next author to strengthen a
sibling will restate the ladder there in good faith and nothing would notice.

**The proof, four injections, each failing for its OWN reason:**

| injection | observed failure | discriminates? |
|---|---|---|
| ladder restated in a sibling | `the ladder is stated in 2 articles … delete the copy, do not reconcile it` | yes — named both holders |
| sibling drops its disclaimer | `"A Wall Is a Hypothesis" does not carry the disclaimer …` | yes — other arms clean |
| governing article drops its declaration | `no longer carries the governing declaration …` | yes — other arms clean |
| sibling stops naming the owner | `does not name "Self-Unblock Before Escalating"` (both siblings) | yes — other arms clean |

**A process failure worth recording, because it destroyed work.** The first injection run used
`git checkout --` to restore between injections, while the item-2 registry edits were still
UNCOMMITTED. The first restore reverted them, so injections 2 and 3 ran against the reverted file and
their "failures" measured the absence of the fold rather than the injection. The tell was the RESTORED
CONTROL arm coming back dirty instead of clean — which is the only reason it was caught. **A control
arm is not ceremony; it is the thing that catches you when your harness is lying.** The edits were
redone, committed FIRST, and the injections re-run against a scratchpad backup.

**What it does not certify:** a restatement in DIFFERENT words. That limit is deliberate — judging
whether new prose MEANS the same obligation is an open-domain semantic call, and *Intelligence Infers,
Keywords Only Guard* forbids a regex from making it (window-8 trap 4: a proposed guard can be
forbidden by another ratified standard). The population is also DECLARED, not discovered: a new
article inventing a fourth surrender surface is invisible until someone adds it to the constant.

---

## §3 — MISFILED KNOBS: placement only

**Finding 3, verbatim (first half).** *PLACEMENT — Yes. Several articles are operational engineering
controls rather than "facts about the substrate," notably Bounded Blast Radius, Capacity Safety,
Ownership-Gated Side Effects, and Live-User-Channel Proof Before Done.*

*(Finding 3's SECOND half — that declared tree children render as peer headings — was mine and was
already fixed on 2026-08-06 by `scripts/lint-registry-tree-parentage.mjs`.)*

**The ruling.** Move them into the engineering family. Placement only, zero content changes.

**How "byte-identical" was established.** Not by reading the diff — by hashing each article block
before the move and re-hashing it after, then asserting equality and re-deriving each block's family
from the file. All four identical. A 26-insertion/26-deletion diff *looks* like a pure move and would
have been accepted as one; the hash is what makes it a measurement.

**The case: a floor caught the move, and not where it was predicted.** Before starting, the prediction
recorded in the operator channel was that this batch would push THE SUBSTRATE below its floor. The
Substrate was fine — 0.7 against a 0.6667 floor. **BUILDING tripped**: 27/34 = 0.7941 against a
committed 0.8, because three of the four movers carry a real guard and the fourth carried none.

The prediction was wrong in DIRECTION, not merely in magnitude, which is the entire argument for
measuring after each item rather than modelling the batch. A model that had been trusted would have
produced a confident and false "the Substrate is the risk" report to the operator.

**What the floor was protecting.** Re-filing articles between families is exactly the loophole that
could dilute a family's enforced share without anyone shipping a regression — an accounting change
disguised as a taxonomy improvement. The floor refused it.

**How it was resolved, and why that is not floor-repair-by-convenience.** *Live-User-Channel Proof
Before Done* has ALWAYS claimed a completion gate in its own *In practice* — *"The completion gate
refuses 'done' without that artifact — the teeth, not the willpower"* — while naming no
implementation. That made it `spec-only`: **the registry could not see the teeth the article was
claiming.** The gate is real (`src/core/LiveTestGate.ts`, returning a veto, wired into the server,
carrying unit and integration tests) and was verified to actually refuse before being cited, not
inferred from filenames.

So this is the MIRROR of finding 4: an article **under**-claiming its own enforcement. That direction
is the more dangerous one — an unnamed guard is invisible to the auditor, so nothing would have
noticed if someone deleted it. The citation was committed SEPARATELY from the move so the move stays
provably placement-only.

**What that gate does not certify**, written into the article in the same edit: the hard veto fires
only when a feature is DECLARED user-facing; an undeclared feature the classifier merely suspects gets
a soft nudge; and the gate has dry-run/warn/veto modes. A feature nobody declares user-facing can still
reach the operator untested.

---

## §4 — HONEST LABELS: documented-only as a countdown

**Finding 4, verbatim.** *OVERREACH — Yes. Session Input Is a Principal requires authority to be
"structurally distinguishable," but its implementation admits "required practice… (acknowledged as
willpower until the structural fix lands)". Close the Loop likewise claims "Every loop the agent
opens… must be durably registered and re-surfaced", while listing only several example mechanisms…
that does not substantiate universal coverage.*

**The ruling, with Justin's condition verbatim:** relabel both as documented-only, AND in the same
change register a tracked enforcement item with a deadline — *"the documented-only MUST force a change
in the near future. It can't remain documented only."*

**Why the condition is the substantial half.** An honest gap label beats a false enforcement claim
**only if the label expires.** A permanent `documented-only` is a false claim with better manners: the
registry stops lying about the guard and starts quietly accepting its absence. Nothing improves; the
record just reads better. The condition converts an honest label into a countdown with an end.

**A subtlety in Close the Loop worth recording.** The cited mechanisms are REAL and do close real loop
kinds. The over-claim was citing them as enforcement of a **universal** rule. So the fix was to rewrite
*In practice* prescriptively rather than to delete true statements — the defect was the inference, not
the facts.

**The classification decision that could have silently undone the ruling.** The new
`Documented-only until` field is registered as EXCLUDED-NARRATIVE, never ENFORCEMENT. A countdown says
a guard is OWED, not that one exists. Filed as enforcement, its refs would be scanned and a
**promise-to-build would flip an article to `enforced`** — reproducing the exact over-claim the ruling
was raised against, inside the machinery implementing it.

**A deliberate substitution, named rather than slipped in.** The ruling said "register on the
maturation/initiative track". `InitiativeTracker` persists to `.instar/initiatives.json` — per-machine
RUNTIME state, invisible to CI and to a successor on another machine. The countdown is declared in the
registry instead: reviewed in its own PR, travels with the repo, and can fail a build.

**What was built.** `scripts/lint-documented-only-countdown.mjs`. On 2026-09-07 the build goes red
until the guard ships or the operator deliberately re-dates. **Re-dating passes on purpose** — a check
forcing a choice between a rushed guard and a deleted standard would buy honesty with worse
engineering. What it makes impossible is the SILENT version.

**Proof — three injections, each failing for its own reason:** an expired deadline (the load-bearing
arm), a required article carrying no countdown, and an article that gained a guard while keeping a
stale countdown.

**The number the operator needs.** The Substrate now sits at **exactly** its floor (20/30 = 0.6667).
It passes with zero margin — any further honesty-driven downgrade in that family trips it.

---

## §5 — MATURATION AMENDMENT

**The ruling.** (a) the maturation-plan check refuses instead of warns; (b) graduation evidence must
include the feature's own logged decisions/behaviour; (c) the arm/graduate decision registers on the
maturation track at ship time; (d) the maturation track is THE home for graduate/arm decisions.

**Why (a) is the one with teeth, and why warn was never going to hold.** v1 shipped as a warning
deliberately, so a corpus of real specs could be reviewed before promotion — and that review is what
promoted it. **A warning that never blocks is advice, and advice is precisely what "ship it dark and
move on" already ignores.** Nobody who was going to skip the plan is stopped by a line of console
output. The refusal is STRUCTURAL (missing / duplicated / field-incomplete), never a judgment about
whether a plan is good.

**Honest teeth, stated in the article:** only clause (a) is mechanically enforced. (b), (c) and (d) are
obligations with no check yet.

**Proof.** Two-sided against the REAL convergence script with a single-variable difference: an A-case
spec tags through to a convergence stamp; a B-case identical except for the maturation section is
refused by name.

**A latent defect this change introduced and caught.** The new refusal message interpolates
`REQUIRED_FIELDS`, which was **not imported** — a `ReferenceError` on the refusal path ONLY. It would
have passed every A-case, every lint and every existing test, then thrown the first time a spec
genuinely lacked a plan: the moment it was needed. Caught by RUNNING the B-case rather than reasoning
about it. **The error path is the one nobody exercises, which is why it has to be exercised
deliberately** — and it is a fresh instance of window-8 trap 2's family: a check that looks right and
is never executed in the state that matters.

**A second finding, flagged rather than fixed.** The recognized-heading set has **TWO OWNERS**:
`scripts/standards-coverage.mjs` and `src/core/StandardsRegistryParser.ts`. Adding §4's countdown field
to only the first passed the coverage check cleanly and was then REFUSED by the asset generator's
canary — *"refusing to ship a constitution that the runtime would classify as untrustworthy."* **That
is §2's defect — one obligation, two owners — sitting inside the machinery that enforces the
registry.** Both are updated here. Consolidating them is a shared-constant refactor across a runtime
parser and does not belong in a batch executing documentation rulings; it is recorded rather than
silently left.
