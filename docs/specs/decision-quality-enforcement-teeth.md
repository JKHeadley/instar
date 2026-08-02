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

1. The TypeScript compiler derives every production invocation of the canonical
   decision egress from the same program the build type-checks. An independent
   production-entrypoint guard refuses model/provider egress outside that typed
   boundary, so indirect calls or a file omitted from the program cannot disappear.
2. Every derived expression is classified as exactly one decision origin or one
   compiler-proved infrastructure forwarder. A registry label is not proof;
   unknown or ambiguous classification exits CI nonzero.
3. The decision-origin set and invocation census are a bijection. Either direction
   of disagreement is a build failure, not a backlog-item success path.
4. Every new or changed decision origin uses one imported, stable `DP_*` identity
   and one generated origin capability that no other origin uses. Only sites in the
   separately approved bootstrap map may enter a closed, shrink-only
   `repair-required` posture; multi-call compositions leave that debt with distinct
   identities joined by an explicit composition ID.
5. Non-invocation aliases and delegates are reported separately and never inflate
   the denominator or its coverage percentage.
6. The router derives runtime settlement identity from its embedded generated
   manifest rather than trusting caller-authored callsite or revision fields,
   allowing static callsites and observed invocations to reconcile without retaining
   prompts or message content.
7. A grading pass never inspects more than its configured global row budget, gives
   every point a bounded fair opportunity across passes, and reuses capacity
   relinquished by empty, blocked, or backed-off points.
8. Raising the default grading budget from 200 to 500 supplies measured throughput
   headroom. A frozen production-shaped trace must show whether that headroom
   controls backlog count and age; neither the setting nor the visit count is
   outcome evidence or better ground truth.

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

Add `scripts/decision-call-inventory.mjs` as the compiler-API driver for the
production type-check lane. That lane does not run a separate `tsc` first: the
driver loads the resolved production configuration once, creates one `Program` and
`TypeChecker`, emits the same diagnostics as the displaced type-check command, and
reuses that in-memory program for inventory. If another build lane deliberately
keeps a second program, its clean and incremental wall time and peak RSS are
separately budgeted rather than described as reuse.

The production boundary is not whatever the new detector happens to see. CI also
resolves package, build, publish, and runtime entrypoints, their transitive source
graph, the complete `tsconfig`/`extends`/project-reference graph, and the closed
exclusion rules. It independently enumerates executable production files. Every
TypeScript/TSX production file must be present in the `Program`; every executable
non-TypeScript file must either be a declared content/template leaf or pass a
closed egress prohibition that rejects provider/model-SDK imports, dynamic provider
loads, model subprocesses, and calls into registered decision adapters. Adding a
source extension, entrypoint, root, project reference, or exclusion is an inventory
method change. Generated output, tests, fixtures, parity scenarios, smoke tests,
stress tests, vendored code, and declaration files remain excluded only through
those reviewed rules.

The inventory begins from the canonical `evaluate` declarations and registered
decision-adapter invocation declarations, then follows every symbol reference in
the production program. Each reference must resolve to a direct typed
`CallExpression` or fail. Extracting or binding the method, passing it as a
callback, invoking it through `.call`/`.apply`, a computed element access, dynamic
property selection, spread, or an unresolved higher-order alias is forbidden in
production; the checker may not omit it because it is no longer spelled
`.evaluate(...)`. A direct call is in scope when the receiver or selected signature
resolves to:

- the canonical `IntelligenceProvider` interface;
- `IntelligenceRouter` or a subtype;
- a concrete class implementing the canonical interface; or
- a source-registered decision adapter whose signature preserves the canonical
  options and result contract.

Receiver spelling is irrelevant. Aliases such as `brain`, constructor parameters,
properties, and imported interfaces must resolve by type. Conversely, an unrelated
object named `provider` does not enter the inventory merely because of its name.
Any production reference or call whose receiver, signature, or invocation form
cannot be resolved is emitted as `unknown` and fails the check. Type errors cannot
make a call disappear. A separate closed registry of concrete provider and model
SDK egress declarations must also prove that each real provider boundary is reached
only from an inventoried canonical call chain; direct SDK or provider egress outside
that chain fails even if the primary detector has no matching call to report.

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

Classification is a proof over the call chain, not a manual label. The analyzer
constructs one memoized symbol/call graph, collapses strongly connected components,
and tracks one compiler-branded linear decision-context token from origin to
settlement. It has a fixed proof budget for graph nodes, union alternatives, and
transform expansion: `MAX_GRAPH_NODES=100000` for the memoized production graph,
`MAX_SCC_NODES=512`, `MAX_UNION_ALTERNATIVES=32`,
`MAX_TRANSFORM_STEPS_PER_PATH=128`, and `MAX_BRANCH_STATES=256`. These are shipped
source constants covered by the method digest; exhausting any one is `unknown`,
never partial success or a locally raised override.
An origin must be outside registered provider plumbing, must bind its identity at
that callsite, and must have no proved upstream in-scope evaluation whose judgment
it is merely continuing. A forwarder must satisfy all of these obligations:

1. its enclosing symbol is a typed provider implementation or a registered helper
   reachable from that provider graph;
2. its prompt and operational options derive from the enclosing provider entry,
   router-held decision context, or registered direct-transition context through a
   closed, deterministic transform;
3. it imports, selects, defaults, or overwrites no `DP_*` identity and creates no
   second provenance settlement;
4. it delegates only the same logical evaluation. Retry and provider-swap attempts
   are forwarders only while one router or transition context owns the eventual
   settlement/observation; fan-out that combines independent model judgments is not
   forwarding; and
5. any stripping of the provenance carrier occurs only at a registered terminal
   provider boundary after the router or one registered transition owner has
   retained the sole decision context and attempted its durable observation.

Forwarder candidates come from a closed registry keyed by `callsiteKey`, not merely
an enclosing symbol. Each declaration names an owning interface, settlement owner,
and a transform assembled only from this proof grammar: parameter or context-field
read; single-assignment `const` alias; allowlisted object reconstruction/spread;
nullish default of allowlisted operational fields; a proved queue/retry combinator;
and registered terminal carrier elision after settlement ownership has transferred.
Registry callbacks, arbitrary predicates, getters, mutation, reassignment,
unregistered function calls, unproved closure escape, recursion, mixed-token branch
joins, fan-out, aggregation, and loops that can combine or replace tokens are not
proof.
Branches are accepted only when the same single token dominates every path and
prompt, provenance, result-consumer, and settlement-token lineage remain exact.
Anything else is `unknown`.

The registry only names candidates; the compiler/data-flow checker must discharge
the finite grammar above. A stale declaration, unproved transform, new prompt
source, identity mint or overwrite, independent result aggregation, or path with no
retained settlement owner fails CI. It never becomes a forwarder because a person
put it in the registry. Pathological cyclic, generic, and wide-union fixtures must
terminate within the proof budget and fail closed when the bound is exceeded.

Queue, retry, breaker, and provider-swap wrappers are not a magic grammar atom. A
combinator is admissible only when its exact implementation symbol and AST digest
are pinned in the method digest and its body is itself checked against a smaller
closed grammar: it accepts one branded readonly context; an inline thunk captures
only that token plus its proved prompt/options lineage; queueing stores and invokes
one thunk without cloning or fan-out; retry/swap invokes attempts sequentially with
the same token and bounded attempt count; no attempt result is aggregated with
another; and one router or transition owner receives the terminal result. Any
additional callback, concurrent invocation, token substitution, unbounded loop, or
implementation-digest drift is `unknown`. Whole-tree acceptance must prove the real
production router, queue, breaker, retry, and swap implementations—not only toy
fixtures—through this grammar.

Across every proved call chain, exactly one static callsite is the decision origin
and every downstream in-scope callsite is a forwarder. A `wired` chain also has
exactly one router settlement owner. A pending direct-provider chain instead has
exactly one registered transition owner at the breaker or transition adapter. That
owner resolves the manifest token and attempts the durable observation before any
terminal provider strips the carrier. It remains explicitly `pending` and cannot be
called wired.

A generic helper may not hide multiple semantic judgments behind one forwarder.
Callers must either invoke the router directly or call a registered typed decision
adapter whose callsites the compiler inventories. Each distinct semantic callsite
still carries its own `DP_*` identity. Helper indirection is never an exemption from
the denominator.

### 1.3 Stable, content-free identity

Each decision-origin manifest row contains only source-controlled identity and
shape. Paths are Unicode-normalized, repository-relative POSIX paths; absolute
paths, `..`, control characters, host-dependent case folding, and platform path
separators fail. The enclosing-symbol identity is the nearest named implementation
symbol; overload signatures collapse to their one implementation, while nested
anonymous functions append a deterministic syntactic-child ordinal path. Dynamic
or computed enclosing names are `unknown`. Within that canonical symbol, direct
calls use source-order ordinals after parse normalization, independent of line
endings.

The row contains:

- `callsiteKey`: normalized source module, enclosing symbol, and zero-based
  canonical-invocation ordinal within that symbol;
- one generated opaque `DCI_*` origin-capability symbol uniquely mapped to that
  callsite; repair rows receive a distinct non-wired `REPAIR_*` capability;
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

The provenance options at a decision origin must resolve to both an imported `DP_*`
constant from the canonical registry and that row's imported generated `DCI_*`
capability. The capability is a frozen, branded data token; it is not a secret, but
callers cannot construct a raw substitute. The compiler binds each capability to
its one exact callsite and refuses reuse at another origin. Forwarders receive the
same token only through the proved linear context and may not import one. Inline
strings, raw capability-shaped objects, parameters that can carry several decision
points, runtime-computed decision IDs, and copied origin capabilities fail. A
composition with two model calls therefore has two decision points, capabilities,
and origin rows, not one aggregate row used twice.

There is one migration-only exception. Before the inventory/generator implementation
PR begins, a separate prerequisite PR must merge
`docs/audits/decision-call-repair-bootstrap-map.md`. A reviewer independent of the
inventory implementation approves that artifact through the repository's
authenticated review surface. It pins a named pre-generator source commit and maps
each of the audit's nine repair-first findings to exact repository-relative source
symbol(s), expected origin cardinality, a unique `REPAIR_*` marker, and a normalized
source-AST fingerprint. Several origins may map to one finding only when that
separately approved audit records the hidden multiplicity. The artifact's merge
commit and SHA-256 digest are immutable inputs to the generator and its method
digest; the implementation PR may consume them but may not add, edit, or reapprove
the map. CI verifies that the pinned artifact commit is an ancestor of the
implementation PR's merge base and that its bytes are unchanged in the PR.

The first whole-tree generation may mark only callsite keys that match that prior
map at its pinned source commit as `repair-required:<tracker>`. Those rows preserve the observed legacy identity
(or explicitly record that none resolves), cannot be `wired`, and are pinned as a
closed, shrink-only baseline. The checker refuses additions, key substitution,
cardinality growth, marker reuse, or a source/fingerprint change that could let a
new call inherit an old ordinal. An unmatched origin blocks bootstrap. This
exception makes the callsite denominator exact before the semantic identity repairs
are designed; it does not let a new or changed callsite borrow old debt.

### 1.4 Generated manifest and reproducibility

The inventory emits a deterministic, data-only, content-free generated manifest under
`src/data/decisionCallInventory.generated.ts`. Stable sort order is by
`callsiteKey`; timestamps and host paths are forbidden. The generated header records
schema revision, TypeScript version, inventory-method revision, and a digest over
the normalized rows. The method revision digests the inventory script, canonical
provider interfaces, decision-adapter registry, forwarder registry, and exclusion
rules; every transitive analyzer/serializer helper; all resolved compiler configs,
project references, root-file membership, package/build/runtime entrypoints, module
resolution inputs, source-extension rules, and the independent egress guard.

One allowlisted serializer/schema governs the checked-in manifest, temporary
regeneration, failure diagnostics, and runtime projection. It rejects source
literals, registry prose/reasons, AST/type dumps, absolute or parent-relative paths,
control characters, and runtime-derived labels. Component, prompt, composition,
route, exit, and block labels are closed registry values with length limits.
Diagnostics print only safe enum codes and normalized owners/keys; never arbitrary
`Error.message`. Generated TypeScript is inert literal data with escaping tests,
not executable expressions derived from source strings.

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
- stale forwarder declarations and forwarders that overwrite caller identity;
- extracted/bound callbacks, `.call`/`.apply`, computed access, direct model-SDK
  egress, a production file dropped from `tsconfig`, and a newly excluded root;
- anonymous/nested/overloaded symbols, checkout-root and line-ending variation,
  malicious filenames/constants, and proof-budget exhaustion.

## 2. The census is the denominator

### 2.1 Separate invocations from the human catalog

Introduce `DECISION_INVOCATION_CENSUS`, with exactly one row per generated
decision-origin callsite. Each row is keyed by `callsiteKey` and contains exactly one
generated origin capability, identity posture, component, prompt identity,
composition identity, route posture, coverage posture, and existing
content/volume/outcome/fleet declarations. An
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
   once in `C`; `repair-required` keys exactly match the independently reviewed
   bootstrap map and its cardinalities/fingerprints, cannot be wired, and may only
   disappear by becoming exact;
4. generated origin capability, component, prompt, composition, and route posture
   agree field-for-field, and every capability is used by exactly one origin;
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

The caller supplies its imported decision-point identity and generated origin
capability, but never a raw callsite key, manifest digest, or inventory schema
revision. Before a model result exits the router, the router resolves that capability
to the unique exact row in its embedded generated manifest and writes the row's
callsite key, decision point, digest, schema revision, component, prompt identity,
and route posture. An unknown/stale capability or caller tuple that disagrees with
the mapped row is refused reconciled/wired status and increments a fixed
content-free mismatch code; it does not reject, replace, or delay the model result
or error. Static inventory—not runtime lookup—proves that a valid capability was not
copied to another source origin; the runtime makes no impossible physical-callsite
claim. Success, model failure, empty result, fallback, breaker refusal, and timeout
all settle against the same origin identity. Forwarder calls carry the same branded
decision-context token and do not mint another origin.

A `repair-required` row has a unique non-wired bootstrap capability and cannot
settle as wired. A pending direct-provider chain's registered transition owner must
resolve that capability and attempt a separately labeled local invocation
observation through the shared provenance sink before the terminal boundary strips
the carrier. That observation is not promoted to a router settlement. If the direct
path cannot make this observation, the readout reports
`unreconciled-direct-transition` when the recorder is available rather than silently
treating it as not observed.

All reconciliation and transition-observation writes are bounded, non-throwing, and
exception-isolated from production behavior. A recorder timeout, unavailable sink,
serialization failure, or mismatch preserves the original result/error and
enactment byte-for-byte; at most it loses the secondary counter when the recorder
itself is unavailable. Observability never gains authority to retry, reroute,
refuse, or mutate a decision.

The decision-quality read surface exposes, over a bounded window:

- built manifest revision and runtime manifest revision;
- invocation total and wired/pending/direct-transition partitions;
- settlements by opaque manifest-row ID and exit class; repository-local operator
  diagnostics may resolve that ID to a callsite key, but fleet/pool views may not;
- unknown decision point, unknown callsite, and schema/digest mismatch counts;
- wired-but-silent origins;
- observed activity attributed to pending, direct-transition, or non-invocation
  identities;
- per-owner-machine totals without copying full decision content; and
- fixed-enum mismatch and direct-transition observation reasons, never raw errors.

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

The ledger exposes the keyset walk as bounded materialized pages with shipped
`MAX_PAGE_ROWS=25`. Each query is
limited to the remaining atomically reserved budget and its statement is finalized
before any annotation write, avoiding a live `better-sqlite3` iterator on the same
connection. Every materialized row consumes budget even if the point stops before
using the rest of that page. A dedicated read connection with a bounded WAL snapshot
is permitted only if it preserves those charging and finalization semantics.

`gradeOnePoint(limit)` returns a bounded result rather than mutating only shared
totals:

```text
{ inspected, graded, advanced, pageFull, blocked, blockReason, cursor }
```

`inspected <= limit` is asserted. Backoff, missing required evidence stores, and a
pending low-water row report `blocked` and relinquish uninspected allocation. An
annotation rejection counts the inspected row and blocks that point for the rest of
the pass. Closed enum reasons distinguish retryable rejection from permanent
ungradeability. Retryable rows use bounded attempts and backoff without cursor
advance. After the bound, a row can stop blocking later evidence only when the same
annotation chokepoint durably accepts an explicit `unknown/quarantined` disposition
with evidence digest and safe reason; it is never counted as graded or correct. An
empty page returns zero inspected and is not refill-eligible.

### 3.2 Fair first round

Let `N` be the current registered grade-pass points. Add a durable singleton
scheduler row in the decision-quality SQLite store containing schema revision,
canonical point-order digest, next point key, pass ID/status/budget, reserved and
materialized-inspected and abandoned-reserved counts, the active pass's
start/current point keys, phase,
per-point grant/progress, refill cursor and remaining pool, monotonic fencing epoch,
and a bounded local pass lease token
`{ownerMachineId, workerId, epoch, nonce, expiresAt}`. A numeric index alone is not
durable identity: on point add/remove, the next surviving key at or after the old
key leads and the new order digest is committed atomically.

At the start of a pass, points use the canonical order and rotate from the persisted
next point key:

- when `B >= N`, every point receives `floor(B / N)` rows and the first
  `B mod N` points receive one additional row;
- when `B < N`, only the first `B` points receive one row, and the durable start
  rotates so the omitted points lead later passes;
- before inspection, one SQLite transaction acquires the machine-local pass lease,
  increments the fencing epoch, and persists the next start. When `B < N`, it
  advances by `B`; otherwise
  it advances by `max(1, B mod N)`. The latter rotates an exactly divisible
  allocation by one and rotates remainder seats by the number of extras. A live
  overlapping job or operator trigger returns `busy` without inspecting rows. A
  trigger on a non-owner machine returns `not-owner` and also inspects zero rows.

Initial allocation and refill both run in bounded chunks. Before materializing a
chunk, one transaction conditionally renews the exact lease token and reserves at
most the remaining pass budget; after each finalized/committed chunk the worker
yields to the event loop before renewing and reserving the next. Reserved rows are
charged even if that worker dies.
Every materialization, annotation, cursor/outcome commit, renewal, and release
checks the same owner/epoch/nonce fence. A stale holder stops with `lost-lease` and
cannot clear or overwrite a successor lease. After expiry, a successor takes over
the persisted allocation phase and progress of the unfinished pass rather than
starting a fresh budget; abandoned reservations are not reused in that pass. If a
release changes the point-order digest while a pass is unfinished, migration fences
the old worker and terminalizes that pass as `abandoned-version-change` before a
new pass may start; it never reinterprets numeric progress against the new set. This
may leave capacity unused after a crash or upgrade, but it keeps physical inspection
across all workers at or below one pass budget and allows unchanged rows to retry in
a later pass.

For a live worker, reservation reconciliation is exact. After the page statement
finalizes with `m <= r` rows from reservation `r`, one fenced transaction converts
`m` to materialized-inspected budget and releases `r - m` to the shared pool before
annotation begins. If the worker crashes or loses the lease before that transaction,
all `r` becomes `abandonedReserved`, stays charged for the pass, and cannot be
reclaimed by the successor. A crash after reconciliation leaves `m` charged and
cursor state unchanged until a fenced annotation commit. Thus empty and partial
pages return live capacity without reopening the takeover race; abandoned capacity
favors the cap over utilization.

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
unwired, annotation-blocked, or charged to an abandoned crash reservation. Cursor
and outcome writes remain idempotent and fence-checked. Grade reads are batched per
page; annotations are batched, and each affected decision-day/model bucket is
recomputed at most once per transaction rather than rescanned per row. A crash
cannot let a stale worker write, skip an uncommitted row, or create a second budget
for the same unfinished pass.

### 3.4 Read surface

The pass result and existing decision-quality read surface add:

- configured budget, effective budget, initial allocation, reallocated capacity,
  materialized inspected, abandoned reserved, effective budget used (their sum),
  total graded, reclaimed capacity, and final unused capacity;
- starting and next point keys, with numeric indices labeled compatibility-only;
- pass ID/status, canonical point-order digest and next point key, lease owner/epoch/
  expiry, renewal failures, busy and non-owner triggers, takeovers, stale-worker
  aborts, pass duration, rows per second, abandoned reserved capacity, and the
  `grading-method-digest`;
- per-point initial allocation, refill allocation, inspected, graded, cursor
  advancement, page-full state, and block reason;
- a health contradiction if materialized inspected plus abandoned reserved exceeds
  effective budget; and
- backlog age/count as separately measured signals, never inferred from unused
  capacity.

The readout states explicitly that 500 is throughput, not correctness. Unknown
outcomes and missing evidence remain unknown regardless of how quickly rows are
visited.

## 4. Side-effects review

### Over-reach and under-reach

Type resolution intentionally reaches aliases and injected providers that the
current name regex misses. It intentionally excludes resolved unrelated `evaluate`
methods and reviewed non-production roots. Symbol-reference tracing bans indirect
invocation forms, while the independent entrypoint/egress guard catches production
files or provider/SDK boundaries outside the typed program. Unresolved references,
proof-budget exhaustion, and a generic helper that erases the provider type all fail
rather than silently choosing either side.

### Level of abstraction and authority

The compiler owns syntax and type facts; the source census owns reviewed semantic
identity; runtime settlement owns observed execution. No one layer claims the other
two. The inventory and ratchets are read-only build enforcement. Runtime capture is
bounded and exception-isolated: mismatch or recorder failure can make provenance
unreconciled but cannot change the result, error, routing, or enactment. The grading
change only allocates existing deterministic annotation work and adds no authority
to judge, enact, route, or promote production behavior.

### Privacy and egress

The manifest is content-free and checked into git. Its one data-only serializer
contains allowlisted source identities already in source, not prompts, inputs,
responses, source snippets, hashes of user content, registry prose, AST/type dumps,
or machine paths. Runtime and fleet projections are separately field-allowlisted;
fleet views receive opaque row IDs and fixed enums, never source layout or raw error
messages. The compiler check and grading allocator make no model call and no
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
Grading remains machine-local to the decision-quality ledger owner; lease tokens
are bound to that owner and remote triggers cannot acquire or inspect. This delta
does not add a fleet scheduler or remote write. Aggregates label owner machine and
manifest revision so different deployed revisions cannot be merged as one
denominator. Fleet/pool aggregates expose opaque manifest-row IDs and fixed enums,
not module/symbol paths or raw failures. Cross-machine outcome routing remains
governed by the parent spec.

### Performance

Compiler inventory runs in CI and developer gates, not per decision. The compiler
driver reuses one TypeScript program; an instrumented constructor counter must equal
one, and its normalized diagnostic set must equal the displaced `tsc --noEmit`
diagnostic set. On the same clean checkout and runner, after one warm-up and over
five measured runs, inventory/type-check median wall time must be no more than
`max(1.35 * tscMedian, tscMedian + 2s)` and peak RSS no more than
`1.25 * tscPeakRss + 128 MiB`. The runner descriptor, source commit, Node,
TypeScript, and operating-system versions are recorded with results. The shipped
proof-budget constants above make hostile generic graphs fail closed instead of
expanding without bound.

The fixed grading load oracle is `grading-trace-v1`, whose parameters are part of
this specification rather than chosen after implementation: a real SQLite/WAL
ledger begins with 3,000 eligible rows across the five canonical points in
`[2400, 300, 200, 75, 25]` order and ages uniformly spanning 1 through 50 hours.
At the start of each of 12 hourly passes it receives 300 rows in
`[240, 30, 20, 7, 3]` order. All rows are gradeable, and point-local ordering is
oldest first. With `B=500`, the final backlog must be at most 600 and oldest age at
most 3 hours; with `B=200`, the comparison backlog and age are reported and may not
be substituted for the 500-row oracle.

At `MAX_PAGE_ROWS=25`, each 500-row pass permits at most
`ceil(B / 25) + 2N = 30` ledger page reads, 30 annotation-batch transactions, and
240 total SQLite statements. On the committed benchmark runner, a pass must finish
within 5 seconds, add at most 64 MiB peak RSS, and keep p99 event-loop delay below
50 ms; median per-row wall time at 500 may be at most 1.25 times the 200-row
comparison. The versioned fixture records the runner descriptor and exact generated
row digest. Changing an inventory proof budget changes the inventory method digest;
changing a grading trace, threshold, or page budget changes a parallel
`grading-method-digest`. Either requires refreshed audit convergence. Runtime
settlement adds fixed identity fields only, and no full-table or full-backlog count
is added to allocation.

### Rollback

The schema migration is additive and idempotent. Rolling back runtime use leaves the
generated manifest and new scheduler table inert. The compatibility projection
keeps old readers working for one release. Grading cursors remain authoritative;
scheduler rollback may restore fixed slices but cannot lose, fabricate, or duplicate
outcome rows. A rollback may strand an unfinished reserved pass, so it must close or
explicitly abandon that pass before the old scheduler runs; the old scheduler may
not ignore a live fenced owner. Generated-manifest or ratchet rollback must not be
described as complete decision coverage.

## 5. Implementation order

### Increment A — compiler inventory and exact census

Land the single-program TypeScript inventory, independent entrypoint/egress guard,
finite forwarder proof, fixture corpus, generated manifest, invocation and
non-invocation schemas, compatibility projection, bidirectional ratchet,
consumption of the separately merged repair bootstrap map, generated per-callsite
capabilities, derived runtime identity fields, and readout.
Regenerate the source truth and update the audit's counts in the same PR. This
increment changes measurement and enforcement, not model behavior or the semantic
identity of the nine repair-first rows.

### Increment B — work-conserving grading

Land the additive fenced scheduler/pass state, bounded materialized pages, batched
grade/outcome writes, structured per-point result, strict-cap allocator, default
500-row budget, grading-method digest, readout, and fixed load tests. Preserve
cursor, backoff, idempotency, and audited quarantine semantics.

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
  all fail. The real production router, queue, breaker, retry, and swap bodies pass
  the pinned combinator grammar; an implementation-digest or callback-cardinality
  mutation fails.
- Whole-tree generation is deterministic across two clean checkouts and exact-diffs
  the checked-in manifest, including different absolute checkout roots and line
  endings. Instrumentation observes exactly one `Program`; diagnostics exactly equal
  `tsc --noEmit`; five-run wall/RSS measurements meet the fixed relative ceilings.
- Changing an inventory input changes the method digest and fails until the audit's
  digest and convergence evidence are refreshed in the same PR.
- Dropping a production file through `tsconfig`, adding a new runtime entrypoint or
  exclusion, invoking a provider indirectly, or calling a registered model SDK
  outside the canonical typed boundary fails independently of the manifest diff.
- Removing a census row while retaining its source call fails the build with
  `I - C`; adding a row without a source call fails with `C - I`. Creating or
  linking an item never turns either failure green.
- Reusing one decision point at two origins and aggregating a multi-call composition
  both fail outside the closed bootstrap repair set; adding or substituting a
  `repair-required` key also fails.
- Bootstrap fails unless the separately merged, independently approved map's merge
  commit and SHA-256 digest match the generator's pinned inputs and every repair
  origin matches its nine-finding cardinality, marker, and source fingerprint. The
  implementation PR cannot alter the map, and a newly inserted call cannot inherit
  an old repair ordinal.
- Every current production model call is either a decision origin or a proved
  identity-preserving forwarder; there is no unknown bucket at merge.
- Non-invocation catalog rows are absent from invocation totals and coverage ratios.
- Built-package E2E reads the manifest without a source checkout.
- Runtime E2E settles success, provider error, empty, fallback, and timeout against
  one origin without double-counting its forwarders.
- Static fixtures reject a valid generated capability copied to another origin.
  Runtime E2E refuses reconciled status for raw/unknown/stale capabilities, forged
  callsite/revision fields, and component/prompt mismatches; direct transitions use
  one registered transition owner and remain observations rather than wired
  settlements.
- Recorder throw/timeout, an unavailable direct-transition sink, and every mismatch
  leave the original model result/error, routing, and enactment byte-for-byte
  unchanged while refusing a false reconciled status whenever recording is live.
- Two release revisions report separate manifest identities rather than merging
  incompatible totals.
- After restart onto the candidate package, a fixed 30-minute dev-agent window has
  a successful content-free recorder write/read canary with continuous sequence,
  matching embedded/built/runtime digests, and zero unknown capability, unknown
  decision, schema/digest, or tuple-mismatch counts. Recorder unavailability fails
  the window rather than producing a vacuous zero. Every exercised wired
  provider-start has exactly one terminal settlement; every exercised direct
  transition has one non-wired observation or an explicit capture-failed code. The
  window reports unexercised origins as `not-observed`, never green.

### Grading allocator

- With `B=500`, one hot point and four empty points materialize all 500 rows with
  zero abandoned reservation.
- With two hot points, each receives its fair first allocation and reclaimed work
  rotates; total inspected remains at most 500.
- With `B < N`, no pass exceeds `B` and repeated passes give every point a first
  opportunity.
- A backed-off, missing-store, low-water pending, empty, or annotation-blocked point
  relinquishes unused capacity and reports its exact reason.
- Already-graded rows count as inspected; `graded` cannot hide budget use.
- Same-millisecond keyset rows remain ordered and are neither skipped nor doubled.
- Dry-run or rejected annotations do not advance the per-point cursor.
- A permanently ungradeable row cannot starve later rows: only the audited
  `unknown/quarantined` disposition advances past it, and it never raises `graded`.
- Overlapping job and operator triggers admit one local pass; the other reports
  `busy` and inspects zero rows.
- A paused worker that resumes after lease expiry receives `lost-lease`; every stale
  renewal, annotation, cursor commit, and release is refused while its successor
  resumes the same unfinished budget. A non-owner machine inspects zero rows.
- Empty and partial pages reconcile `m` inspected and release `r - m` only under the
  live fence. Crash before materialization, crash after materialization, and takeover
  before reconciliation leave the full reservation charged and unreclaimable in
  that pass; crash after reconciliation leaves only `m` charged.
- Adding/removing a point preserves deterministic rotation by point key and order
  digest; with a stable point set, every point receives a first-round opportunity
  within `ceil(N / B)` completed passes when `B < N`.
- A real-ledger test proves page reads and writes do not conflict on one busy SQLite
  connection. Exact `grading-trace-v1` dimensions produce at most 600 remaining rows
  and 3 hours oldest age after 12 passes at 500; page reads, write transactions,
  total statements, pass time, RSS, per-row ratio, and event-loop delay meet the
  numeric §4 ceilings. The 200-row comparison is reported, not assumed.

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
