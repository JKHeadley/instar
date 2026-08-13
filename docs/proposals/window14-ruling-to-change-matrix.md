# Window 14 — ruling-to-change matrix

**What this is.** The fidelity baseline for applying the seven rulings the operator made on the
Window-12 decision package (`8782b1d56` → `docs/proposals/window12-DECISION-PACKAGE.md`). Every row
states: the affected article(s), the exact ruled outcome, the enforcement consequence, the proof
required, and what is genuinely out of scope.

**Ruling source of truth.** `.instar/decision-package-rulings.md` (agent home) — the operator's own
words, captured one ruling at a time as he made them. This matrix does not re-litigate any ruling; it
translates each into a change. Where a ruling does not settle something, this document says so
plainly and the question goes back up rather than being guessed.

**Application base.** `origin/main` — the live rulebook. Not the 190-commit
`echo/window10-deep-property-guards` branch on which the audit was run. Reasons, each checked:

1. The charter's outcome is the rulings *visible in the live rulebook*; `main` is what is live.
2. That branch's own check suite refuses it, for reasons about **its** constitutional content (stale
   family audits; a family's reference-resolution below floor). Those refusals are real and unruled.
   Merging the rulings underneath them would carry unruled material in under a ruled change.
3. The two registries differ by **exactly two articles**, both additions on the branch, none removed
   or renamed — so `main` is a faithful base for the audit's subjects. Derived, not assumed:
   `git show origin/main:docs/STANDARDS-REGISTRY.md` has 87 `### ` articles, the branch has 89, and
   the set difference is the two named in "Out of scope" below.

---

## Scope, derived rather than quoted

Every count in this section was derived by command from the axis reports and `origin/main` at
2026-08-13 ~02:30 PDT, not carried forward from the decision package's prose. Where a derived figure
disagrees with the package, the derived figure is used and the disagreement is stated.

| set | package says | derived | resolves on `main` | note |
|---|---|---|---|---|
| silent failure directions | 57 | **56 grouped + 1 held** = 57 | 55 of 56 | *Signal vs. Authority* is the held-undecided one and is not inside the seven groups; the package's arithmetic is sound |
| paperwork-gate articles | 25 (15 + 10) | **25** (15 + 10) | 23 of 25 | — |
| superseded / retire candidates | 29 | **29** | **29 of 29** | — |
| unstated provenance | 14 | **14** | **14 of 14** | — |
| rhetorical "recurring" provenance | 9 | **9** | **9 of 9** | — |

**Two false alarms caught while deriving this, recorded because the habit matters more than the
result.** An exact-title match reported 21 silent-direction articles and 11 superseded articles as
"missing from trunk". Both were artefacts of the matcher, not the registry: the axis reports use
short names that are *prefixes* of the real titles (`Maturation Path` →
`Maturation Path — Test Agent → Development Agent → Fleet`), and one apparent absence
(`Conservative Outbound: Act, Don't Notify`) differed from trunk only by a curly versus straight
apostrophe. An over-broad matcher reporting holes is the exact failure this window's predecessor kept
finding in the guard; reporting either number would have been a fabricated scope problem.

### Out of scope — named, not silently dropped

Two articles exist **only** on the unmerged branch and therefore cannot be amended in the live
rulebook by this change:

1. **One Failure Teaches Every Guard — Record the Shape, Sweep It Everywhere** — appears in Ruling 2
   group 1 (change and release integrity) and in Ruling 3's judgment-bound ten.
2. **A Metric Must Measure the Work, Not the Question** — appears in Ruling 3's judgment-bound ten.

Both are branch-only *additions*; nothing is being removed from the live rulebook to create this gap.
Each is recorded here with a dated owner and route (below) rather than left to be rediscovered.

---

## Ruling 1a — Emergency stop versus blocking authority

**Ruled outcome.** The deterministic exact-match floor **governs** for a whole-message stop phrase,
**even when the intelligent gate is unavailable or offline**. Stated explicitly as a deliberate,
**narrow** exception — not a general grant of veto power to cheap matchers. The trigger is a
**whole-message exact match** (a real stop phrase), never a substring. The operator accepted the cost
explicitly: a cheap matcher holds veto authority in this one bounded case, because the opposite cost
— an emergency stop that fails during exactly the outage it is most needed in — is unacceptable.

**Affected articles (2, both on `main`).**

- *Structure Decides Alone Only on an Exact Match* (The Substrate)
- *Signal vs. Authority* (Interaction)

**The change.**

- *Signal vs. Authority* gains an explicit named exception: the emergency-stop exact-match floor is
  the one case in which a deterministic matcher carries blocking authority, bounded to a
  whole-message exact match, and it holds when the full-context gate is absent. The exception names
  the Substrate article rather than restating it.
- *Structure Decides Alone Only on an Exact Match* states that its authority survives the intelligent
  gate being unavailable, and that it is the named exception to *Signal vs. Authority* — so a reader
  arriving at either article finds the collision resolved rather than only one half of it.
- The exception is written so it cannot be read as precedent: it grants authority to *this
  enumerated floor*, not to matchers as a class.

**Enforcement consequence.** Both articles already have enforcement citations; this change alters
what those surfaces must permit, not whether they exist. The exception's bound (whole-message exact
match, never substring) is already the enforced behaviour of the existing exact-match test —
`structure-decides-alone-exact-match-only.test.ts` forbids prefixes and regexes and tests every
enumerated entry with appended text. The change makes the registry state what that test already
enforces, which is the cheap direction.

**Proof required.** A blind scenario pair: an exact whole-message stop phrase with the model gate
unavailable **halts**; the same word as a substring of a longer message with the gate unavailable
**does not halt**. Constructible mechanically.

**Also folded in, per the charter — and flagged as a derivation, not a quotation.** Item 2 held
*Signal vs. Authority*'s own failure direction undecided because it depended on 1a. With 1a ruled,
the direction follows: the deterministic floor governs **only** the enumerated exact-match stop, so
everywhere else a cheap matcher must not acquire veto authority when the full-context gate is absent
— *Signal vs. Authority* fails **OPEN** (the low-context detector may flag, never veto; the message
proceeds and the degraded check is recorded), with the enumerated exact-match floor as the sole
carve-out that still halts. This is derived from the operator's ruling rather than stated by him. It
is marked as a derivation in the change itself so a fidelity reviewer checks the inference rather
than the sentence.

**Out of scope.** Nothing.

---

## Ruling 1b — The precedence residual

**Ruled outcome.** Name the residual and add the escalation route — *"Yes, definitely the escalation
route."* When (and only when) the system hits a genuinely unresolvable collision, **escalate to the
user rather than silently guess**. Every existing tiebreaker stays exactly as it is and continues to
fire first; the residual clause fires only on the true residual.

**The operator's two additions, both required, neither optional.**

1. **Robust durable logging.** Escalating is not enough — every occurrence must be durably logged so
   these events are never lost track of. *An escalation without a durable record does not satisfy
   this ruling.*
2. **Each occurrence is a learning signal.** *"These scenarios will be very insightful into how we
   should update or modify our existing rules, so it can only be beneficial."* The logged events are
   to be reviewed and fed back into the rulebook — the net is a feedback source, not only a valve.

**Affected articles.** None amended. This adds a clause to the registry's own collision-resolution
rules, which today are distributed across articles (status precedence, the *user wins* cross-family
tradeoff, articles that name each other) with no stated fallback for the case where none applies.
The residual is defined by exhaustion: both scopes apply, neither article is pending, neither names
the other, no governing/exception/composition/tradeoff clause settles it, and the obligations cannot
be jointly satisfied.

**Enforcement consequence — this ruling has a build dependency.** The durable residual-collision log
does not exist. Per the charter, the minimal durable version is built as part of this application
(queryable; one record per occurrence), and the full review-and-feed-back loop is recorded as the
named next item rather than absorbed into this window. A rule whose enforcement is vapor is not
shipped: if the log cannot be built in this window, the ruling is returned with that named blocker
rather than applied as prose.

**Proof required.** A constructed residual collision escalates **and** leaves a durable, queryable
record; a collision that any existing tiebreaker resolves does **not** escalate and does **not**
record. Both directions, because a net that fires on everything is the unsafe failure here — it
would convert every ordinary resolved collision into an operator interrupt.

**Out of scope.** The periodic review of logged residuals that turns them into rule refinements —
named as the next item with an owner and a date, not built here.

---

## Ruling 2 — The 57 silent failure directions, as seven groups

**Ruled outcome.** *"Yes, this sounds right."* The seven grouped defaults are approved **as a block**,
including the load-bearing asymmetry: five groups fail CLOSED, two fail OPEN.

| # | group | default | articles on `main` |
|---|---|---|---|
| 1 | Change and release integrity | FAIL-CLOSED | 21 of 22 |
| 2 | Runtime state, identity, authority | FAIL-CLOSED (non-mutating route preserved) | 7 |
| 3 | Consequential judgment and autonomous action | FAIL-CLOSED | 7 |
| 4 | Workflow completion, admission, graduation | FAIL-CLOSED (blocks closure, not work) | 6 |
| 5 | Reachability and requested communication | **FAIL-OPEN** (record the degrade) | 3 |
| 6 | Outbound attention and unsolicited content | FAIL-CLOSED (direct replies preserved) | 4 |
| 7 | Advisory observation, monitoring, learning | **FAIL-OPEN and LOUD** | 7 |

Plus *Signal vs. Authority* → FAIL-OPEN, derived from Ruling 1a (see above).

**The change.** Each affected article gains an explicit statement of which way it fails when the
machinery it depends on is absent, naming *that article's own* machinery rather than restating the
group. The seven group defaults are also recorded once, as a block, so this is visibly one ruling
rather than 56 unrelated edits — and so a future article can be assigned a group rather than
re-arguing the question.

**Enforcement consequence.** The declared direction becomes inspectable. This extends the existing
Standards Enforcement Coverage surface (which already classifies each article's enforcement) rather
than adding a new one — the cheapest tier, consistent with Ruling 3's tier order.

**Proof required.** Per-group blind scenarios where mechanically constructible: with the named
machinery absent, a group-1/2/3/4/6 article refuses and a group-5/7 article proceeds and records the
degrade. Verified by inspection where the article's machinery cannot be disabled in a test.

**Recorded, explicitly NOT built (the operator's forward-looking additions).**

1. **Robust fallbacks are the real next level.** Choosing a direction is the floor; the better goal is
   fallback mechanisms good enough that the offline case is rarely reached. The operator said not to
   determine the specific fallbacks now.
2. **A fallback-coverage record** — a map of which machinery paths have a fallback and which do not.
   Named as the concrete near-term artefact, with an owner and a date.
3. **"Have a fallback path" as a candidate standard — RECOMMENDED, not REQUIRED.** The operator
   raised the tension himself: good practice, but it should probably not be mandatory because some
   deployments cannot provide independent redundant services. Captured as a deliberately
   unratified candidate, tiered recommended/aspirational, with the capability caveat stated. It is
   **not** ratified as a hard requirement in this change.

**Out of scope.** *One Failure Teaches Every Guard* (group 1) — branch-only.

---

## Ruling 3 — Paperwork-gates to behaviour checks

**Ruled outcome.** *"I say yes to both."* (1) The nine mechanisms covering the fifteen mechanisable
articles are approved as a block, **cheapest-first** — extend an existing surface before a lint over
artefacts, before a runtime record, before a periodic audit. (2) The ten non-mechanisable articles
are accepted as **judgment-bound** — an honest "a judgment holds this one" instead of a fake gate.

**The operator's addition, part of the ruling and not optional.** For the judgment-bound ten the
obligation shifts from "build a check" to "make sure the judgment is GOOD":

1. **Context sufficiency** — each judgment-bound rule must be exercised with the context it needs; a
   judgment made blind is the failure mode to prevent.
2. **Benchmark the judgment calls** — every judgment-call scenario is logged with its context, and
   the calls are periodically rated: how did they perform, how can they improve, what context were
   they missing. Judgment-bound is not unmeasured; the check is replaced by continuous evaluation,
   not by nothing.

**The change.** The nine mechanisms are recorded as authorised work with their tiers. The ten are
labelled JUDGMENT-BOUND in the registry using the existing "UNENFORCED SUB-OBLIGATION, named" +
countdown convention already in use, extended with the judgment-quality obligation — so the label
carries a duty rather than an excuse.

**Enforcement consequence — this ruling has a build dependency.** The judgment-call log does not
exist. Per the charter the minimal durable version is built here (each judgment-bound call recorded
with its context, queryable), and the rating loop is the named next item. Same discipline as 1b: if
it cannot be built, the ruling is returned with the named blocker rather than shipped as prose.

**Proof required.** For the mechanisms: each is recorded with its tier and the surface it extends —
authorisation is inspection-verified, since building nine mechanisms is not this window's scope and
was not ruled to be. For the ten: the label is present, carries the judgment-quality obligation, and
a judgment-bound call produces a log record with its context.

**Out of scope.** *One Failure Teaches Every Guard* and *A Metric Must Measure the Work, Not the
Question* — both branch-only, both in the judgment-bound ten, so eight of the ten are labelled here.

---

## Ruling 4a — The 29 superseded articles

**Ruled outcome.** Retire them — *"we need to have room for evolution which means some things must
die off and go away"* — archivally, each retirement record naming exactly what superseded it, with
**two required conditions**:

1. **The spirit lives on in higher-order rules.** **Where possible**, the retiring article's spirit is
   absorbed upward into higher-order rules that remain live. Retirement is evolution, not amnesia.
2. **Retirement must not orphan the superseding structure.** *"Removing the structures can't break
   the rules because the rules are gone."* Each retired article's replacement guard must remain bound
   to something live — a live higher-order rule covering it, and/or the coverage audit treating that
   guard's removal as a breach rather than a note.

**Affected articles.** 29, all present on `main`.

**Status: OPEN QUESTION — escalating, not guessing.** Condition 1 says "**where possible**". The
audit's own text for each of the 29 ends by naming what that article *still* does — e.g. the first
entry, *Structure beats Willpower*, "still supplies the registry's root enforcement principle and
coverage ratchet". For an article that **is** the higher-order rule, absorption upward has no target,
and the two readings of the ruling diverge:

- retire it anyway, and its remaining live work is lost — which contradicts condition 1; or
- it falls outside "where possible", and keeps its article with the provenance updated to say the
  incident is closed — which is the package's *other* offered option, not the one the operator picked.

The operator ruled on a summary that said the 29 were earned from incidents that can no longer recur.
Whether he intended the root-level articles among them to be deleted is not settled by his words, and
the charter is explicit that ambiguity about what he ruled comes back up rather than being guessed.

**What is being done rather than waiting.** A lane is classifying all 29 into ABSORBABLE (with the
named live target article and the overlapping sentence quoted), NOT-ABSORBABLE-ROOT (the article is
the higher-order rule), and NOT-ABSORBABLE-ORPHAN — and answering condition 2 per article: whether
the superseding structure would remain bound to something live after retirement, or become
silently deletable. The escalation is then a bounded question over a named subset with a concrete
proposal, made once, rather than a general "are you sure?".

**Proof required (once ruled).** Retirement leaves the successor structure protected: for each
retired article, the guard that superseded it is still required by something live, and its removal is
treated as a breach by the coverage audit rather than passing silently.

**Out of scope.** Nothing yet — pending the ruling above.

---

## Ruling 4b — The 14 unstated origins

**Ruled outcome.** *"Yes, I agree."* Zero retirements — all fourteen do real work. Five origins
reconstructed from evidence already quoted in the registry; four kept and re-earned, labelled
honestly as *provenance lost* with the named re-earning evidence recorded; five relabelled as
**principle** (stated values, never incident-derived — labelling a principle as incident-earned is
itself the defect). Labels get honest; **no rule changes force**.

**Affected articles.** 14, all present on `main`.

**The change.** Each article's provenance line is replaced: reconstructed origins written in with a
citation to where the evidence lives; the four re-earn candidates labelled as provenance-lost with
the specific evidence a future instance must show; the five principles relabelled so the field stops
claiming an incident (`Grounded in` / `Articulated during` / `Ratified from operator policy` rather
than `Earned from`).

**Enforcement consequence.** None — this is a truthfulness change to provenance metadata. It does
interact with the enforcement-coverage audit only in that a `Grounded in` field must not be read as a
missing `Earned from`.

**Proof required.** Inspection against the operator's recorded ruling, reported as
**inspection-verified** and never dressed up as behaviour-proven. Plus a mechanical check that no
rule text changed — the diff for these fourteen touches provenance lines only.

**Out of scope.** Nothing.

---

## Ruling 4c — The nine rhetorical "recurring" claims

**Ruled outcome.** *"Yes, I agree."* Required: each of the nine either produces a real logged instance
— and is then genuinely earned — or is **reworded to what it can honestly claim**, a judgment of risk
rather than an incident history. **The rule stays; only the false credential goes.**

**Affected articles.** 9, all present on `main`. Several overlap Ruling 4b; those get one merged
change satisfying both.

**The change.** Per article: evidence it (citing the instance) where an instance is recoverable from
the registry, otherwise reword the provenance to an honest risk judgment. Evidencing is preferred
over rewording where both are available, because the article then keeps a claim it has actually
earned.

**Enforcement consequence.** This is the first ruling that makes "recurring" a checkable claim rather
than a rhetorical one — which is also why the registry's own joining rules matter here: *How a new
standard joins this registry* step 1 says a lesson crystallizes "after a pattern has **recurred**
enough times". Going forward, the 1b and 3 logging additions are what make that word verifiable.

**Proof required.** Inspection: no article in the nine asserts empirical recurrence without a named
occurrence. Mechanically checkable as a lint over the provenance lines, which is the cheap direction —
recorded as a candidate, not built here unless it falls out of the change.

**Out of scope.** Nothing.

---

## Completion bar for this window

Every one of the seven is either **applied-and-verified**, naming the articles actually changed, or
**explicitly returned** with a named blocker. No silent partial application, and no ruling silently
absent from the record.
