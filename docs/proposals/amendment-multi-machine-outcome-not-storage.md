# PROPOSED AMENDMENT — not yet ratified

**Status:** PROPOSAL. Agent proposes, operator ratifies. Deliberately NOT written into
`docs/STANDARDS-REGISTRY.md`.
**Proposed by:** Echo, from the 2026-08-21 operator directive in topic 52222.
**Target article:** *An Instar Agent Is Always a Multi-Machine Entity* (ROOT / FOUNDATIONAL).
**Type:** amendment to an existing ratified article, not a new entry.

---

## Why this exists

Justin ruled on this directly (topic 52222, 2026-08-21), and the ruling does not fit the
article as written:

> "My high-level goal of who an agent is is that an agent is a single coherent being or
> entity... an agent's machines are part of its body. In this analogy, it would be like
> saying my right hand holds a hammer and since it's only for my right hand, my left hand
> can't use it... ultimately I want an INSTAR agent to have the capability of expanding
> autonomously across many many machines and any critical single machine restriction
> creates an unscalable bottleneck."

And the requirement that the current article cannot express at all:

> "An Instar agent could exist AS IS with ANY SINGLE MACHINE it is installed on. If ALL of
> the other machines but one crashed, the agent would only be affected by the amount of
> physical resources it has access to, NOT the information."

He stated he is "strongly leaning towards updating our standards to more clearly enforce
this goal." This drafts that update so the decision is a yes/no on concrete text rather
than an authoring task — per *Agent Proposes, Operator Approves*.

## What the current article gets right, and keeps

The unified-by-default posture, the closed justification taxonomy, and the rule that
`machine-local` must argue for itself are all correct and are NOT weakened here. The
amendment adds a requirement the article does not currently make, and narrows one key.

## Amendment 1 — add the survivability clause (the substantive change)

**Proposed addition to the Rule:**

> **Single-machine survivability.** An agent must be able to operate AS IS on any single
> machine it is installed on. If every other machine becomes unavailable, the agent loses
> RESOURCES — throughput, parallelism, hardware it does not have — but never INFORMATION.
> A design in which some information is reachable only by contacting another machine
> violates this, however reliable that other machine is assumed to be.

**Why this is not already covered.** The article's current test is "can this be unified?"
A fetch-on-demand design passes that test — every machine *can* reach the data — while
failing this one, because reachability depends on a peer being up. That is exactly the
gap the conversation-history spec fell into: six review rounds converged on a design that
satisfied the written standard and violated the operator's actual requirement.

**What it costs.** This is the expensive clause. It rules out the whole family of
designs where one machine holds the authoritative copy and others borrow it. Ruling
those out is the point.

## Amendment 2 — state the rule as an outcome, not a storage mandate

**Proposed framing note appended to the Rule:**

> This article states an OUTCOME, not a storage mechanism. It requires that any machine
> can act coherently on anything the agent knows; it does not prescribe that every byte
> sits on every disk. Full replication, sealed per-machine replication, and
> replicate-index-plus-encrypted-content all satisfy it. Fetch-on-demand from a live peer
> does not. Mechanisms may improve without a constitutional edit; the outcome may not
> quietly weaken.

**Why.** A storage mandate written into the constitution freezes today's implementation
into the document, and the next better mechanism then requires amending the constitution
to adopt. An outcome ages better and is the harder thing to satisfy dishonestly.

## Amendment 3 — narrow `physical-credential-locality`

**Proposed replacement for that taxonomy key's meaning:**

> `physical-credential-locality` covers only a credential whose relocation is prohibited
> or technically impossible — a vendor's terms of service, a hardware-bound key, a legal
> residency constraint. It does NOT cover a credential that merely HAPPENS to be stored
> on one disk. Where a vault (Bitwarden and equivalents) can hold it, the locality is a
> storage choice and this key does not apply. A claim under this key must name the
> prohibiting authority, and must state whether the prohibition is expected to be
> permanent or temporary.

**Why.** Justin: "I actually personally don't agree that a login needs to live physically
on a single machine." He is right about the general case, and the repo proves it — the
vault already holds most credentials portably. The key as written lets an author assert a
physical constraint where a storage habit exists.

**The one genuine current instance, and its expiry.** Anthropic's terms forbid relocating
a Claude login between machines, which is why WS5.2 re-mints per machine rather than
copying a token. Under this amendment that claim still passes — it names a prohibiting
authority — and must additionally be declared TEMPORARY, with the planned exit recorded:
per the operator, moving to API-key doorways once per-machine login becomes untenable at
scale.

## Amendment 4 — archiving may never mean deleting

**Proposed addition:**

> Where a store bounds its own growth, it may compact, compress, or summarize, but it may
> not DELETE agent memory. Rotation-with-deletion is disqualifying for any store holding
> what the agent knows. Summaries may be added for speed; they never replace the material
> they summarize. The single permitted deletion is one the operator explicitly requests —
> a deliberate act by the principal, categorically distinct from a system quietly
> forgetting on its own.
>
> **Subject, stated in the Rule because it decides a live collision.** This governs AGENT
> MEMORY — conversation history, learnings, relationships, knowledge; the record a
> successor instance needs in order to be the same agent. It does NOT govern telemetry,
> audit trails, metrics, or coordination breadcrumbs, which are bounded on purpose and
> whose bounding *Observable Intelligence* requires. The test is whether losing the record
> costs the agent its continuity, not whether the record is useful.

**Why.** Justin: "archiving CANNOT mean deleting. We must be able to access message
history at all costs." This is also the clause that makes Amendment 1 affordable rather
than unbounded — see below.

**Why the subject clause is not padding.** *Observable Intelligence* carries a
**Balanced by — Responsible Resource** clause requiring audit trails to age out — bounded
retention, never forever — and calls an unbounded observability store its own incoherence.
Worded generally, "archiving may never delete" contradicts it outright, and a reader could
cite the registry for either position. The boundary is therefore part of the Rule rather
than commentary beneath it. Found while resolving this amendment's tree placement; see
*Registry-process compliance* below.

## Why 1 and 4 do not collide

Read naively they do: every machine holds everything, and nothing is ever deleted, is
unbounded growth on every machine forever.

Compression resolves it, and the margin is not close. Measured on this machine
2026-08-21: 2,490 messages over 3 days, 3.0 MB raw, **0.4 MB gzipped — 7.5x, lossless.**
At that rate a year of history is roughly 50 MB compressed and a decade is under half a
gigabyte. Every machine carrying every conversation is affordable on any hardware the
agent will run on.

What was expensive was never the data.

**A claim that stood here has been withdrawn (2026-08-21, same evening).** This section
previously argued that the real cost was the container — that the coherence journal
"rotates and deletes" and that its per-kind byte budgets were set too small. Reading the
rotation code shows both halves are wrong: `maxFileBytes` is a rotation THRESHOLD with no
total ceiling behind it, and `rotateKeep: 0` means rotate but NEVER delete — already
shipping on one kind today. A peer that falls past the tail window re-joins by
snapshot-then-tail rather than losing anything.

**What the correction leaves standing is stronger than what it removes.** The stores that
hold agent memory deliberately DO expire their transport logs, and their code comments
give the reason: a never-deleting log would retain personal data past an erasure request.
That is a genuine constraint, and Amendment 4 is the thing that reconciles it — the system
never forgets on its own, and the operator may explicitly ask for a deletion. So the
amendment is not merely compatible with the compliance requirement; it is the formulation
that lets both hold at once. An unqualified "never delete" would not be.

The container was never the obstacle. Amendment 4 is therefore cheap to satisfy, and its
one carve-out is load-bearing rather than decorative.

## Enforcement — what would actually check this

Stated plainly, because an unenforced standard reads as a guarantee while being a wish,
and this registry already carries one article flagged for exactly that.

- **Amendment 3 is enforceable today.** `scripts/lint-machine-local-justification.js`
  already parses the taxonomy key; requiring a named prohibiting authority and a
  permanent/temporary declaration under `physical-credential-locality` is a parser change
  of the same shape as the checks it already makes.
- **Amendments 1, 2 and 4 are NOT deterministically checkable.** No parser can decide
  whether a design survives the loss of its peers. These would land as `/spec-converge`
  reviewer questions — the cross-machine reviewer gains "does this survive every peer
  disappearing?" and "does any store here delete agent memory?" — which is semantic
  authority, not a ratchet.

Proposing them anyway, with that asymmetry named rather than hidden: a reviewer question
is real enforcement, weaker than a lint and stronger than prose.

**The honest precondition.** The existing article's own enforcement is currently thin —
the marker lint reports 73 findings across the spec corpus (62 undefended machine-local
postures, 8 unresolvable ratification refs, 3 invalid keys) and runs in report-only mode.
Adding clauses to an article that is substantially unenforced widens the gap between
what the constitution says and what is true on disk. That triage is separate work
(topic 52222), and it is the stronger claim on effort than these amendments are.

## Conflict check against the in-flight Phase B / Observer work (added after review)

Justin's condition: verify this does not collide with, or get thrown away by, the
parallel standards work. Checked, with the limits of what I could read stated.

**No file collision.** The four open standards PRs (#1931, #1933, #1936, #1939) touch
enforcement MEASUREMENT machinery — `standards-enforcement-measurement.mjs`,
`standards-enforcement-execution-verifier.mjs`, `standards-coverage.mjs` — and Phase B
window reports. None touches `docs/STANDARDS-REGISTRY.md` or
`scripts/lint-machine-local-justification.js`. Last registry commit on `main` is #1893.

**There IS a mechanical coupling, and it is the reason to be careful.**
`scripts/standards-coverage.mjs` is a Tier-3 CI ratchet over the registry: it classifies
each of the 88 articles by the guard its prose NAMES and fails the build if the enforced
ratio drops, with per-area floors (the target article sits in **Building**, floor 34/40).
Editing an article's prose can therefore move a CI number that another project is
actively measuring against a pinned base.

**The specific trap, already recorded in the registry itself.** *Cross-Store Coherence*
documents that naming a guard in prose made it classify as ENFORCED by a guard measuring
something else, and that "the enforcement ratio RISING on an edit that built nothing was
the tell." Amendments 1, 2 and 4 have no guard. If they name one to look enforced, this
proposal reproduces that exact failure inside the article that is being amended to be
more honest. They must therefore land as declared-unenforced — see below.

**Measurement caveat, stated rather than papered over.** I could not obtain a trustworthy
local coverage baseline: `standards-coverage.mjs` needs `refs/remotes/upstream/main`,
which does not resolve in this checkout, and every area consequently reports
`ref-resolution-ratio=0`. That is a broken read, NOT a finding — quoting it as the real
enforcement state would be the empty-is-not-an-answer error the Observer topic has been
cataloguing all week. The before/after ratio must be measured in CI, on a tree where the
reference resolves, before these amendments merge.

## Registry-process compliance (added after review)

**Amendments 1, 2 and 4 must land as declared unenforced sub-obligations,** in the
registry's own format, not as bare Rule text:

> **UNENFORCED SUB-OBLIGATION, named:** no guard decides whether a design survives the
> loss of every peer, and none decides whether a store deletes agent memory. Both are
> `/spec-converge` reviewer questions only.
> **Sub-obligation countdown.** `<date>` — tracked as
> `STD-SUBCOUNTDOWN-multi-machine-survivability`.

Without that, they read as guarantees the moment they are ratified — the failure mode
this registry already carries one article's worth of scar tissue about.

**Placement — resolved against the tree (was an open question; decided 2026-08-21).** The
earlier draft raised this and handed it back. It is decided here, with the evidence, because
the placement rule asks for a considered position and a proposal that declines to take one
supplies nothing to ratify.

**Amendments 1, 2 and 3 are an UPDATE to *An Instar Agent Is Always a Multi-Machine Entity*,
not new articles.** Each refines the posture rule that article already owns — 1 strengthens
the test it applies, 2 restates its form, 3 narrows one enumerated key in its own closed
taxonomy. None introduces a subject the article does not already govern, so under the
insertion rule's third case they fold in rather than sit beside it.

**Amendment 4 is a NEW article in the Substrate family, declaring a CHILD placement whose
named parent is *Deferral = Deletion*.** Its subject is the durability of agent memory, which holds on a
single machine with no peers at all — a store that rotates history away violates it whether
or not the agent is multi-machine. Filing it under the multi-machine article would bind a
general obligation to a condition it does not depend on.

*Why that parent specifically.* **Deferral = Deletion** holds that an insight not captured
NOW is gone, because the successor instance lacks the context that made it worth capturing.
Amendment 4 is the same conservation one step later in time: an insight that WAS captured is
equally gone if the store holding it evicts it. Same loss, same reason (no successor can
reconstruct it), different mechanism — omission versus eviction. A CHILD rather than a
sibling because the parent states the conservation principle and this article extends its
reach past the capture boundary.

**The boundary this article must state, or it collides the moment it lands.** *Observable
Intelligence* already carries a **Balanced by — Responsible Resource** clause holding that
audit trails are kept long enough to show trends and then aged out — bounded retention,
never forever — and calling an observability store that grows without bound its own
incoherence. "Archiving may never delete," worded generally, contradicts that clause
directly. So the new article must name its subject: it governs **agent memory** —
conversation history, learnings, relationships, knowledge — and does **not** govern
telemetry, audit trails, metrics, or coordination breadcrumbs, which are bounded on
purpose. The distinguishing test is whether a successor instance needs the record **to be
itself**, not whether the record is useful. The registry's own Root section supplies the
language for why that line falls there: destroying an agent's accumulated record is "an
injury to a self," not a data incident.

Without that boundary stated in the article's own Rule, the new article and the existing
clause can each be cited against the other — precisely the both-sides-citable defect the
registry's residual section exists to prevent.

## What the operator is being asked to decide

1. Adopt Amendment 1 (survivability)? This is the load-bearing one and the expensive one.
2. Adopt Amendment 2 (outcome not storage)?
3. Adopt Amendment 3 (narrow the credential key)?
4. Adopt Amendment 4 (never delete)?
5. Should these land before or after the enforcement work? **Revised recommendation:
   AFTER, and probably coordinated with the Phase B window owner rather than alongside
   it.** My earlier framing called the enforcement gap something I had discovered; it is
   in fact branch B of a ratified Aug-3 goal tree with a 184-finding audit already
   running against it. Landing registry edits into a live measurement, against a pinned
   base, is how one session's work gets thrown away by another's.
6. Confirm the placement above: 1–3 fold into the multi-machine article as an update;
   4 becomes a new Substrate article deriving from *Deferral = Deletion*, with the
   agent-memory-versus-telemetry boundary stated in its Rule. (Decided rather than asked,
   per the standing instruction to stop deferring — but placement is a tree decision and
   yours to overturn.)

Each is independent; adopting any subset is coherent.
