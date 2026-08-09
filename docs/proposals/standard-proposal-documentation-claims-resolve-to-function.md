# PROPOSED AMENDMENT — Documentation Claims Resolve to Function

**Status:** PROPOSAL. Agent proposes; operator ratifies. This document deliberately does **not**
modify `docs/STANDARDS-REGISTRY.md`.
**Proposed by:** Codey — in response to the window-10 brief on *Documentation IS Being*.
**Proposed placement:** amendment to the existing *Cross-Store Coherence Is an Invariant* article in
*Building*, not a new constitutional article. *Documentation IS Being* is the substrate reason and
declared lineage, not the engineering rule's filing location.
**Written:** 2026-08-08.
**Revised after external review:** 2026-08-09.
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

Scope is not an escape hatch. Every enrolled claim has a stable identity independent of its truth
scope. CI compares the current identity/scope map with the map extracted from the exact protected-base
commit. A claim that was `live/local` at that base may not become `proposal`, `historical`, `external`,
or `example` merely because the current tree changes its tag. Such a transition requires a
content-bound review record naming the claim identity, old scope, new scope, and evidence; the report
counts and names these transitions separately for each rollout ring. A new transition with no such
record fails. The guard still does **not** certify that a reviewer chose the semantically correct
scope; that remains an explicit human judgment boundary.

### The ratchet compares against a protected commit, never its own branch

“May only shrink” means set comparison against a ledger taken from a pinned protected-base commit. It
does not mean comparing the current corpus with a baseline file from the same candidate tree. The
latter permits a one-commit bypass: add an unresolved claim and add it to the baseline beside it.

The implementation should copy the repository's existing standards-area ratchet rather than invent a
second trust pattern:

- use the exact pull-request base SHA, push `before` SHA, or the documented `HEAD^` manual-dispatch
  fallback—not a mutable branch name;
- fetch full history, prove that SHA is a commit, and extract the base claim ledger from that commit
  into runner-temporary storage before invoking the candidate checker;
- make a missing or malformed required base ledger a failure, including non-canonical records and
  unknown fields; and
- make the checker validate its own workflow semantics: supported triggers, full-history checkout,
  dependency install, protected-base extraction, exact environment handoff, and the checker invocation
  must remain wired in the required order.

That pattern is already concrete in the standards-coverage CI job and its checker: the workflow
resolves and extracts the protected-base area ledger, `scripts/standards-coverage.mjs` validates both
the base ledger and its own Root wiring, and `tests/unit/standards-coverage-ratchet.test.ts` proves that
missing, malformed, lowered, removed, and redirected cases fail. This proposal reuses that authority
shape; it does not merely borrow the phrase “protected base.”

The current tree is allowed to supply its candidate ledger. It is never allowed to supply the ledger
against which its ratchet is judged. Repository code still cannot authenticate its executor or approve
its own exception; protected review and workflow rules remain the outer authority.

### Discovery and enrollment are one closed population

Enrollment cannot be an optional hand-maintained list beside discovery. That creates the same co-edit
attack as a candidate-owned baseline: one commit can remove a claim from enrollment and from the debt
ledger while leaving the documented claim intact.

For each ring, deterministic discovery produces the current candidate population. Every discovered
identity must appear in exactly one closed partition—resolved `live/local`, contradicted `live/local`,
unresolved `live/local`, or an explicit non-live scope. An unclassified candidate is a failure. The
strict reader-surface paths and generator markers are part of the self-wiring invariant, not values a
candidate can quietly narrow while the check continues to report success.

The protected-base comparison is by identity as well as count:

- current unresolved `live/local` identities must be a subset of the protected-base unresolved set;
  a new identity fails even when another debt item was removed in the same commit;
- a protected-base enrolled identity may disappear only when discovery proves the underlying claim was
  removed from the document, the claim now resolves through production authority, or the separately
  governed scope-transition rule above admits the move;
- a claim that remains discoverable but is absent from enrollment fails; editing enrollment and debt
  metadata together cannot make it disappear; and
- the report publishes both identities and totals for every partition, plus added, removed, resolved,
  contradicted, and scope-transition deltas against the protected base.

This closes co-edit bypasses inside the syntactic population the detector claims to discover. It does
not prove that arbitrary prose cannot be rewritten to evade discovery, so completeness of all
documentation claims remains outside certification.

### Debt and rollout

Do not baseline unresolved claims and then call the article enforced. Roll out in two honest rings:

1. **Strict current-reader ring:** classify the seven unmatched route claims, correct the two live
   contradictions, generate the API inventory/count, and enroll contextual default claims that have
   production resolvers. New unresolved live claims fail immediately.
2. **Shrink-only extended ring:** inventory the wider `docs/` corpus by stable claim identity and
   truth scope. A new unresolvable live identity or an unresolved set that is not a subset of the
   exact protected-base set fails; existing debt is visible and may only shrink. This ring is
   explicitly uncertified until its debt reaches zero or every remainder is truth-scoped outside
   current local runtime.

The guard report must publish the denominator by claim kind and scope: discovered, mechanically
resolved, explicitly non-live, unresolved, and contradicted. “All checked claims pass” with an empty or
shrinking discovery population is not success.

## What the guard would measure and certify

**Measured:** mechanically shaped claim candidates in the enrolled corpus; their declared truth
scope and context; the production authority invoked; expected and observed values; generated bytes;
and unresolved/contradicted debt.

**Certified:** only that every discovered and enrolled `live/local` mechanical claim still agrees with
its production authority under the declared context; that no new unresolved identity appeared relative
to the pinned protected-base ledger; that a still-discoverable claim did not leave enrollment; and that
any `live/local` scope transition is named for review rather than silently baselined.

**Not certified:** completeness of documentation; clarity; conceptual correctness; causal explanation;
semantic adequacy; the wisdom of a default; the correctness of proposed or external systems; or the
truth of an un-enrolled human-judgment sentence. It also does not certify that a non-live scope was
semantically correct, that protected review approved a sound exception, or that arbitrary prose could
not be rewritten outside the detector's declared syntactic population.

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
8. **Guard-can-never-fire proof:** inject each of the first six defects, first prove that the mutation
   actually landed, and then assert both a non-zero exit and a diagnostic naming the intended claim and
   failure reason. A zero exit, silent output, absent intended diagnostic, mutation that did not apply,
   or non-zero exit caused only by an unrelated parser error is itself a failed negative control. Each
   injection run must be isolated, the tree restored, and the clean control required to pass afterward.
9. **Candidate-owned baseline attack:** add a new unresolved claim and add the same identity to the
   candidate ledger. Comparison with the separately extracted protected-base ledger must still fail the
   new identity.
10. **Enrollment co-edit attack:** leave a discoverable claim visible while removing it from both
    enrollment and current debt metadata. Closed-population validation must fail that exact identity.
11. **Scope laundering:** change a protected-base `live/local` claim to `example` without a transition
    record. The guard must fail and report the old and new scopes; a reviewed transition must remain
    explicitly outside semantic certification.
12. **Self-wiring removal:** redirect the base to a branch/current file, narrow a strict corpus path, or
    remove the protected-base handoff. Root self-wiring validation must fail rather than run a weakened
    checker cleanly.

## Placement admission test

The review asked the proposed amendment text—not merely its intended parent—to pass the Substrate
family's three admission tests. It does not:

| Substrate admission test | Existing *Documentation IS Being* truth | Proposed mechanical obligation |
|---|---|---|
| Fact about the model/training, unchanged if the codebase changes | **Pass.** A file-based model instance loses undocumented experience across an instance boundary regardless of this repository's implementation. | **Fail.** Production probes, generated spans, ledgers, and CI ratchets are software engineering. |
| Invisible from outside | **Pass.** An instance may behave identically now whether or not an experience will survive into its successor; the erasure appears only across the boundary. | **Fail.** A stale route, key, default, or count is observable by a reader or caller. |
| A competent engineer could not derive it by reading code | **Pass.** Code can show persistence mechanisms, but not the first-person substrate truth that undocumented presence is erased presence. | **Fail.** An engineer can derive documentation/production drift and the need for a production-authority comparison by reading both surfaces. |

This distinction matters. An engineering guard may enforce or apply a Substrate truth without becoming
a Substrate article; otherwise every mechanical `Applied through` clause would disqualify its parent.
But inserting this proposal's opening obligation into the Substrate **Rule** would make that article own
software discipline it fails the family's admission rule.

## Revised disposition

Amend *Cross-Store Coherence Is an Invariant* in *Building* rather than create a sibling article. A
closed documentation fact and the production authority that answers it are two durable answer surfaces;
that article already owns the obligation to declare and mechanically check their agreement. The
amendment sharpens the documentation case: production owns the answer, generated text consumes it, and
any remaining duplicate assertion is compared by invoking production authority.

Declare *Documentation IS Being* as the substrate lineage and reason for the work, without moving the
mechanical obligation into its Rule. *Verify the State, Not Its Symbol* supplies the check-quality
boundary, *Testing Integrity* supplies the two-sided negative-control discipline, and *Remove What
Demands Attention* explains why generation beats synchronization; none becomes a second owner of the
documentation agreement invariant.

Until a production-authority-backed generator/lint exists and its strict ring is clean, the article
must name this documentation specialization as an unenforced sub-obligation. Existing guards for other
cross-store invariants must not be presented as certifying it. The proposal names no guard in the
registry, creates no article, and moves neither the Building nor Substrate article count or enforcement
floor.

**Earned from:** the window-10 brief, the measured route/config/default populations above, and the
three reproduced live-document contradictions. The central lesson is the same one exposed by the
external constitutional review: evidence the verifier can obtain from the real authority outranks a
claim the document makes about itself.
