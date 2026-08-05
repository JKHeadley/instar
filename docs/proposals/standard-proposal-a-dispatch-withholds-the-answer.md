# PROPOSED STANDARD — not yet ratified

**Status:** PROPOSAL. Per *How a new standard joins this registry* step 2, the agent proposes and **the
operator ratifies**. Deliberately NOT written into `docs/STANDARDS-REGISTRY.md`.

**Proposed by:** Echo — Pathway, 2026-08-05. **Co-earned with the Observer**, who supplied the second
instance and declared himself in it unprompted.
**Proposed family:** The Substrate (sibling to *Verify the State, Not Its Symbol*).

---

### A Dispatch Supplies the Question and Withholds the Answer

**Rule.** When delegating a check — to a subagent, a dispatched lane, a peer agent, or a colleague — the
request must supply the **question** and withhold the **expected answer**. An expectation stated as fact
inside a request does not get tested by the check; it gets **adopted** by it. The check then returns the
requester's own belief carrying the authority of whatever method it used — and that authority is
precisely why the delegation was worth making. The same rule binds a *report*: a measurement and a
hypothesis about its cause must not travel in one undifferentiated claim, because the hypothesis
inherits the measurement's credibility.

**In practice.** Three teeth. **(A) No expectation in the prompt.** Never *"print X (expected: Y)"* —
instead *"print X, and separately state what the source says it should be."* A dispatched check will
independently ground its own expectations if you let it; supplying one adds nothing and can only
mislead. **(B) Make refutation explicitly valuable.** *"If the claim is wrong, say so plainly —
refuting it is the more valuable result."* Every dispatch framed this way in the crystallizing window
returned something the requester did not expect; the one carrying an expectation returned a wrong
verdict over correct data. **(C) Separate measurement from mechanism in reports.** State what was
measured, then state any causal hypothesis as a *separate, labelled* claim with its own evidence. A
report that fuses them transfers the measurement's credibility to the guess.

**Earned from.** **Two independent instances in one working cycle, from both ends of one conversation
— which is what earns a standard rather than a lesson.**

*Instance 1 (the agent).* Having been wrong three times that window by reasoning from a *reading*, I
dispatched a lane to settle a trust-boundary question **by execution** — the correct move. Then I wrote
into the prompt: *"print the actual returned operations for an unknown fingerprint **(expected:
empty)**."* That expectation came from a test's name **which I had established, that same hour, was
false**. The lane returned exactly correct values and a verdict of `DEFECTIVE`, because it compared them
against the expectation I supplied. Had I not read the permission table twenty minutes earlier, I would
have reported a live authorization defect on the strength of an execution I had contaminated. **What
caught it was not care** — the lane independently grounded the intended values from source and printed
them alongside. It was more rigorous than my prompt.

*Instance 2 (the manager).* Three hours earlier, he sent a real memory measurement and bundled a guess
about the mechanism into the same message. The measurement was sound; the guess was wrong. **It arrived
wearing the measurement's credibility**, and it shaped a ruling I then acted on.

**Traces to the goal.** Delegation exists to break the requester's anchoring — to get a reading from
somewhere the requester's assumptions do not reach. **An expectation encoded in the request reproduces
the anchor inside the instrument built to escape it**, and returns it in the most persuasive possible
packaging: *"I did not just reason about this, I ran it."* This is *Verify the State, Not Its Symbol*
applied to the act of asking: the answer you get is a symbol of the question you asked, and a question
containing its own answer certifies nothing. It is also why a coherent multi-agent system cannot be
built on politely-framed requests — **an agent that asks leading questions will build a consensus of
one, distributed across many minds.**

**Applied through.** ENFORCEMENT FIRST, stated honestly: **this is not enforced today, and adding it to
the registry would not make it so.** Landable surfaces in order:
1. **The dispatch-prompt template.** The agent-side lane dispatches are authored ad hoc; a shared
   template with the (A)/(B) clauses baked in makes the correct form the default form.
2. **A review-check in `/spec-converge`.** Any spec proposing a delegated verification step is asked
   whether its request supplies the answer.
3. **The cheap deterministic half:** a scan for expectation-shaped fragments (`expected:`, `should be`,
   `confirm that`, `verify it does`) in dispatch prompts — a *signal*, never a block, since some are
   legitimate.

**The honest test:** if this is ratified and lane dispatches keep carrying expectations, it is prose.

---

## What I am NOT claiming

- **Not that the lane erred.** It did exactly what it was asked, and its own rigour is what exposed the
  contradiction. The defect is entirely in the request.
- **Not that two instances prove generality.** Two is the registry's threshold for *recurrence*, not
  proof. A reviewer may reasonably argue this is one failure mode wearing two costumes.
- **Not that this is urgent.** It is filed where it can be found. Three decisions already await the
  operator.
