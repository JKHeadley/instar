# PROPOSED STANDARD — not yet ratified

**Status:** PROPOSAL. Agent proposes, operator ratifies. Deliberately NOT written into
`docs/STANDARDS-REGISTRY.md`.
**Proposed by:** Echo — Pathway. **Requested by Justin, 2026-07-27**, verbatim: *"If we don't already
have a 'search' standard that holds this awareness, we need one."*
**Proposed placement:** a tree node under **Intelligence Infers, Keywords Only Guard**.
**Written 2026-08-05** to satisfy the operator's second condition — a real-world case study attached
explicitly, rather than living in a ledger. **This document exists because the case was never attached,
not because it was never earned.**

> **STATUS OF THE CASE: CURRENT, established by measurement on 2026-08-05.** Not historical — which is
> what this document claimed in its first version, on the strength of a message of mine rather than a
> reading of state. **Short form: the embedding path works and is reachable at
> `/semantic/search/hybrid`; the endpoint the capability list documents as *the* search endpoint,
> `/semantic/search`, is keyword-only — and identifies itself as such by erroring in SQLite FTS5
> syntax.** Probes in *MEASURED 2026-08-05* below.

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

---

## MEASURED 2026-08-05 — the case is **CURRENT**, not historical

**This document first labelled the case historical, citing a message of mine from 2026-07-28 stating
*"memory search went semantic, keyword demoted."* The operator challenged the label: that is a message
asserting a state, not the state — the exact substitution the parent standard of the sibling amendment
forbids. He declined to say which answer he expected. I exercised the retrieval path instead of reading a
claim about it, and the label was wrong.**

### The discriminator

A **pure vector** search always has nearest neighbours, so real words absent from the corpus still return
results. A **keyword** search returns nothing. Probe: `photosynthesis chlorophyll stomata`.

| surface | absent-but-real words | term known present | verdict |
|---|---|---|---|
| `/semantic/search` | **0** | 20 | **keyword** |
| `/semantic/search/hybrid` | **20** | 20 | **vector** |
| `/memory/search` | **0** | 4 | **keyword** |

**Corroboration, unprompted:** `/semantic/search` and `/memory/search` both answer a query containing a
comma or apostrophe with `{"error":"fts5: syntax error"}`. **FTS5 is SQLite's full-text keyword engine.
The endpoint named *semantic* identified its own implementation by erroring in the keyword engine's
dialect.** A second signature: `/memory/search` cannot find an entry by its **exact stored title** —
`"Telegram bot visibility limit"` returns **0**, while the single token `"Telegram"` returns **10**.

### The vector path works — where it is wired

Controlled test with known ground truth. Target content: *"An automated grounding check blocked a
nothing-found claim and forced the agent to question whether the source itself was incomplete..."*
Query, sharing **no distinctive vocabulary** with it: *"a safety filter refused an assertion of absence
prompting doubt about whether the material consulted was missing parts..."*

On `/semantic/search/hybrid` the target returns at **rank 10 of 20**, and the top four hits are all
on-meaning — *treated absence as proof*, *assuming how a guard worked instead of opening the file*,
*tools must distinguish absence from success*, *report observed absence explicitly*. **That is retrieval
by meaning, with zero lexical overlap. The capability is real and it functions.**

### So the finding, restated precisely

**The embedding capability is present, populated, and working — and the plainly-named default retrieval
surface does not use it.** That is the 2026-07-27 defect's exact shape, still true, one layer over: the
working vector path is at `/semantic/search/hybrid`, while `/semantic/search` — **the endpoint the
capability list documents as the search endpoint, and the one any agent reading its own capabilities
would call** — is keyword-only. `hybrid` is not in the documented set.

**In one respect this is worse than the original.** In July the vector function was unwired: a capability
nobody called. Today it is *misnamed*: the keyword path is the documented default and wears the word
"semantic," so an agent doing the correct thing — reading its capability list and calling the search
endpoint — gets word-matching and a name that tells it otherwise. **A keyword miss from an endpoint
called `semantic` is not just indistinguishable from absence; it is affirmatively mislabelled.**

**Consequence for this proposal: it is strengthened.** A live gap between a capability and its consumer,
still able to cost re-derivations, is a materially stronger case for the standard than a closed one — and
the remedy is now specific and small: make the documented default the vector path, or rename the keyword
one so nothing calls it expecting meaning.

## What I am NOT claiming

- **Not that word-matching is always wrong.** It is correct and cheap for exact identifiers — a commit
  SHA, a filename, an article id. The rule binds recall over *meaning-bearing* material, and the defect
  here is a keyword path **named** semantic and **documented** as the default.
- **Not that one instance generalises.** It is one, with an unusually complete record — now including a
  measurement of current state rather than a claim about it.
- **Not that the July fix was fictional.** A vector path *was* wired; my 2026-07-28 message was not false
  so much as **imprecise about which surface**, which is exactly how a proxy claim passes for a state.

## Two readings of mine that the measurement refuted

Recorded because both were mine, in this session, while doing the verification:

1. **I read `nonsense → 0` as evidence the ranker discriminated.** It is the opposite: a vector search
   *always* returns nearest neighbours, so zero means the query terms had to appear literally. **The
   result I took as proof of quality was the signature of the defect.**
2. **I read the similarity numbers as distances** because an exact-title match scored *lower* than
   unrelated hits. The real explanation was that the exact-title query was running on the keyword path
   and the others on a differently-scored one. **I explained an anomaly with a theory instead of checking
   which surface produced each number.**

## The question this raised and I did not chase

**Is there anything that would tell us if meaning-based recall silently regressed again?** Nothing found
here monitors which surface recall actually calls; both times this defect was caught, it was caught by a
human noticing a re-derivation or challenging a label. **That is the more important half of the original
open question and it remains unanswered.** Naming it rather than chasing it, per the constraint.
