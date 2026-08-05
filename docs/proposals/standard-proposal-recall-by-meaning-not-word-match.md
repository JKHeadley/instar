# PROPOSED STANDARD — not yet ratified

**Status:** PROPOSAL. Agent proposes, operator ratifies. Deliberately NOT written into
`docs/STANDARDS-REGISTRY.md`.
**Proposed by:** Echo — Pathway. **Requested by Justin, 2026-07-27**, verbatim: *"If we don't already
have a 'search' standard that holds this awareness, we need one."*
**Proposed placement:** a tree node under **Intelligence Infers, Keywords Only Guard**.
**Written 2026-08-05** to satisfy the operator's second condition — a real-world case study attached
explicitly, rather than living in a ledger. **This document exists because the case was never attached,
not because it was never earned.**

---

### Recall Over Our Own Material Is by Meaning, Not by Word-Match

**Rule.** When the agent searches its **own** stored material — memory, learnings, knowledge base,
registry, plans, prior conversation — the retrieval must be by **meaning**, not by literal token match.
A keyword-only search returns *"no literal match in the tokens I happened to try,"* and that result is
**read as** *"this does not exist."* Those are different claims. Where only literal matching is
available, a negative must be reported as **`no-literal-match`**, never as an existence claim.

**Why this is not already covered.** *Intelligence Infers, Keywords Only Guard* forbids a keyword list
from deciding **what a human meant** in a message. Its object is inbound natural-language intent. It
does not reach retrieval over the agent's own corpus, and its enforcement — a lint over keyword lists
inside sentinel/gate/classifier code tested against message text — does not police repository, memory,
document, or registry search. *Intelligent Prompts* likewise governs only what happens inside an LLM
gate's prompt. The **principle** is ratified twice; the **surface** is unowned.

---

## The case study

**2026-07-27, topic 29723. Three findings in one afternoon, in this order.**

**16:43 — I presented a discovery I had already made, eight days earlier.** I was about to report to
Justin, as a new finding, that Telegram bots cannot see other bots' messages — so a topic post can look
successful while never reaching the intended bot pipeline. Before sending, I found this in my own
semantic store, timestamped **2026-07-19 17:20:23Z**:

> *"Telegram bot visibility limit — Telegram bots cannot see other bots' messages, which means a topic
> post can appear successful while still failing to reach the intended bot pipeline."*

**The same lesson, in substance word for word, written down eight days before I spent a morning
re-deriving it from scratch.** My own words at the time: *"That is today's discovery... written down
eight days before I spent this morning re-deriving it from scratch and presenting it to you as a
[discovery]."*

**17:08 — Justin asked whether we had a search standard.** He named two mechanisms he expected: LLM-driven
recursive search over files and text, and a vector store kept current so we could *"do semantic search
over all of our material."* He closed with the sentence that makes this proposal his and not mine.

**17:13 — the cause, and it was worse than "we never built it."** My report, verbatim:

> *"We have vector semantic search. It's fully populated. The recall path doesn't use it. All 2,852
> memory entries have embeddings — 100% coverage. There's a real vector search function that does proper
> nearest-neighbour matching on meaning. It exists, it works, and it is not what runs when I recall
> something. The recall path calls the keyword-only search instead."*

**The measured shape of the defect.** Not a missing capability. **2,852 of 2,852 entries — 100% —
carried the machinery for meaning-based recall, while the retrieval path ran on word-matching.** The
capability and the consumer were both present and not connected. The cost is measurable in exactly one
unit: a lesson correctly stored, correctly embedded, and re-derived from scratch eight days later,
because the recall path could not find it by meaning.

**Why it is a case study and not an anecdote.** It has a population (2,852 entries, 100% coverage), a
mechanism (recall calls keyword search while the vector path sits populated and unused), a dated
consequence (2026-07-19 written → 2026-07-27 re-derived, an eight-day gap), and a witness who is not me
(the operator independently asked for the standard the same afternoon). And the failure mode is the one
this standard exists to name: **a keyword miss is indistinguishable from an absence**, so I did not
experience it as a failed search — I experienced it as an original discovery.

---

**Earned from.** The case above. **One instance, and I am not inflating it** — but it is an instance
where the defect's signature is *invisibility*, which is precisely the class where instance-counting
under-reports. Every future recurrence would also present as a discovery rather than as a miss.

**Traces to the goal.** A self-evolving agent's memory is only worth what its recall can reach. An agent
that stores by meaning and retrieves by token match accumulates a corpus that grows while its effective
knowledge does not, and it cannot detect the gap from the inside: the report it gets is *"nothing
found,"* and it acts on that as *"nothing there."* This is *Intelligence Infers, Keywords Only Guard*
turned on the agent's own past instead of on the principal's message.

**Applied through.** ENFORCEMENT FIRST, stated honestly: **not enforced today.** Landable surfaces:
1. **A no-keyword-only-recall check** over the recall entry points, in the shape of the existing lint
   that guards keyword lists in gate code — the pattern exists, the surface is new.
2. **A reporting rule with teeth:** retrieval returns `no-literal-match` where only literal matching ran,
   so a negative cannot be worded as an existence claim. This is the sibling amendment
   (*declare what you measure and what you certify*) applied to search.
3. **The `/spec-converge` question:** *"does this feature search our own material, and if so, by what?"*

## What I am NOT claiming

- **Not that this is a live defect.** A message of mine dated **2026-07-28 00:10** states the fix shipped:
  *"memory search went semantic, keyword demoted."* **This is a historical case, and I have written it as
  one.**
- **Not that word-matching is always wrong.** It is correct and cheap for exact identifiers — a commit
  SHA, a filename, an article id. The rule binds recall over *meaning-bearing* material.
- **Not that one instance generalises.** It is one, with an unusually complete record.

## The question this raised and I did not chase

**I have not verified that semantic recall is still the live path today.** My evidence that it shipped is
a message I wrote on 2026-07-28, not a reading of current state — and *"a claim is not a fact until it is
measured"* is this window's entire finding, including when the claim is mine. Checking would have been a
sweep, and the constraint on this document was writing, not sweeping. **Named and left open:** *is
meaning-based recall still the path that runs, and is there anything that would tell us if it silently
regressed?* The second half of that question is the more important one, and nothing in this proposal
answers it.
