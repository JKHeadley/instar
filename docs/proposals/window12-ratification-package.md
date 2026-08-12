# ~~Window 12 — ratification package~~ — SUPERSEDED

> **Superseded by `docs/proposals/window12-DECISION-PACKAGE.md`.** That document is the one to rule on:
> it consolidates everything the window produced, corrects two counts this one carried ("127 findings"
> and "5 enforcement mechanisms" — the derived figures are 153 + 31, and 9), and is organised as
> decisions rather than findings. This is kept as the earlier snapshot.


**For the operator. Nothing here has been applied.** Every finding is archived verbatim and the registry
is untouched. I find and frame; ratification is yours.

Read in this order: what is ready to rule on, what is measured, what is honestly unresolved.

---

## 1. Ready for a ruling

### 1a. The precedence residual — `docs/proposals/precedence-gap-for-novel-collisions.md`

**Framed at its surviving width, not its headline width.** The claim "the registry has no precedence
mechanism" was **refuted**: status precedence applies to every family, there is a stated cross-family
tradeoff, and all four alleged collisions are locally resolvable. The originally proposed interim was also
**unsafe** — it would have required your ratification before sending *or* holding an ordinary clean reply
during a gate outage, freezing the live channel during exactly the failure the "user wins" rule handles.

What survives: no uniform fallback for a genuinely novel collision where both scopes apply, neither
article is pending, neither names the other, no governing/exception/composition/tradeoff clause settles
it, and the obligations cannot be jointly satisfied.

**Your decision:** whether that residual is worth naming, and if so whether the corrected interim
(preserve every deciding mechanism; escalate only on the residual) is the right shape.

### 1b. The one cross-family conflict that HELD

Three of four alleged conflicts were refuted. This one survived verification:

> *Structure Decides Alone Only on an Exact Match* (The Substrate) says structure may decide **alone** on
> an exact whole-message match, and the literal-match floor **always** stops.
> *Signal vs. Authority* (Interaction) says only a full-context intelligent gate has blocking authority,
> and a cheap matcher **may flag, never veto**.

**Ordinary case:** the operator sends exactly the stop word while the model gate is unavailable. One
article requires the deterministic floor to stop by itself; the other forbids deterministic blocking
authority. A careful agent follows the emergency-stop article on specificity — but that is a judgment, not
a rule the registry states.

**Your decision:** which governs, and whether the winner should say so explicitly.

---

## 2. Measured — the family audits

Ten reviews, two families, five lenses. **127 findings, none touched.**

| lens | question asked | Building | The Substrate |
|---|---|---|---|
| 1 | internal consistency | 2 | 2 |
| 2 | obligation reachability — *could an agent comply?* | 14 | 10 |
| 3 | falsifiability — *what would count as a violation?* | 23 | 18 |
| 4 | cost of compliance — *is the cost proportionate?* | 11 | 10 |
| 5 | failure-mode coverage — *does it prevent its own incident?* | **40** | **23** |

**The convergence question, answered honestly: NOT converged.** The fall at lens 4 did not hold; lens 5
returned more than any previous angle on both families. Sampled for quality before reporting — the bar
held. The lens-4 dip was cost-of-compliance being a narrower question, not the surface thinning.

**The second-order reading, which I think outranks the count.** Five lenses have each found what the other
four could not see, and the yield has not decayed. That is evidence about the *registry's construction* —
written article-by-article against real incidents, never audited along any single consistent axis — more
than about any individual article. A sixth lens would very likely find a sixth class.

### Findings worth surfacing above the pile

- **Zero-Failure, read literally, makes ordinary test-driven development non-compliant.** The suite must
  be green at all times; the first act of fixing a bug is writing a failing test.
- **Several obligations name no owner.** Cross-store coherence binds whoever introduces a new store pair —
  so for every pair that already exists, nobody owes it. Same shape for recording a discovered guard
  bypass.
- **Several triggers are author-declared**, which makes the obligation escapable exactly when it applies:
  a pipeline is supervised only if its author calls it critical; a feature needs full testing only if its
  author calls it significant.
- **Article 89 is itself unfalsifiable outside a canonical audit record** — nothing captures the
  measurement question, so an agent can paraphrase a repair chase and still claim the metric. Raised by
  the falsifiability lens against the article ratified this window.

---

## 3. Honestly unresolved

### 3a. The family-audit red stands

`tests/unit/standards-coverage-ratchet.test.ts` still fails one assertion: Building and The Substrate
audit records are stale. **Refreshing them would now be worse than this morning, not better** — 127
findings stand in front of those records, and recording an acceptance over them is precisely the forgery
the test's own comment forbids.

### 3b. The guard: not merged, no clean pair

Passes 39–45 ran on the laptop. Pass 45 returned **5 new** findings — the lowest of the series, and the
first reading to separate NEW from previously-stated-open, which is the measure that shows whether repairs
gain rather than conflating with the standing backlog. **Keep that split.**

Closed since the morning: a method arriving in a parameter; a DNS-root-dot host; escaped duplicate JSON
keys; a test-environment root; a mutable body reference; a **second read** introduced by the line meant to
fix the first; a method carrying content in more than one field; structured content checked as a string;
and alternatives treated as simultaneous.

### 3c. The RichText grammar — scoped, not patched

`docs/specs/rich-text-grammar-next-window.md`. The carriers and recursion are derived from the live
documentation; how a `RichText` holds its literal and represents a sequence could not be retrieved. A
partial fix would have widened a key-name sweep without closing the class — and because an unrecognised
structure is treated as undecidable and **allowed**, it would have left the bypass open while looking
covered. **This is the first clean item for next window.**

---

## 4. The process finding

The standing rule the operator set mid-window — *a cross-family or high-confidence finding gets a
cross-cutting verification lens BEFORE it is reported up* — **caught two overstatements of mine, and both
times the wrong version was the more quotable one.** Two alleged contradictions, refuted as artifacts of
reviewers unable to read the other side; and the precedence headline, refuted down to a narrow residual.

Separately, a near-miss in the opposite direction: I judged Telegram's `rich_message` a fabricated field
because it postdates my knowledge, and was one message from reporting a real bypass as a hallucination.
Fetching the live documentation showed it real. **Acting on a fabricated fact and discarding a true one
were a single verification apart — and the instinct to dismiss it felt exactly like rigor.**

Both directions have the same remedy, and it is now demonstrated rather than argued: verify before
reporting, most of all when confident.
