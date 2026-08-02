---
title: "Decision Quality — Executable Denominator and Work-Conserving Grading"
slug: "decision-quality-enforcement-teeth"
author: "instar-codey"
status: "draft"
source-audit: "docs/audits/full-decision-visibility-enactment.md"
parent-spec: "docs/specs/full-decision-visibility-enactment.md"
parent-standard: "Decision Provenance & Outcome Review"
eli16-overview: "decision-quality-enforcement-teeth.eli16.md"
lessons-engaged:
  - "P1 Structure beats Willpower — the compiler proves the production callsite set instead of trusting a hand-maintained count."
  - "P4 Test Everything E2E — static set equality and runtime settlement reconciliation are separate acceptance bars."
  - "P5 Observable Intelligence — every decision-origin callsite has one stable identity and every grading pass reports where its capacity went."
  - "P6 Zero-Failure — unresolved calls, manifest drift, budget overflow, and stranded grading capacity fail loudly."
  - "P10 Comprehensive-First — denominator identity, compatibility, runtime reconciliation, grading fairness, fleet posture, and rollback are designed together."
  - "L6 Side-effects review — compiler cost, schema migration, privacy, scheduling fairness, multi-machine ownership, and rollback are explicit."
---

# Decision Quality — Executable Denominator and Work-Conserving Grading

## Status and authority

This is the focused enforcement delta for two parts of
`full-decision-visibility-enactment.md`: its executable denominator and its
grading-capacity allocation. Where the parent draft is general, this document is
the implementation contract for those two areas. It supersedes only those areas;
the parent's rich-capture, outcome-join, review, benchmark, and release-completion
contracts remain unchanged and remain draft.

This specification does not claim that the nine repair-first rows or ten
blocked/dark/stale rows are fixed. It makes their disposition mechanically
provable. Those source repairs are separate implementation changes against the
new denominator.

## Grounded current state

The converged audit found a 64-row, component-oriented provenance catalog. The
v1.3.1117 dev-agent runtime restarted onto the merged enrollment at 16:35Z on
2026-08-02 and reported 39 wired, 19 pending, and 6 exempt rows: the total remained
64, proving these were conversions rather than denominator-padding additions.
Those live numbers truthfully describe the catalog but do not prove the number of
production model-invocation sites:

- at least nine component rows conceal multiple judgments or mismatched runtime
  identities;
- some pending or exempt rows are aliases, delegates, dark owners, or stale names
  rather than live invocations;
- the attribution lint is a receiver-name regular expression with documented
  helper and conditional-option blind spots;
- the provenance ratchet validates declared component rows but does not derive the
  production invocation set from the TypeScript program;
- an earlier package counted 76 `evaluate` expressions, then proved its count was
  incomplete and non-reproducible. That number is not a baseline.

Accordingly, `39 / 64` is a conversion share inside the declared catalog, not a
floor or ceiling on executable-origin coverage. Removing non-invocation aliases
could raise the executable ratio; splitting hidden multi-call rows or discovering
undeclared origins could lower it; both numerator and denominator may move. Until
the compiler inventory lands, the only defensible claim is: "39 of 64 declared
catalog rows are wired, up from 11; coverage of actual production decision origins
is unknown."

The deterministic grading pass has five points and a configured global ceiling of
200 rows per hourly pass. It currently gives each point a fixed 40-row slice. An
empty or backed-off point strands its slice while a hot point cannot reuse it. Its
`max(1, floor(B / N))` helper can also inspect more than the declared global budget
when `B < N`. The result reports grades and cursors, not inspected rows or unused
capacity, so neither defect is visible from the normal read surface.

## Outcomes

When this delta is implemented:

1. The TypeScript compiler derives every production model-call expression from the
   same program the build type-checks.
2. Every derived expression is classified as exactly one decision origin or one
   compiler-proved infrastructure forwarder. A registry label is not proof;
   unknown or ambiguous classification exits CI nonzero.
3. The decision-origin set and invocation census are a bijection. Either direction
   of disagreement is a build failure, not a backlog-item success path.
4. Every new or changed decision origin uses one imported, stable `DP_*` identity
   that no other origin uses. Only the audited current sites may enter a closed,
   shrink-only `repair-required` posture; multi-call compositions leave that debt
   with distinct identities joined by an explicit composition ID.
5. Non-invocation aliases and delegates are reported separately and never inflate
   the denominator or its coverage percentage.
6. Runtime settlements identify the generated manifest revision, allowing static
   callsites and observed invocations to reconcile without retaining prompts or
   message content.
7. A grading pass never inspects more than its configured global row budget, gives
   every point a bounded fair opportunity across passes, and reuses capacity
   relinquished by empty, blocked, or backed-off points.
8. Raising the default grading budget from 200 to 500 controls the measured backlog
   without being misrepresented as outcome evidence or better ground truth.

## Scope and non-goals

This delta covers production calls resolved through the TypeScript type checker to
`IntelligenceProvider.evaluate`, `IntelligenceRouter.evaluate`, or a registered
decision adapter with the same typed contract. It covers the source manifest,
invocation-census schema, CI ratchets, runtime settlement identity, grading
allocator, scheduler state, and operator readouts.

Publishing and implementing this enforcement delta does not itself:

- repair or enroll the remaining 9 repair-first and 10 blocked/dark/stale rows;
- build rich content capture, screenshots, outcome joins, real-case review, or
  benchmark promotion;
- claim that a syntactically complete callsite set proves semantic completeness;
- make a grading rule, prompt, model, or routing decision automatically;
- add external egress, provider calls, or cross-machine write authority;
- turn absent outcome evidence into `right` or `wrong`.

## 1. Compiler-derived call inventory

### 1.1 Build the same program CI builds

Add `scripts/decision-call-inventory.mjs`. It loads the repository's production
TypeScript configuration, creates a `Program` and `TypeChecker`, and walks included
`src/**/*.ts` and `src/**/*.tsx` source files. It does not scan generated output,
tests, fixtures, parity scenarios, smoke tests, stress tests, vendored code, or
declaration files. Exclusions are closed path-root rules asserted in fixtures; a
new excluded root is a reviewed change to the inventory algorithm.

For each `CallExpression` whose property is `evaluate`, the inventory resolves the
receiver and selected call signature. A call is in scope when the receiver or
signature resolves to:

- the canonical `IntelligenceProvider` interface;
- `IntelligenceRouter` or a subtype;
- a concrete class implementing the canonical interface; or
- a source-registered decision adapter whose signature preserves the canonical
  options and result contract.

Receiver spelling is irrelevant. Aliases such as `brain`, constructor parameters,
properties, and imported interfaces must resolve by type. Conversely, an unrelated
object named `provider` does not enter the inventory merely because of its name.
Any production `.evaluate` call whose receiver and signature cannot be resolved is
emitted as `unknown` and fails the check. Type errors cannot make a call disappear.

### 1.2 Classify every call without double-counting

The complete compiler inventory contains two disjoint roles:

- `decision-origin`: the first in-scope call edge that submits a domain judgment
  into the provider graph and binds that judgment to one imported `DP_*` identity
  (or to one exact pinned bootstrap-repair key); and
- `infrastructure-forwarder`: a downstream call edge in the same logical
  evaluation that delegates an attempt through router, breaker, queue, retry/swap,
  or concrete-provider plumbing without choosing a new domain prompt, decision
  identity, or verdict consumer.

Only decision origins form the coverage denominator. Forwarders remain in the
generated manifest and are checked, but do not create a second census row or a
second expected settlement for the same judgment.

Classification is a proof over the call chain, not a manual label. An origin must
be outside registered provider plumbing, must bind its identity at that callsite,
and must have no proved upstream in-scope evaluation whose judgment it is merely
continuing. A forwarder must satisfy all of these obligations:

1. its enclosing symbol is a typed provider implementation or a registered helper
   reachable from that provider graph;
2. its prompt and operational options derive from the enclosing provider entry or
   the router-held decision context through a closed, deterministic transform;
3. it imports, selects, defaults, or overwrites no `DP_*` identity and creates no
   second provenance settlement;
4. it delegates only the same logical evaluation. Retry and provider-swap attempts
   are forwarders only while one router-held decision context owns the eventual
   settlement; fan-out that combines independent model judgments is not forwarding;
   and
5. any stripping of the provenance carrier occurs only at a registered terminal
   provider boundary after the router has retained the sole decision context.

Forwarder candidates come from a closed registry keyed by stable
`source-module#enclosing-symbol`, with a reason, owning interface, allowed argument
transform, and settlement owner. Line numbers are forbidden. The registry only
names candidates; the compiler/data-flow checker must discharge every obligation
above. A stale declaration, unproved transform, new prompt source, identity mint or
overwrite, independent result aggregation, or path with no retained settlement
owner is `unknown` and fails CI. It never becomes a forwarder because a person put
it in the registry.

Across every proved call chain, exactly one static callsite is the decision origin
and every downstream in-scope callsite is a forwarder. A `wired` chain also has
exactly one router settlement owner. A direct-provider transition may lack that
owner only while it remains explicitly `pending`; it cannot be called wired.

A generic helper may not hide multiple semantic judgments behind one forwarder.
Callers must either invoke the router directly or call a registered typed decision
adapter whose callsites the compiler inventories. Each distinct semantic callsite
still carries its own `DP_*` identity. Helper indirection is never an exemption from
the denominator.

### 1.3 Stable, content-free identity

Each decision-origin manifest row contains only source-controlled identity and
shape:

- `callsiteKey`: normalized source module, enclosing symbol, and zero-based
  `evaluate` ordinal within that symbol;
- for an exact row, imported `DP_*` symbol and its decision-point string value; for
  a bootstrap repair row, its explicit unresolved or legacy identity posture;
- exact attribution component identity;
- prompt identity constant;
- optional composition identity;
- route posture: `router`, `typed-adapter`, or `direct-provider-transition`;
- inventory schema revision and compiler-method revision.

Line numbers, prompts, message bodies, source fragments, model responses, terminal
output, and secrets are forbidden from the manifest. Renaming or moving a symbol is
an explicit manifest change. Inserting a new call before an existing call may alter
an ordinal; the exact diff makes that identity movement visible during review.

The provenance options at a decision origin must resolve to an imported `DP_*`
constant from the canonical registry. Inline strings, parameters that can carry
several decision points, and runtime-computed decision IDs fail. A composition with
two model calls therefore has two decision points and two origin rows, not one
aggregate row used twice.

There is one migration-only exception. The first whole-tree generation may mark
exact callsite keys corresponding to the audit's existing repair-first class as
`repair-required:<tracker>`. Those rows preserve the observed legacy identity (or
explicitly record that none resolves), cannot be `wired`, and are pinned as a
closed, shrink-only baseline. The checker refuses additions or key substitution.
This exception makes the callsite denominator exact before the semantic identity
repairs are designed; it does not let a new or changed callsite borrow old debt.

### 1.4 Generated manifest and reproducibility

The inventory emits a deterministic, content-free generated manifest under
`src/data/decisionCallInventory.generated.ts`. Stable sort order is by
`callsiteKey`; timestamps and host paths are forbidden. The generated header records
schema revision, TypeScript version, inventory-method revision, and a digest over
the normalized rows. The method revision digests the inventory script, canonical
provider interfaces, decision-adapter registry, forwarder registry, and exclusion
rules.

CI regenerates into a temporary path and exact-diffs the checked-in manifest. It
then runs the set-equality ratchet described below. A compiler-version change,
provider-interface change, exclusion change, or inventory-method change requires a
same-PR manifest regeneration and a same-PR re-run of the decision-visibility audit.
The audit requirement prevents a self-consistent compiler blind spot from passing
merely because the same changed algorithm generated and checked the same file.
The audit frontmatter records `inventory-method-digest`; CI requires it to equal the
generated method digest, and a changed digest requires refreshed round evidence
under the existing convergence gate rather than a timestamp-only edit.

Required positive and negative fixtures include:

- router, injected-interface, concrete-provider, aliased-receiver, and typed-adapter
  decision origins;
- router, breaker, queue, and provider-leaf forwarders;
- two calls in one symbol, two calls in one composition, and a generic-helper
  multiplexing attempt;
- missing, inline, dynamic, duplicate, and wrong-module decision identities;
- unresolved receiver and deliberately broken type information;
- unrelated `evaluate` methods and closed test/fixture exclusions;
- stale forwarder declarations and forwarders that overwrite caller identity.

## 2. The census is the denominator

### 2.1 Separate invocations from the human catalog

Introduce `DECISION_INVOCATION_CENSUS`, with exactly one row per generated
decision-origin callsite. Each row is keyed by `callsiteKey` and contains exactly one
identity posture, component, prompt identity, composition identity, route posture,
coverage posture, and existing content/volume/outcome/fleet declarations. An
`exact` identity posture names exactly one decision point. A bootstrap
`repair-required` posture names its resolvable legacy identity, if any, plus its
tracker and audit classification, but can never be wired.

Move aliases, delegates, deterministic-only entries, dark capabilities with no live
callsite, and other non-invocation concepts to
`PROVENANCE_NON_INVOCATION_CATALOG`. This catalog remains useful for human
accountability but is never part of `invocationTotal`, `wiredInvocationShare`, or a
claim about all production judgments.

For at least one release, the existing `PROVENANCE_COVERAGE` export and API fields
remain as an explicitly labeled compatibility projection. Read surfaces report
`invocationTotal`, `invocationByStatus`, and `catalogTotal` side by side. They never
silently repurpose the legacy total. Removal requires usage evidence, a compatibility
review, and a separately reviewed change; one quiet internal release is not proof
that external package consumers are gone.

The current 64 and 39/19/6 catalog figures are evidence used to start migration,
not pinned target counts. The first compiler-backed implementation records the
actual generated count. Any split or stale-row disposition updates the audit table
and compatibility readout in the same PR; it does not preserve 64 or resurrect 76
to make a historical statement look stable.

### 2.2 Bidirectional set equality

Let `I` be generated `decision-origin` rows and `C` be
`DECISION_INVOCATION_CENSUS`. CI proves all of the following:

1. `keys(I) = keys(C)`, including explicit failures for both `I - C` and `C - I`;
2. every `callsiteKey` is unique in each set;
3. every `exact` decision-point identity appears exactly once in `I` and exactly
   once in `C`; `repair-required` keys equal the closed bootstrap baseline, cannot
   be wired, and may only disappear by becoming exact;
4. component, prompt, composition, and route posture agree field-for-field;
5. every `wired` origin routes through the shared router or a proven typed adapter
   backed by that router and names a typed context builder;
6. a direct concrete provider can be only `pending` with a resolvable transition
   owner and close condition;
7. an injected `IntelligenceProvider` is `wired` only when source-controlled
   construction or adapter wiring proves the runtime object reaches the shared
   router. A local assertion is not proof;
8. no non-invocation catalog row has an invocation key or absorbs runtime activity;
9. every forwarder remains identity-preserving and outside the denominator; and
10. the checked-in manifest digest equals the digest generated in CI.

Any inequality is an authoritative build failure. The checker exits nonzero and
prints stable sorted `I - C` and `C - I` rows with their callsite keys and source
owners. It does not convert a discovered-but-undeclared origin into an item and
continue green. An implementation may additionally open or refresh a durable item
as a secondary operational signal, but that item is not a disposition, cannot
satisfy the ratchet, and cannot permit merge. The first bootstrap PR must reconcile
the generated manifest and census in the same change; unresolved semantic identity
uses only the closed `repair-required` posture, never set inequality.

The prior component-category and attribution guards remain defense in depth. They
may find component-taxonomy or token-accounting defects, but neither is allowed to
claim denominator completeness after this ratchet lands.

### 2.3 Runtime reconciliation

Every settlement row records the decision point, callsite key, manifest digest, and
inventory schema revision before the model result exits the router. Success, model
failure, empty result, fallback, breaker refusal, and timeout all settle against the
same origin identity. Forwarder calls do not mint another origin.

The decision-quality read surface exposes, over a bounded window:

- built manifest revision and runtime manifest revision;
- invocation total and wired/pending/direct-transition partitions;
- settlements by callsite key and exit class;
- unknown decision point, unknown callsite, and schema/digest mismatch counts;
- wired-but-silent origins;
- observed activity attributed to pending, direct-transition, or non-invocation
  identities; and
- per-owner-machine totals without copying full decision content.

Static exactness proves the source set; runtime reconciliation proves the built code
is actually settling against it. A zero-traffic origin remains `not-observed`, not
`working`. A pending origin remains in the denominator. Runtime activity by a
non-invocation catalog entry is a contradiction and health failure.

## 3. Work-conserving grading with a strict global cap

### 3.1 Budget means inspected rows

Raise the default `maxDecisionsPerPass` from 200 to 500, retaining the existing hard
configuration clamp. The global budget `B` counts rows returned to the grader for
inspection, including already-terminal rows, rows that produce unknown, and rows
whose annotation is rejected. `graded` remains a result count and cannot be used as
the capacity measure.

The ledger exposes the keyset walk as a bounded lazy iterator. A row consumes budget
when it is materialized; stopping at a pending low-water row finalizes the iterator
without preloading later rows. This is required for reclaimed capacity to represent
real work rather than rows already fetched and discarded.

`gradeOnePoint(limit)` returns a bounded result rather than mutating only shared
totals:

```text
{ inspected, graded, advanced, pageFull, blocked, blockReason, cursor }
```

`inspected <= limit` is asserted. Backoff, missing required evidence stores, and a
pending low-water row report `blocked` and relinquish uninspected allocation. An
annotation rejection counts the inspected row, does not advance the cursor, and
blocks that point for the rest of the pass. An empty page returns zero inspected and
is not refill-eligible.

### 3.2 Fair first round

Let `N` be the current registered grade-pass points. Add a durable singleton
scheduler row in the decision-quality SQLite store containing schema revision,
monotonic scheduler epoch, `nextPointIndex`, and a bounded local pass lease.

At the start of a pass, points are ordered circularly from `nextPointIndex`:

- when `B >= N`, every point receives `floor(B / N)` rows and the first
  `B mod N` points receive one additional row;
- when `B < N`, only the first `B` points receive one row, and the durable start
  rotates so the omitted points lead later passes;
- before inspection, one SQLite transaction acquires the pass lease, increments the
  epoch, and persists the next start. When `B < N`, it advances by `B`; otherwise
  it advances by `max(1, B mod N)`. The latter rotates an exactly divisible
  allocation by one and rotates remainder seats by the number of extras. A live
  overlapping job or operator trigger returns `busy` without inspecting rows. The
  worker renews the lease between refill chunks and releases it on normal exit. A
  crash may cause bounded replay after lease expiry, but cannot pin every restart
  to the same first point.

This replaces the current `max(1, floor(B / N))` behavior. The sum of grants is
always exactly `B`, never `N` when the declared budget is smaller.

### 3.3 Reclaim and refill

After the fair first round, unused grants return to one shared pool. A point is
refill-eligible only when its last page was full, its low-water cursor advanced, and
it is not blocked. Refill walks eligible points in the same durable circular order,
using bounded chunks until the pool is exhausted or no point remains eligible.

This deterministic rotating refill supersedes the parent's imprecise
"oldest/largest backlog" phrase. It is work-conserving without adding full backlog
counts, a second scheduling heuristic, or a high-volume query to every pass. Oldest
rows still lead within each point because existing keyset cursors preserve source
order; rotation prevents one hot point from owning every reclaimed row forever.

The pass stops with `totalInspected <= B` under every branch. It may finish below
`B` only when all remaining points are empty, backed off, low-water blocked,
unwired, or annotation-blocked. Cursor and outcome writes remain idempotent. A crash
before completion can replay rows but cannot skip them or exceed the cap within any
single completed attempt.

### 3.4 Read surface

The pass result and existing decision-quality read surface add:

- configured budget, effective budget, initial allocation, reallocated capacity,
  total inspected, total graded, reclaimed capacity, and final unused capacity;
- starting and next point indices;
- per-point initial allocation, refill allocation, inspected, graded, cursor
  advancement, page-full state, and block reason;
- a health contradiction if inspected exceeds effective budget; and
- backlog age/count as separately measured signals, never inferred from unused
  capacity.

The readout states explicitly that 500 is throughput, not correctness. Unknown
outcomes and missing evidence remain unknown regardless of how quickly rows are
visited.

## 4. Side-effects review

### Over-reach and under-reach

Type resolution intentionally reaches aliases and injected providers that the
current name regex misses. It intentionally excludes resolved unrelated `evaluate`
methods and non-production roots. Unresolved production calls fail rather than
silently choosing either side. The remaining under-reach risk is a generic helper
that erases the provider type; registered typed adapters and the ban on semantic
multiplexing make that risk visible.

### Level of abstraction and authority

The compiler owns syntax and type facts; the source census owns reviewed semantic
identity; runtime settlement owns observed execution. No one layer claims the other
two. The inventory and ratchets are read-only build enforcement. The grading change
only allocates existing deterministic annotation work and adds no authority to
judge, enact, route, or promote production behavior.

### Privacy and egress

The manifest is content-free and checked into git. It contains names already in
source, not prompts, inputs, responses, source snippets, hashes of user content, or
machine paths. The compiler check and grading allocator make no model call and no
external request. Existing local provenance and retention boundaries are unchanged.

### Adjacent systems

The attribution lint, component-category ratchet, bench-coverage ratchet, router
settlement, SQLite grading cursors, P19 backoff, and outcome-annotation chokepoint
remain in place. Compatibility fields prevent dashboard and API consumers from
silently interpreting an invocation total as the old catalog total. The generated
manifest ships with the package so runtime reconciliation does not need the source
tree.

### Multi-machine behavior

Manifest bytes are build artifacts and must be identical for the same release.
Grading remains machine-local to the decision-quality ledger owner; this delta does
not add a fleet scheduler or remote write. Aggregates label owner machine and
manifest revision so different deployed revisions cannot be merged as one
denominator. Cross-machine outcome routing remains governed by the parent spec.

### Performance

Compiler inventory runs in CI and developer gates, not per decision. It reuses one
TypeScript program and is bounded by the production source tree. Runtime settlement
adds fixed identity fields only. Grading work is `O(B + N)` plus bounded keyset
queries; no full-table or full-backlog count is added to allocation.

### Rollback

The schema migration is additive and idempotent. Rolling back runtime use leaves the
generated manifest and new scheduler table inert. The compatibility projection
keeps old readers working for one release. Grading cursors remain authoritative;
scheduler rollback may restore fixed slices but cannot lose, fabricate, or duplicate
outcome rows. Generated-manifest or ratchet rollback must not be described as
complete decision coverage.

## 5. Implementation order

### Increment A — compiler inventory and exact census

Land the TypeScript inventory, fixture corpus, generated manifest, invocation and
non-invocation schemas, compatibility projection, bidirectional ratchet, closed
repair-required bootstrap baseline, runtime identity fields, and readout.
Regenerate the source truth and update the audit's counts in the same PR. This
increment changes measurement and enforcement, not model behavior or the semantic
identity of the nine repair-first rows.

### Increment B — work-conserving grading

Land the additive scheduler state, structured per-point result, strict-cap
allocator, default 500-row budget, readout, and load tests. Preserve cursor,
backoff, idempotency, and annotation rejection semantics.

The two enforcement increments may merge independently, but Increment A must land
before any remaining-row PR claims denominator closure. After A, follow-on source
PRs split the nine aggregate/mismatched rows and route, activate, remove, or honestly
catalog the ten blocked/dark/stale rows. Every such PR updates manifest and census
together. `repair-required` may be removed from the schema only after it reaches
zero. Increment B does not wait for those dispositions because it improves bounded
throughput for today's five grading points.

## 6. Acceptance gates

### Inventory and ratchet

- Golden fixtures detect every typed origin and forwarder and reject every unknown,
  dynamic, duplicate, hidden-helper, stale-forwarder, and wrong-module case.
- Call-chain fixtures prove that registry membership alone cannot create a
  forwarder; identity mint/overwrite, a new prompt source, independent result
  aggregation, an unregistered argument transform, or a second settlement owner
  all fail. Registered single-decision retry/swap paths remain one origin.
- Whole-tree generation is deterministic across two clean checkouts and exact-diffs
  the checked-in manifest.
- Changing an inventory input changes the method digest and fails until the audit's
  digest and convergence evidence are refreshed in the same PR.
- Removing a census row while retaining its source call fails the build with
  `I - C`; adding a row without a source call fails with `C - I`. Creating or
  linking an item never turns either failure green.
- Reusing one decision point at two origins and aggregating a multi-call composition
  both fail outside the closed bootstrap repair set; adding or substituting a
  `repair-required` key also fails.
- Every current production model call is either a decision origin or a proved
  identity-preserving forwarder; there is no unknown bucket at merge.
- Non-invocation catalog rows are absent from invocation totals and coverage ratios.
- Built-package E2E reads the manifest without a source checkout.
- Runtime E2E settles success, provider error, empty, fallback, and timeout against
  one origin without double-counting its forwarders.
- Two release revisions report separate manifest identities rather than merging
  incompatible totals.

### Grading allocator

- With `B=500`, one hot point and four empty points can inspect all 500 rows.
- With two hot points, each receives its fair first allocation and reclaimed work
  rotates; total inspected remains at most 500.
- With `B < N`, no pass exceeds `B` and repeated passes give every point a first
  opportunity.
- A backed-off, missing-store, low-water pending, empty, or annotation-blocked point
  relinquishes unused capacity and reports its exact reason.
- Already-graded rows count as inspected; `graded` cannot hide budget use.
- Same-millisecond keyset rows remain ordered and are neither skipped nor doubled.
- Dry-run or rejected annotations do not advance the per-point cursor.
- Overlapping job and operator triggers admit one local pass; the other reports
  `busy` and inspects zero rows.
- Crash/restart preserves point rotation and replays safely from unchanged grading
  cursors.
- The pass remains bounded to `O(B + N)` work and bounded queries under a backlog
  above measured peak.

### Truthful completion claim

This delta is complete when all inventory, bijection, runtime reconciliation,
strict-cap, fairness, reclaim, readout, compatibility, package, and rollback gates
above pass. It may then claim "the invocation census is the executable production
callsite denominator" and "grading is fair and work-conserving under a strict global
budget," while reporting the exact nonzero repair backlog. It may not claim that
every origin has a unique decision identity until `repair-required` is zero, nor
claim full decision visibility, complete census enrollment, or outcome-quality
closure; those remain governed by the parent spec's eight release acceptance
conditions.

## Open questions

*(none)*
