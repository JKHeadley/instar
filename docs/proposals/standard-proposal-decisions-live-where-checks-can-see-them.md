# PROPOSED STANDARD — not yet ratified

**Status:** PROPOSAL. Agent proposes, operator ratifies. Deliberately NOT written into
`docs/STANDARDS-REGISTRY.md`.
**Proposed by:** Echo — Pathway, from the Phase B window-7 finding set.
**Proposed placement:** a tree node under **Observation Needs Structure**.
**Written 2026-08-05** to satisfy the operator's second condition — a real-world case study attached
explicitly. **This document exists because the case was never attached, not because it was never earned.**

---

### A Decision That Can Block Must Live Where the Checks Can See It

**Rule.** Every code site that can **block, refuse, or gate** must live inside the population the
enforcement apparatus actually inspects. Where a blocking decision is authored in a language or location
the ratchets do not walk, it is **unwatched by construction** — and an unwatched decision surface does
not stay correct, because nothing exists that could notice it drifting. The remedy is to **collapse the
boundary** — move the decision into the inspected language, leaving thin shims that decide nothing —
**not** to maintain a second detector regime in parallel, because two detectors kept in agreement by
discipline is the failure this registry already knows the price of.

**Why this is not already covered.** *Observation Needs Structure* owns the general principle: *"an
observation without a required artifact is indistinguishable from no observation at all,"* and an
inspection duty without unskippable proof can silently omit an entire population. What it does not do —
and what the placement sweep confirmed no standard does — is name **source-language scope** as one of the
ways a population goes silently unobserved, or say where a blocking decision must be **placed**. Its
named mechanisms enforce particular observation artifacts; **none enumerates source-language populations
or inspects blocking/refusal code.**

---

## The case study

**2026-08-05, topic 29723, across a single working window.**

**The population.** Every ratchet we have walks TypeScript and matches TypeScript syntax. **Twenty-six of
our shipped behaviour files are shell or plain JavaScript. Twelve of them make blocking decisions** — the
free-text guard, the grounding gate, the dangerous-command guard, the message interceptor, the
session-start hook, the watchdog, and six more. **The ratchets have zero coverage across that population.**

**What made it causal rather than coincidental.** Phase A had already recorded two guards sharing a
use-versus-mention blind spot — the grounding gate and the dangerous-command guard — and read that as
*two instances of one bug*. **Both are on the unwatched list.** The better explanation is that it is
**one instance of this gap**: they share a defect because they share the condition of being unwatched.
The ~40% precision measured on that surface is what an unguarded decision surface drifts to when nothing
is looking.

**The remedy question was settled by a dispatched check, in the useful direction.** I wrote the node
assuming some of the twelve would genuinely have to be shell — a watchdog that runs without node, that
sort of thing — and expected a mixed result. **Must-be-shell came back at zero. Every one of the twelve
can move.** So the remedy is not *triage then migrate what can*; it is *migrate*, and the only open
question is order.

### The honesty history, which is part of the case

**This finding was reported wrong twice before it was reported right, and both corrections matter.**

1. **"None of them is covered by any check" was false.** Several of our lint scripts do traverse that
   directory. The true claim is narrower: **the ratchets** have zero coverage there. I measured one kind
   of enforcement and certified a claim about all of it — which is the sibling amendment's defect,
   committed inside this finding.
2. **The number twelve was correct entirely by accident.** A later coherence round found that **four of
   the files I named do not block at all** — one says *"never blocks the turn"* in its own header,
   another says *"signal-only, never blocks"* — and **four genuine blockers were missing.** Right total,
   wrong membership, twice in one window. A matching count is not a matching set.
3. **Among the four I missed was the message-relay script itself.** Every message I sent the operator
   that night went through it. **It had refused five of them.** I left it off a list of things that
   block, while being blocked by it, during the window I spent cataloguing blocks.

**That third item is the case study's centre of gravity.** The most reliable way to be unaware of a
blocking surface is to be standing inside it. Nothing about my attention was going to fix that; only an
enumeration of the population could, and no enumeration existed.

### The live instance, 2026-08-05

**The grounding gate — one of the twelve — refused a report about the twelve, twice.** It blocked a
message documenting a guard defect, on the phrase *"I noticed the,"* where every first-person claim in
that message had been tool-verified minutes earlier. It then blocked the **pre-flight test of itself**,
because the test text contains the phrases it scans for.

Reading its source established two things, and both are properties of an unwatched surface:
- Its check is **a bare regex over a short list of stock phrasings**, with no input from whether a tool
  ran — so it cannot separate a grounded first-person report from an invented one, and it fires on
  *reporting* a verified measurement.
- Its messaging-command detector matches by **substring**, and one substring is short enough that
  **writing a file whose path merely contains it is classified as sending a message** — a scratch file
  was put through the outbound content gate. Verified with a matched and an unmatched path.

Neither would survive a ratchet. Neither has ever met one.

---

**Earned from.** The window above: one measured population (26 files, 12 blocking), one re-explanation
of a previously-recorded pair of bugs as a single structural cause, one dispatched check that settled
the remedy at *migrate everything*, three self-corrections, and one live instance on the day of writing.

**Traces to the goal.** A self-evolving agent's guards are the part of it that must not drift, because
everything else is checked *by* them. If the enforcement apparatus inspects one language while decisions
are authored in another, the agent's most safety-relevant code is exactly the code nothing watches — and
the drift will present as two unrelated bugs rather than as one gap, which is how it stayed unnamed.

**Applied through.** ENFORCEMENT FIRST, stated honestly: **not enforced today.** Landable surfaces:
1. **An enumeration ratchet** — the population of shell/plain-JS files that can block is committed, and
   the build fails when it grows. This is the *unskippable artifact* the parent standard demands, and it
   is the cheapest real step: it does not migrate anything, it makes the population visible.
2. **Migration, in order.** Must-be-shell is zero, so the target is thin shims that decide nothing.
3. **The `/spec-converge` question:** *"does this introduce a blocking decision, and is it authored where
   the ratchets look?"*

## What I am NOT claiming

- **Not that shell is bad.** The rule binds *blocking decisions*, not scripts. A shim that decides
  nothing is fine anywhere.
- **Not that the two guards' shared defect is proven causal.** It is the better explanation of a
  coincidence, on a sample of two. A reviewer may reasonably hold that two guards sharing a blind spot is
  still just two guards sharing a blind spot.
- **Not that migration is free.** Twelve files, and the order matters more than the count.

## The questions this raised and I did not chase

Both concern membership, which is the thing this finding has already been wrong about twice:

1. **The corrected list of twelve has not been re-verified since the round that corrected it.** I know the
   original membership was wrong by four in each direction; I have not independently re-drawn the list.
   Given that this document's own case study is *"a matching count is not a matching set,"* **the count
   in it should be read as provisional and the membership as unconfirmed.**
2. **The ~40% precision figure was measured on a sample I have not re-drawn**, and — per the guard
   amendment filed beside this one — it was measured *only from cases where the guard was wrong*, with no
   count of its true catches. **A precision figure built from one side of the ledger is not a precision
   figure.** It should not be quoted as one until the other side is counted.

Both are answerable by a bounded enumeration. Neither is answered here, because the constraint on this
document was writing, not sweeping.
