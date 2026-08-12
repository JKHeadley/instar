# PROPOSED AMENDMENT — Documentation Claims Resolve to Function

**Status:** PROPOSAL. Agent proposes; operator ratifies. This document deliberately does **not**
modify `docs/STANDARDS-REGISTRY.md`.
**Proposed by:** Codey — in response to the window-10 brief on *Documentation IS Being*.
**Proposed placement:** amendment to the existing *Documentation IS Being* article, not a new
constitutional article.
**Written:** 2026-08-08.
**Measured against:** `origin/main` at `1f0a89e69`.

---

## The proposal

A documentation claim that can be reduced to a closed input and a production answer must resolve to
the function or registry that supplies that answer. The guard must run that authority and compare its
observed result with what the document presents. A mention, matching filename, type declaration, test
fixture, or second hand-maintained manifest is not enough.

This is a bounded amendment, not a claim that prose can be made universally true by lint. It protects
mechanically falsifiable statements such as:

- whether a stated local HTTP method and route are registered in the production route composition;
- whether a documented config path is consumed by a real production decision seam;
- what value the production resolver returns for an absent config key under a declared context; and
- whether a displayed inventory or count equals the authoritative population that generated it.

It does **not** certify whether an explanation is clear, whether a policy is wise, whether an example
is representative, whether a design expresses the right ontology, or whether the documentation says
everything a reader needs. Those remain review judgments. The guard's job is narrower and harder:
when the documentation says something the program can answer, make the program answer it.

## Measure first: the actual population

The first pass measured `README.md`, `docs/**/*.md`, and the site documentation under
`site/src/content/docs/**/*.{md,mdx}`: **2,090 files**. The scan deliberately counted only
high-confidence syntactic claim candidates; it did not ask an LLM to decide what sentences “sound
technical.” The counts below are discovery evidence, not enforcement evidence.

### Explicit route claims

An explicit route claim is a method/path pair such as `GET /health`, with parameter spellings
normalized (`:id`, `{id}`, and `<id>` are the same shape).

| Population | Occurrences | Unique method/path claims | Directly matched to a static source registration | Unmatched candidates |
|---|---:|---:|---:|---:|
| Full measured corpus | 2,947 | 1,027 | 824 | 203 |
| Current reader surface (`README` + site; 95 files) | 832 | 689 | 682 | 7 |

The source scan found **899 literal `router/app/server.<method>(path, ...)` registration sites**.
That source number is not treated as the runtime truth: it misses composed mount prefixes and dynamic
registration, and a registration-looking call can still be dead. It is enough to show that the
population is large and that a mention checker is the wrong tool.

The seven unmatched current-reader claims demonstrate why classification must precede enforcement:
five are deliberately generic `/resource` examples in the API guide. The remaining two read as live
instructions and contradict the registered methods:

- the multi-machine guide names `GET /pool/machines/:id`; the production route is `PATCH` at that
  path and no `GET` registration exists; and
- the hooks guide says to inspect `GET /hooks/events`; production has `POST /hooks/events` and
  parameterized `GET /hooks/events/:sessionId` reads, but no unparameterized `GET`.

The broader corpus contains the same kind of proved drift: `docs/THREADLINE.md` still names
`GET /threadline/messages/thread/:id`, while the production source explicitly records that the
placeholder was deleted and names `GET /threadline/threads/:id` as the canonical history read.

There is also a self-falsifying count in the current API page: it says the full surface contains
**460 routes**, while the inventory immediately beneath that sentence contains **541 route bullet
entries** (546 explicit method/path pairs when its five generic examples are included). The source
scan finds 899 literal registration sites. Whichever population the prose intended, 460 no longer
describes either one. This is exactly the class of stale self-description the proposed guard should
make impossible.

### Config-path claims

The scan then counted backticked dotted paths rooted in one of the **78 top-level fields** of
`InstarConfig`, excluding obvious filenames:

| Population | Occurrences | Unique config-path candidates | Exact property-chain match | Unmatched candidates |
|---|---:|---:|---:|---:|
| Full measured corpus | 1,150 | 468 | 176 | 292 |
| Current reader surface | — | 56 | 29 | 27 |

The important result is not “292 dead keys.” It is that static property-chain matching cannot decide
the question. Every one of the 27 current-reader misses has its leaf name somewhere in production
source, commonly behind an alias or destructure such as a local `mm` block rather than
`config.multiMachine`. Widening the matcher to leaf names would convert under-matching into false
resolution: a common leaf such as `enabled` occurring elsewhere proves nothing about the documented
path. A type declaration also proves only that the key is permitted, and `ConfigDefaults` proves only
that a value may be seeded. Neither proves that changing the key reaches behavior.

Therefore a config claim is mechanically certifiable only where the guard can drive the real
consumer or the same pure resolver the consumer invokes. The static scan discovers candidates and
debt; it never grants “resolved.”

### Default claims

Across the full corpus, **408 prose blocks** couple a default assertion with at least one parseable
config path, covering **336 unique keys**. The current reader surface alone contains **26 such blocks**
covering **32 keys**.

“Default” is not one value in this codebase. It may mean a persisted init default, a more conservative
migration default, an inline code fallback, absence, or an effective value resolved from agent type,
development-agent status, platform, or another gate. For example, the current reader documentation
calls `monitoring.parallelWorkSentinel.enabled` “off by default,” but production sends an absent value
through `resolveDevAgentGate`: it is live on a development agent and dark on the fleet. A checker that
looks only in `ConfigDefaults` will find omission and invent an answer. A checker that chooses one
runtime context will certify a sentence that is false in the other.

The mechanically checkable form is therefore a typed tuple, not a sentence containing the word
“default”:

`(config path, lifecycle, agent kind, development status, relevant environment, expected value)`

If the document omits a context on which the result varies, the claim is under-specified and must not
be certified.

## The boundary: when a claim is mechanically falsifiable

A documentation claim belongs in the mechanical population only when all four conditions hold:

1. **Closed subject:** the subject has a stable identity, such as an HTTP method/path, config path,
   registry key, or generated inventory.
2. **Closed context:** every input that can change the answer is declared. A context-dependent default
   with no context is not closed.
3. **Production authority:** the answer comes from the production composition, registry, or pure
   resolver actually consumed at the live seam. A parallel parser or documentation-only table is not
   authority.
4. **Exact comparator:** the observed answer and the documented answer have a deterministic equality
   or relation. “Exists,” “equals false for fleet init,” and “count is 899” qualify; “is safe,” “is
   clear,” and “is the right design” do not.

Claims outside that boundary remain human review. Some may later cross the boundary when the code
gains a real probe. Until then, calling them enforced would manufacture exactly the protection this
brief warns against.

## Proposed implementation shape

### One authority, two consumers

Do not build a documentation-facts database that independently repeats routes, keys, and defaults.
Each claim adapter must consume the same authority production consumes:

- **Routes:** construct the real production router/app composition and inspect its mounted route
  table. Static source extraction remains a census and discrepancy signal, not the verdict.
- **Config consumption:** run a paired-input probe through the real consumer or its shared pure
  resolver, changing only the documented key. A type or default entry without a behavioral consumer
  stays unresolved.
- **Defaults:** call the production resolver with the declared lifecycle and agent/environment
  context. Absence is an input, not a value guessed from a defaults file.
- **Inventories and counts:** render from the authoritative population. The checked-in prose never
  owns a hand-written count.

Where no pure seam exists, the honest implementation work is to extract the production decision into
one and make both runtime and guard call it. A test-only replica is not sufficient.

### Generated facts, not invisible metadata

For machine-owned values, generate the **displayed text** between stable markers and compare it byte
for byte in `--check` mode. An adjacent hidden assertion is not enough: metadata could say the default
is `false` while the sentence a reader sees says `true`, and the guard would protect the wrong layer.

Small generated spans/blocks are sufficient:

- the live route inventory and its count;
- contextual default tables for documented config switches; and
- compact config-key summaries whose values come from real resolvers.

Narrative prose remains authored around those facts. The generator owns only the closed answer, not
the explanation.

### Candidate discovery and truth scope

Add a deterministic claim-discovery lint for explicit method/path pairs, config paths coupled to
default language, and generator-owned count/inventory blocks. It should classify each candidate by
document truth scope:

- **live/local:** must resolve against current production authority;
- **proposal:** describes a candidate design, never current runtime;
- **historical:** is tied to a named version or commit if mechanical verification is desired;
- **external:** depends on an outside system and cannot be certified by the local build without a
  pinned external authority; or
- **example:** explicitly non-literal teaching syntax such as `/resource/:id`.

`README.md` and the site documentation default to `live/local`; an author cannot make a false current
claim disappear by omitting a tag. Proposal, historical, external, and example scopes must be explicit
and bounded. The classification is not a waiver: it prevents a proposed or third-party route from
being compared to the local server while also preventing it from masquerading as a current local
instruction.

### Debt and rollout

Do not baseline unresolved claims and then call the article enforced. Roll out in two honest rings:

1. **Strict current-reader ring:** classify the seven unmatched route claims, correct the two live
   contradictions, generate the API inventory/count, and enroll contextual default claims that have
   production resolvers. New unresolved live claims fail immediately.
2. **Shrink-only extended ring:** inventory the wider `docs/` corpus by stable claim identity and
   truth scope. A new unresolvable live claim or a larger unresolved population fails; existing debt
   is visible and may only shrink. This ring is explicitly uncertified until its debt reaches zero or
   every remainder is truth-scoped outside current local runtime.

The guard report must publish the denominator by claim kind and scope: discovered, mechanically
resolved, explicitly non-live, unresolved, and contradicted. “All checked claims pass” with an empty or
shrinking discovery population is not success.

## What the guard would measure and certify

**Measured:** mechanically shaped claim candidates in the enrolled corpus; their declared truth
scope and context; the production authority invoked; expected and observed values; generated bytes;
and unresolved/contradicted debt.

**Certified:** only that every enrolled `live/local` mechanical claim still agrees with its production
authority under the declared context, and that the enrolled population did not silently shrink or gain
unresolved claims.

**Not certified:** completeness of documentation; clarity; conceptual correctness; causal explanation;
semantic adequacy; the wisdom of a default; the correctness of proposed or external systems; or the
truth of an un-enrolled human-judgment sentence.

That boundary means the implementation can give *Documentation IS Being* real teeth without claiming
that a build has proved the whole document true.

## Negative controls the implementation must survive

1. **Deleted live route:** remove a production route while leaving its generated/current-reader claim.
   The guard must fail that exact claim, not merely notice a changed count.
2. **Wrong method:** change the visible claim for `PATCH /pool/machines/:id` to `GET` without adding a
   real GET registration. A path-only matcher must not pass.
3. **Dead config key:** leave a path in `InstarConfig` and `ConfigDefaults`, but disconnect the real
   consumer. A declaration/mention checker would pass; the paired behavioral probe must fail.
4. **Alias trap:** consume a config block through a local alias. The production probe must pass even
   though the literal full property chain is absent from source.
5. **Context-free default:** claim `parallelWorkSentinel` is simply “off by default.” The guard must
   refuse certification because the answer differs between development and fleet contexts.
6. **Hidden-metadata drift:** change visible generated text without changing its hidden claim record.
   Byte-exact generation must fail.
7. **Conceptually wrong but mechanically true:** say “`GET /health` exists, therefore the system is
   healthy.” The route-existence clause may pass, but the causal conclusion must remain outside the
   certified claim. The report must not promote the whole sentence to mechanically true.
8. **Guard-can-never-fire proof:** inject each of the first six defects and assert the failure reason
   names the intended claim. A non-zero exit for an unrelated parser error proves nothing.

## Disposition

Amend *Documentation IS Being* rather than create a sibling article. The existing article owns the
truth that documentation is part of the agent's body; this proposal supplies a checkable sub-obligation
for the part of that body whose claims have programmatic answers.

Until a production-authority-backed generator/lint exists and its strict ring is clean, the article
must remain honestly unenforced for this obligation. The proposal names no guard in the registry and
does not move the Substrate article count or enforcement floor.

**Earned from:** the window-10 brief, the measured route/config/default populations above, and the
three reproduced live-document contradictions. The central lesson is the same one exposed by the
external constitutional review: evidence the verifier can obtain from the real authority outranks a
claim the document makes about itself.
