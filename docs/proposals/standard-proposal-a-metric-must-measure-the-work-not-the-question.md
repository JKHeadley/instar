# RATIFIED STANDARD — now live in the constitution

> **RATIFIED BY JUSTIN, 2026-08-10** — verbatim: *"approved, for both the spec and the standard"*, relayed
> through the observer on the operator account. **It is now article `metric-measures-the-work-not-the-question`
> in `docs/STANDARDS-REGISTRY.md`**, placed as a tree node under *Iterative Audit to Convergence* in
> **Building**, with the parent acknowledging it back.
>
> **This file is KEPT, not deleted** — the convention for a ratified proposal in this repository, verified
> against the existing ratified proposals rather than assumed. It is the record of what was argued and on
> what evidence; the registry carries the rule. Where the two differ, **the registry is authoritative.**
>
> **What the registry entry added that this draft did not have:** an enforcement fingerprint declaring
> `moments: none` (honest, and the closest of the seven recorded failure shapes — swept and reasoned rather
> than waved past), a `Documented-only until 2026-09-10` countdown, and a genuine sweep of the new article
> against all seven recorded failure shapes, each re-reached rather than re-stamped.

**Status:** RATIFIED 2026-08-10. Originally filed as a proposal; agent proposes, operator ratifies.
**Proposed by:** Echo — Pathway window 12, 2026-08-10. Discovered by the review series it describes,
evidenced from that series' own archive, and drafted by the agent whose work the series was measuring.
**Proposed family:** Building — engineering discipline.
**Proposed placement:** **a tree node under *Iterative Audit to Convergence*.** Placement reasoning is in
§4; it is a judgement, and it is the part most worth disagreeing with.

---

### A Metric Must Measure the Work, Not the Question

**Rule.** A trend in a repeated measurement is evidence about the work **only if the question that
produced it has varied.** Ask one question over and over and the number will fall as that question is
exhausted — and a falling number reads identically whether the work got sound or the question ran out.
So: **before a trend is credited, it must survive at least one reading that asks a different question.**
A trend that has never faced a changed question is an unvalidated instrument, and must be reported as
one — never presented as evidence the work is converging.

**In practice.** This is **a tree node under *Iterative Audit to Convergence***. The parent says an audit
is never one-off: sweep, fix, re-sweep until a clean pass returns zero new discoveries. This node names
the condition under which "zero new" is evidence at all. Re-running the *same* question to zero measures
that question's exhaustion; the parent's stopping rule is only sound when the sweeps have varied. Three
moves, in order:

- **(A) Record the question with the measurement.** A number archived without the question that produced
  it cannot be checked later, by anyone, including its author. This is the precondition for everything
  below and it is the cheapest of the three.
- **(B) Vary the question before crediting the trend.** One reading with a genuinely different question —
  not a rephrasing, a different *subject*: judge it fresh rather than judge the last repair; attack the
  instrument rather than the artifact; ask what the metric cannot see.
- **(C) Make the exclusions travel with the number.** Disclosing them at the source is not enough — the
  case below shows every reader doing exactly that, honestly, while the bare number went forward alone.
  A count that has been quoted without its exclusions has become a census, whatever its author wrote.
  **If a number is cited anywhere, its alternative reading is cited with it, or it is not cited.**

**The failing shape, stated so it is recognisable:** the number is falling, every reading is honest, every
repair is real — and the process is nonetheless converging on nothing, because each reading inherits its
predecessor's question. The tell is that no one can say what would have made the number go *up*.

---

## 1. Earned from — the case study, with its numbers derived

The crystallizing case is the window-11 external review series on branch
`echo/window10-deep-property-guards`: **29 adversarial readings**, each archived as its own verdict at
`docs/specs/reports/window10-external-passes/`. Every figure below was re-derived from those files during
window 12, not carried from the reports that announced them.

**The shape of the series.** A run of consecutive readings was given the same question: *what did the last
repair break?* — carried as a required section of the brief for readings **11 through 25**, which §2(d)
derives from the verdicts themselves. Their load-bearing counts fell, and the fall was read as the work
converging:

```
pass  17 18 19 20 21 22 23 24 25
count  6  2  3  2  3  3  3  2  1
```

**Reading 25 returned ACCEPT at load-bearing 1** — the first accept in twenty-five readings — and its own
metric section notes that under a strict reading its count is **0**.

**Then the question changed, and the same bytes failed.** Reading 26 was run against the identical commit,
`baa74e1eb`, with nothing repaired in between — both verdict files state that commit — and asked a
different question: *judged fresh, as a first reader, is this tree sound?* It returned **REJECT, load-bearing
4**, and recorded that none of its four findings was repair-induced, none appeared in any of the 24 archived
verdicts, and each was reproducible in one command.

Its own sentence is the finding this article exists to carry:

> *"The decline measured the exhaustion of the repair-chase, not the exhaustion of defects."*

**And the new question did not exhaust.** Under the changed brief the counts went `4, 7, 6, 6` — up, and
flat at six, across readings 26 to 29. Meanwhile the component that *was* genuinely depleting — defects
that pre-dated the current repairs — went `5 → 2 → 0` across readings 27, 28 and 29, while the totals
stayed at 7, 6, 6. **Two different populations were being counted as one number.** A merge decision reading
the total would have seen "flat"; a merge decision reading the substrate component would have seen "done";
neither is the whole truth, and the single published figure showed neither.

---

## 2. The three things that make this a metric failure and not a review failure

**(a) The metric did not exist for the first four readings.** Readings 1 through 4 carry no magnitude
section at all — derived by searching every one of the 29 files. Their values entered the published series
later, assigned by a reader looking backwards. Reading 9 says so in its own words, hedge included:

> *"Retrospectively applying the metric gives roughly `4 → 4 → 5 → 4 → 4 → 4 → 4` through the seven
> archived passes"*

A series whose opening values are a later reconstruction, carried forward without the word *roughly*, is
not a measurement of those readings. It is a reasonable guess that hardened into a data point.

**(b) The metric's exclusions were invisible at the point of publication.** Reading 28 deliberately did not
count two findings it recorded as major. Reading 29 counted out six of its twelve findings, including the
one it called *"the single most consequential thing in this pass"* — and then named the problem itself:

> *"a metric that cannot see it is a metric narrower than its purpose"*

Both exclusions were disclosed honestly inside the verdicts. Neither travelled with the number when the
number was quoted forward.

**(c) The trend's steps were smaller than the instrument's own disclosed judgment range — and every reader
said so, in a place nobody added up.** Five of the 29 readings publish an *alternative* count for
themselves, in their own verdict, alongside the number that entered the series:

| reading | published | its own stated alternative | what moved it |
|---|---|---|---|
| 10 | 5 | 4 | excluding one finding as contingent on another |
| 19 | 3 | 4 | whether an unauditable claim counts as a false one |
| 25 | 1 | 0 | a strict reading of one clause of the metric |
| 28 | 6 | 8 | two findings recorded as major and deliberately not counted |
| 29 | 6 | 12 | six of twelve findings counted out |

A sixth — reading 18's exclusion of a documentation defect as *"serious, but not machinery"* — was surfaced
not by itself but by reading 20, which also recorded the definitional break plainly:

> *"The metric is not constant across 18 → 19. Pass 18 reached 2 by excluding a falsely-closed documentation
> defect; pass 19 reached 3 by including account defects. **Part of that step is definitional, not
> empirical.**"*

**The decline that produced the accept ran 3 → 2 → 1.** One classification judgment moves a reading's value
by at least one. So **the trend was never resolvable by the instrument that produced it** — the signal was
inside the noise the readers themselves had disclosed. Not one of them was hiding anything; each stated its
alternative honestly, in its own file. What nobody did was read the disclosures *together*, because the
number travelled forward and the disclosures did not.

**(d) The question was never written down — but its SHAPE survived by accident, and that accident is the
proof.** No archived prompt exists for any of the 29 readings; searching the repository, its full history
for deleted files, and the agent's own decision records finds none. What *did* survive is that each verdict
answers a fixed set of headed sections, and **those section names are the questions.** Recovering them from
all 29 files dates every change to the brief:

| readings | the brief's required sections | what changed |
|---|---|---|
| 1–4 | findings, coherence, verdict | **no metric exists yet** |
| 5–9 | + magnitude, trajectory, own-account check | the metric is born |
| 10 | + convergence | |
| **11–25** | **+ regression-check** | **the repair-chase becomes a required section — 15 consecutive readings** |
| **26** | **regression-check GONE, fresh-attack-report ADDED** | **the question changes — and the accept is overturned** |
| 27–29 | both present | the doubled brief |

**This is the case study's central claim, verified from the tree rather than taken on anyone's word** — and
it corrects the span I was given. The repair-chase question is visible as a mandated section from reading
**11**, not reading 7: **fifteen readings**, not eighteen. The "passes 7–24" boundary is reading 26's own
retrospective characterisation and my predecessor's, and it is *not* visible on disk. The boundary that
**is** visible is eleven.

**The honest limit on this instrument.** A section missing from one reading may be that reviewer omitting
it rather than the brief changing — reading 17 and reading 25 each drop a section their neighbours carry,
and those look like omissions. So a single-pass absence is noise. What is not noise is a sustained change
across many readings, and a brand-new section name appearing for the first time: at reading 26 a section
vanishes and a *new* one appears in the same reading, which omission does not explain.

**And the accident is the argument.** The question was recoverable only because the brief demanded headed
sections and the reviewers kept them. Nobody designed that as a record of the question; had the brief asked
for prose, the change would be unrecoverable and this article would rest on assertion. **Move (A) asks for
one line so that the next series does not depend on that luck.**

**One figure I derived and then withdrew.** I tried to establish how many of the 29 readings stated their
own count rather than inheriting one. My first instrument searched for digits and returned 15 of 29; that
was wrong, because several early readings state their counts in words. The corrected instrument was
ambiguous in a different way — some matches were a reading counting *another* reading. **So there is no
number here.** A third attempt at a count, published inside the article about publishing shaky counts,
would have been the recursion rather than the lesson.

---

## 3. Traces to the goal

The founding goal is a coherent, self-evolving agent. Self-evolution runs on self-measurement: the agent
decides what to fix, and when it is done, by reading its own instruments. **An instrument that measures the
asking rather than the work makes an agent confidently wrong about itself** — and confidently wrong is the
one state from which no amount of further effort recovers, because the effort is aimed by the same broken
reading.

Its nearest relative in the registry is *Verify the State, Not Its Symbol*: that article forbids accepting a
proxy for the state. This one names a proxy that is easy to miss, because it does not look like a symbol at
all — **it looks like data.** A number, a series, a trend, produced honestly by real readers doing real
work. The substitution is not the number for the state; it is *the question's exhaustion* for the work's
soundness.

---

## 4. Placement — and why I am not proposing it as a Substrate property

**It fails the Substrate admission tests, and it fails them the same way its proposed parent did.** Test 1
asks whether it is a fact about the model rather than the software: it is not — measurement validity holds
identically for a human review board. Test 3 asks whether a competent engineer could derive it by reading
the code: this is process discipline, and the registry's own 2026-08-08 judgement moved *Iterative Audit to
Convergence* out of the Substrate for precisely that reason. **Building is the honest home.**

**Why a child of *Iterative Audit to Convergence* rather than a peer.** The parent's convergence criterion
— re-sweep until a clean pass returns zero new discoveries — **is the metric that failed here.** Window 11
did re-sweep, twenty-nine times, and it converged; it converged on the wrong thing because every sweep
inherited the question. This node does not contradict the parent, and it is not a separate subject: it
supplies the missing condition on the parent's stopping rule. That is a child.

**The claim I am deliberately not making.** The rule as written is scoped to a **trend produced by a
repeated measuring procedure**. It plainly *sounds* like it should govern every metric — coverage ratios,
grade rates, throughput, spend. I have one case study, and it is a review series. Extending the rule to all
metrics on one case would be asserting a set's shape without deriving its members, which is the operating
rule this window is under and the habit these 29 readings were convened to find. **If the broader form is
right, a second case will show up and the article can be widened then, in the open.**

---

## 5. Enforcement fingerprint — HONEST

**Documented-only until.** `2026-09-10` — tracked as `STD-COUNTDOWN-metric-measures-the-question`.
**This article would ship DOCUMENTED-ONLY, and that is a countdown, not a resting state.**

**What is enforceable today, and is not yet built.** Move (A) is mechanically checkable and cheap: an audit
or review record must carry the question its round asked. `scripts/write-audit-convergence.mjs` already
refuses a `converged:` stamp when the recorded rounds do not satisfy the criterion; the natural tooth is one
more refusal in the same validator — **refuse the stamp when every recorded round carries the same question,
or when any round records no question at all.** That is a closed-world format invariant at a dev-process
chokepoint, which is the documented Signal-vs-Authority exemption class the parent's gate already operates
under.

**What would close the countdown:** that refusal, built and proven two-sided by injection — a report whose
rounds all share one question must go red, and a report with a varied question must stay green.

**Coverage argument, including where it does NOT reach.** The violation has two shapes and only one has a
possible moment.

- **Covered, once built:** a convergence claim recorded in a canonical audit report whose rounds never
  varied the question. The rounds are in the file; the check can read them.
- **NOT covered by anything, and this is the more likely failure:** a trend quoted in a message, a commit
  body, a report to an operator, or a review prompt — where no audit record exists at all. **Window 11's own
  failure is in this uncovered class.** The falling series reached the operator in prose, was carried into
  the next reading's prompt as an established fact, and never passed through a record any validator reads.
  A guard on audit reports would not have caught it.

**So the honest summary is:** the rule is real, one third of it is cheaply enforceable at one chokepoint,
and the shape that actually bit us has no moment. Stating that plainly is the point — a partially-covered
rule read as enforced is how a fleet believes it has protection it does not have.

---

## 6. What ratification would mean

If ratified, three things follow, in this order:

1. **The review harness records its question with every verdict.** One line per reading, in the file. This
   is the whole of move (A) and it costs nothing.
2. **The convergence validator gains the refusal above**, proven two-sided, closing the countdown.
3. **The window-11 series is re-read once under the corrected instrument** — not to re-litigate its
   verdicts, but because the two populations it was folding into one number (repair-induced and
   pre-existing) are the actual merge decision, and they point in opposite directions.

**What I am asking for is ratification of the rule, not of the numbers.** Every figure here is derived and
cited to a file on disk; where a figure could not be derived, this document says so rather than supplying
one.
