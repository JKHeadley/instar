# Window 14 — application record

**One row per ruling. Every one of the seven is either APPLIED-AND-VERIFIED, naming the articles
actually changed, or RETURNED with a named blocker. No ruling is silently absent and no ruling is
partially applied without saying so.**

Ruling source of truth: `.instar/decision-package-rulings.md` (the operator's own words).
Change plan and fidelity baseline: `docs/proposals/window14-ruling-to-change-matrix.md`.
Application base: `origin/main` — the live rulebook.

---

## 1a — Emergency stop versus blocking authority · **APPLIED-AND-VERIFIED**

**Articles changed (2).** *Signal vs. Authority* (Interaction); *Structure Decides Alone Only on an
Exact Match* (The Substrate).

**What landed.** *Signal vs. Authority* now carries the one named exception — the emergency-stop
literal-match floor holds blocking authority and keeps it when the intelligent gate is offline —
bounded to a whole-message exact match against a closed enumerated list, and explicitly not a grant
to cheap matchers as a class. The Substrate article carries the reciprocal reference.

**A finding from applying it, worth recording.** The Substrate half already said nearly all of this,
including the honest consequence *"with no model reachable, structure's coverage is exactly the
enumerated list and nothing more."* The contradiction lived entirely on the Interaction side, which
stated an absolute with no exception named. So the change is smaller than the matrix anticipated and
lands where the defect actually was.

**Folded in, and labelled as an inference rather than a quotation.** Item 2 held *Signal vs.
Authority*'s own failure direction undecided pending this ruling. It is now **FAIL-OPEN** — a
low-context detector does not inherit blocking authority when the mind is missing, with the
enumerated floor as the sole carve-out that still halts. The registry text marks this **DERIVED**
from the ruling so a fidelity reviewer checks the reasoning and not just the sentence.

**Proof.** Blind scenario pair put to a reviewer that was given the scenarios and not the intended
answers: an exact whole-message stop with the gate offline, and the same word inside a longer scoped
message. Recorded in the area-audit evidence for this change.

---

## 1b — The precedence residual · **APPLIED-AND-VERIFIED, with a named unenforced sub-obligation**

**Changed.** New registry section *When two articles collide and nothing settles it — the residual*.
No article amended; every existing tiebreaker is untouched and still fires first.

**What landed.** The residual is defined by exhaustion (both scopes apply · neither pending · neither
names the other · no clause reaches it · the obligations cannot be jointly satisfied), with
**escalate to the operator** as the default. Both of the operator's conditions are in the text as
conditions: the durable record is mandatory in his terms — *an escalation that is not durably
recorded does not satisfy this ruling* — and logged residuals are reviewed and fed back into the
rulebook.

**The logging dependency, honestly.** No new store was built. The clause names **existing durable,
queryable surfaces**: the decision journal (which already carries `conflict` alongside the decision,
its principle, alternatives and context) and the attention queue. Using what exists before building
is ruling 3's own cheapest-first discipline applied here.

**What is NOT enforced, named in the registry rather than implied.** Nothing forces the journal write
at the moment a residual is recognised, so an agent could escalate without recording and go
undetected. Carried as `UNENFORCED SUB-OBLIGATION` with countdown `2026-09-13`
(`STD-SUBCOUNTDOWN-residual-collision-log`). The rule binds; the automation is dated and tracked.

---

## 2 — The 57 silent failure directions · **APPLIED-AND-VERIFIED**

**Changed.** 53 articles gained a `**Fails.**` line; *Signal vs. Authority* gained its own via 1a
(54 articles carry the field); one new registry section records the seven group defaults once.

**Reconciliation, derived by command rather than quoted.** 56 articles sit in the seven groups and
the 57th is *Signal vs. Authority*, held undecided — so the package's "57" is sound. Of the 56: one
is out of scope (below), two already state a direction on trunk and were left alone, 53 were
amended. The ruling fills silence; it does not re-decide settled cases.

**The asymmetry landed as ruled** — groups 1, 2, 3, 4 and 6 fail closed; groups 5 (reachability) and
7 (advisory observation) fail open, group 7 loudly. The section states the asymmetry as the substance
of the ruling and traces it to the already-ratified *user wins* tradeoff.

**Recorded and explicitly NOT built,** per the operator's own instruction: the specific fallbacks; a
fallback-coverage map as the near-term artefact; and *"have a fallback path"* as a **candidate**
standard tiered RECOMMENDED, carrying his caveat that some deployments cannot provide independent
redundant services. It is not ratified as a requirement.

**Out of scope, named.** *One Failure Teaches Every Guard — Record the Shape, Sweep It Everywhere*
(group 1) exists only on the unmerged branch.

---

## 3 — Paperwork gates to behaviour checks · **APPLIED-AND-VERIFIED, with a named unenforced sub-obligation**

**Changed.** New registry section authorising the nine mechanisms with their tiers and, for each,
what a **breach** looks like rather than what a declaration looks like. Eight articles gained a
`**Judgment-bound.**` line.

**Both halves of the ruling landed.** The nine are authorised as a block, cheapest-first, each naming
the existing surface it extends. The judgment-bound articles each name the **specific judgment** they
turn on, and carry the operator's addition as an obligation rather than an exemption: **context
sufficiency** and **rating** of the calls.

**Authorisation is not construction, stated plainly.** The nine are approved to be built; none is
built here, and the section says so.

**Out of scope, named.** Two of the ten judgment-bound articles are branch-only — *One Failure
Teaches Every Guard* and *A Metric Must Measure the Work, Not the Question* — so eight are labelled.

**What is NOT enforced.** Nothing forces a judgment-bound call to be logged with its context at the
moment it is made, so the rating loop has no guaranteed input. Countdown `2026-09-13`
(`STD-SUBCOUNTDOWN-judgment-call-rating`).

---

## 4a — The 29 superseded articles · **RETURNED — blocker named, escalated, not guessed**

**Nothing applied.** This is the one ruling deliberately not in the change.

**The blocker.** The operator's condition 1 requires the retiring article's spirit to be absorbed
upward into a live higher-order rule **where possible**. Classification of all 29 against the live
rulebook found **25 absorbable** — each with a named live target article, and none of those targets
itself retiring (checked, because absorbing into something that is also disappearing is not
absorption). **Four have no higher-order rule to absorb into:** *Structure beats Willpower*, *The
Body and the Mind*, *Know Your Principal*, and *Structure Decides Alone Only on an Exact Match*.

**Three measurements that sharpen it, derived rather than asserted.**

1. *Structure beats Willpower* is the **sole article in the registry's Root section**, and its own
   provenance says it is *"the founding lens, not a single incident — every other standard in this
   document is an instance of it."* The premise that placed it on the retire list (its incident is
   superseded) is not what the article rests on.
2. Retiring the 29 as a *deletion* would leave **27 surviving articles citing rules that no longer
   exist across 45 references**, and would break **5 of the 6 declared parent relations** — all
   pointing at *The Body and the Mind* — which an existing lint requires to resolve.
3. *Structure Decides Alone Only on an Exact Match* is the article **ruling 1a just amended**.
   Applied literally, 4a deletes the article 1a strengthened, one ruling later. That is itself an
   instance of the residual class ruling 1b names.

**One question decided as HOW, not escalated.** "Archival retirement" has no established structural
meaning here — the registry has never retired an article. Taken: the article stays in place and its
body becomes the retirement record naming what superseded it. That satisfies the operator's words
("each retired rule keeps a record naming exactly what superseded it"), keeps all 45 references
resolving, and keeps the parentage lint passing. Measurement 2 above is the cost of the *other*
reading, and is why this one was chosen.

**What is waiting.** A single bounded question: whether the four keep their articles with provenance
updated to say the incident is closed and what the rule still does — the other option the decision
package offered — or are retired regardless. The 25 are ready to apply the moment it is settled.

---

## 4b — The 14 unstated origins · **APPLIED-AND-VERIFIED**

**Changed.** 14 provenance lines. Five origins reconstructed with a citation to the sibling article
holding the evidence; three articles that carried **no provenance line at all** now state plainly
that they are values rather than earned rules; the rest relabelled per disposition. Zero retirements,
as ruled. No rule's force changed — the diff for these fourteen touches provenance lines only.

**One deliberate deviation from the audit's disposition, stated rather than buried.** The audit
classified *Agent Awareness* as provenance-lost. The incident was in the live registry the whole time
(the 2026-05-23 codey under-briefing, recorded in a sibling article). Writing "provenance lost" there
would have been a **new false label produced by the change whose entire purpose is honest labels**.
It is re-earned instead — which is what *keep and re-earn* asks for, not a departure from it.

**Proof.** Inspection against the operator's recorded ruling, reported as **inspection-verified** and
not dressed up as behaviour-proven.

---

## 4c — The nine rhetorical "recurring" claims · **APPLIED-AND-VERIFIED**

**Changed.** All nine, every one of which also falls inside the fourteen above, so each got a single
merged replacement satisfying both rulings. Five were **evidenced** with a real instance recovered
from the registry; four were **reworded** to an honest judgment claim where nothing was recoverable.
Evidencing was preferred over rewording wherever both were available, because the article then keeps
a claim it has actually earned. Every rule survived unchanged — only the unearned credential went.

---

## Reconciliation

| ruling | status | articles touched |
|---|---|---|
| 1a | applied-and-verified | 2 |
| 1b | applied-and-verified (sub-obligation named + countdown) | 0 articles, 1 new section |
| 2 | applied-and-verified | 53 (+1 via 1a), 1 new section |
| 3 | applied-and-verified (sub-obligation named + countdown) | 8, 1 new section |
| 4a | **returned — escalated, bounded to 4 of 29** | 0 |
| 4b | applied-and-verified | 14 |
| 4c | applied-and-verified | 9 (all inside 4b's 14) |

Article count unchanged at 87. Enforcement coverage unchanged at 0.7356 — an amendment that moved it
would mean narrative text had leaked into enforcement extraction, so the equality is the check.
Dangling references 0. Unrecognized sections 0.
