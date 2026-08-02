---
title: "Full Decision Visibility — Enactment Delta"
slug: "full-decision-visibility-enactment"
author: "instar-codey"
status: "draft"
source-audit: "docs/audits/full-decision-visibility-enactment.md"
eli16-overview: "docs/specs/full-decision-visibility-enactment.eli16.md"
lessons-engaged:
  - "P1 Structure beats Willpower — universal coverage is enforced at the evaluate-call boundary, not maintained by a hand-curated component count."
  - "P4 Test Everything E2E — acceptance requires real decision-to-outcome joins and a real-case review, not schema or fixture presence."
  - "P5 Observable Intelligence — capture distinguishes model verdict, enacted disposition, evidence, and unknown rather than collapsing them."
  - "P6 Zero-Failure — write failures and dropped rich evidence are measured defects, never silent observability loss."
  - "P10 Comprehensive-First — the complete denominator, capture, outcome, review, cost, and fleet contracts are designed together and landed in independently safe increments."
  - "L1 AGENT.md bloat — no generated decision inventory or review corpus is injected into identity context."
  - "L6 Side-effects review — local sensitive storage, provider egress, retention, rollback, and fleet effects are explicit."
  - "L11 External operation gate — benchmark export and any new reviewer egress remain consent-gated external operations."
---

# Full Decision Visibility — Enactment Delta

## Problem statement

Justin's source contract is:

> Whenever the system encounters this situation, it should record as much as it can, including the choices it was choosing between, the choice it made and WHY, and all other related context, including even a screenshot if possible. The goal should be FULL VISIBILITY INTO ALL OF THE SYSTEMS DECISIONS so that we can evaluate its decision making periodically. This also gives us benchmark scenarios FROM REAL SITUATIONS, and allows us to tune the prompts, inputs, context, and models we use moving forward. This is the standard we needs to apply everywhere.

The shipped decision-quality foundation does not enact that contract yet. Its
component census has 11 wired, 47 pending, and 6 exempt rows, but component rows
are not a proved denominator for individual model judgments. Twenty-eight pending
points are merely unenrolled, nine conceal multiple calls or mismatched identities,
and ten are dark, stale, or router-blocked. Four live measurement-only points lose
the correlation needed to join decisions to outcomes. Rich context is count-valved:
current fleet evidence shows 21.8 percent of detailed rows dropped overall and
39.2 percent dropped for completion verification. The current rich envelope also
cannot reproduce the full handed prompt or attach a screenshot artifact.

The July accountability audit correctly categorized provenance, outcome, and
real-case parity gaps, but explicitly did not certify their fixes. A later universal
architecture attempt hit the round-10 review cap and is preserved as negative design
evidence. This delta starts from the empirical audit rather than reviving that design.

## Outcomes and non-negotiable invariants

When this spec is fully landed:

1. Every production model invocation has exactly one stable decision-point identity
   and exactly one settlement row, including failures and empty results.
2. Coverage is measured against compiler-enumerated invocation sites, not a manually
   asserted component total. An unregistered production invocation fails CI.
3. Every supported decision retains the alternatives presented, raw model choice and
   rationale, deterministic floors, enacted disposition, prompt/input/context/model
   identity, and a scrubbed, locally reproducible rich evidence package. Supported
   decisions are never sampled or discarded by a daily row cap.
4. When a screenshot or existing visual input is safely available, its local artifact
   is attached. When it is not captured, the durable row says why; absence is never
   mistaken for successful capture.
5. Outcome evidence joins by correlation identity, is versioned and strength-typed,
   and preserves unknown when evidence is missing, subjective, circular, or stale.
6. Periodic review produces real-situation benchmark candidates and separates four
   tuning axes: prompt, input selection, context construction, and model. No aggregate
   "accuracy" number hides which axis changed.
7. Full sensitive evidence stays auth-gated and machine-local under the existing
   constitutional locality rule. Cross-machine views unify redacted structure and
   route outcome writes to the decision's owner.
8. Capture never blocks or changes the production decision. Capture loss is loud,
   retry-bounded, and visible as missing evidence rather than fabricated completeness.

## Scope

This spec covers every production invocation of `IntelligenceProvider.evaluate`
and `IntelligenceRouter.evaluate`, including model judgments invoked by gates,
sentinels, reviewers, arbiters, extractors, classifiers, summarizers, and authoring
jobs. It also captures the deterministic floors and enactment steps that transform a
model verdict into system behavior.

For this delta, "all system decisions" means all production model-backed judgments
and their deterministic enactment chain. Pure deterministic branches with no model
judgment are outside this denominator unless they are a floor or actor for an
enrolled model judgment. A future deterministic-decision census may extend the same
substrate, but it cannot be used to delay or dilute the complete model-judgment
denominator delivered here.

## Non-goals

- Rebuilding the existing benchmark-divergence detector.
- Automatically changing prompts, context, routing, or models from observed grades.
- Treating recurrence, silence, task completion, or another invocation of the same
  classifier as independent ground truth.
- Uploading the local rich corpus, screenshots, or message bodies by default.
- Capturing arbitrary desktop screenshots after the fact.
- Replacing domain stores with a universal workflow engine.
- Turning the convergence-failed universal-loop package into an implementation plan.

## Current-state evidence

The canonical evidence is `docs/audits/full-decision-visibility-enactment.md`.
Its two-round audit converged with 17 current-state findings and zero new findings
in the adversarial re-sweep. The implementation must preserve its classifications:

| Class | Count | Required treatment |
|---|---:|---|
| Router-backed, straightforward pending | 28 | Enroll directly through the typed contract. |
| Actionable after identity or composition repair | 9 | Split distinct judgments and repair exact component identity before enrollment. |
| Blocked, dark, or stale | 10 | Route, create a live owner, split, or move to a justified exemption; never call it wired. |
| Wired live points with no outcome closure | 4 | Persist correlation into domain state and add point-specific evidence rules. |

The implementation must regenerate this classification from current main before
editing callsites. If any count changes, the registry and this table are updated in
the same increment; count drift is evidence, not a reason to preserve stale numbers.

## Proposed design

### 1. An executable decision-call denominator

#### 1.1 One invocation, one identity

Add a compiler-backed inventory over production TypeScript. Every call whose
resolved receiver implements `IntelligenceProvider` or `IntelligenceRouter` and
invokes `evaluate` must carry a provenance block whose decision point is an imported
`DP_*` constant from the canonical registry. The inventory records:

- source module and enclosing symbol;
- imported decision-point constant;
- component identity;
- prompt identity;
- composition identity when one human-visible decision spans multiple calls;
- whether the path uses the shared router or an explicitly declared transitional
  direct-provider path.

The lint fails on a missing constant, an inline decision-point string, one constant
used by two semantically distinct invocations, a registered point with no callsite,
or a callsite hidden behind an injected callback without a registered adapter.
Test fixtures and provider adapter internals use a closed, source-controlled
exclusion list with a reason and owner; exclusions are not allowed for production
judgments.

The current component registry remains the human catalog but no longer claims to be
the denominator. Its row identity becomes one-to-one with invocation identity.
Multi-call decisions receive suffixed point and component identities per call, plus
a shared composition ID. The census read surface reports both invocation count and
human-visible composition count.

#### 1.2 Router closure

All production decisions route through `IntelligenceRouter`. Direct-provider CLI
paths, cross-model reviewers, and standalone commands receive a router seam rather
than a second capture implementation. A temporary direct-provider entry may remain
pending only while its migration increment is active; it receives correlation and
content-free metrics from the breaker but is not reported as fully wired.

The ten blocked/stale entries are resolved explicitly:

- no live callsite becomes exempt or is removed from the active denominator;
- a live direct-provider call is routed;
- a class with no production owner remains pending until its owner exists;
- an aggregate class is split before enrollment;
- a delegating alias with no invocation is exempt as delegation, never counted as a
  decision.

#### 1.3 Ratchets

The standing guard is extended so CI proves:

- every production invocation is inventoried;
- every inventory point exists exactly once in the registry;
- wired rows use the router and a typed context builder;
- pending and exempt rows cannot absorb observed wired activity;
- multi-call declarations link only registered unique members;
- the pending count cannot grow without a same-change named close path;
- all registry rows have a content, retention, outcome, and fleet posture.

The test reports the actual source denominator and registry partition. It does not
claim semantic completeness from a zero-diff alone; the audit must be rerun whenever
the compiler inventory method or provider interfaces change.

### 2. Complete structural and rich capture

#### 2.1 Settlement record

The router mints one decision correlation ID before the first attempt and writes one
content-free settlement record on every exit. The record contains:

- decision point, composition ID, component, prompt ID, schema revision;
- correlation owner machine and attempt identities;
- model, provider door, routing reason, fallback ladder, token usage, measured cost,
  latency, and error class;
- alternatives presented, parsed raw model choice, raw rationale disposition, and
  the final response hash;
- deterministic floor inputs, raw recommendation, enacted disposition, actor, and
  any veto or transformation reason;
- references and hashes for handed prompt, input, context, response, visual artifact,
  and domain state;
- capture status for every required part.

Caller-authored labels remain enum-like and length-clamped. Runtime content never
enters served label columns.

#### 2.2 Local evidence package

Add a content-addressed evidence store under the agent's protected state directory.
Each decision package contains the exact serialized prompt and model-visible inputs
after the same deterministic secret scrub applied before provider egress, the exact
provider response, the parsed choice/rationale, the options and floors, and bounded
domain pointers. Immutable chunks are deduplicated by digest and compressed
losslessly. A manifest binds every chunk digest, scrubber revision, byte size,
content class, and retention class.

"Full" means byte-reproducible after the declared scrubber, not a claim that secrets
or prohibited raw content were retained. The manifest records pre-scrub length and
digest when safe to compute in memory, but never persists scrubbed secret material.
If scrub or write fails, the structural row is still written with `capture-failed`
and a fixed error class.

The daily rich-row cap and deterministic sampling are forbidden for enrolled
decisions. Until this store is live, the existing JSONL cap is temporarily raised
for completion verification from 500 to 1,500 per UTC day and the loss counter stays
loud. The temporary cap is deleted in the evidence-store increment; it is not the
final architecture.

#### 2.3 Visual evidence

Visual capture is adapter-driven and local-only. A callsite may attach an existing
image already used by the decision, or a screenshot produced synchronously by the
same browser/page automation target. It may not capture the whole desktop or a
different foreground application.

Every decision records one visual disposition:

- `captured` with blob digest, dimensions, source adapter, and redaction revision;
- `not-applicable` when the decision had no visual surface;
- `unavailable` when the target adapter cannot capture;
- `refused-sensitive` when policy forbids capture;
- `capture-failed` with a fixed error class.

Image OCR or secondary model analysis is a separate, explicit review operation. It
is not part of baseline capture and cannot silently create new egress.

#### 2.4 Retention and storage bounds

Structural quality rows retain for 90 days. Rich text evidence retains for 14 days
by default; visual blobs retain for 7 days by default. Content-addressed chunks carry
reference counts across live manifests and are deleted only after the last manifest
expires. Retention sweep is incremental, bounded by files and bytes per tick, and
uses the safe filesystem executor. A corrupt manifest quarantines its referenced
chunks rather than deleting uncertain shared data.

Health exposes logical bytes, physical bytes, dedupe ratio, manifests by content
class, missing parts, write failures, scrub failures, retention backlog, and oldest
unprocessed item. No request performs an unbounded directory walk; counters and an
indexed catalog back the read surface.

### 3. Decision-to-outcome closure

#### 3.1 Correlation propagation

The router correlation callback fires synchronously at mint and is persisted by the
owning callsite before any domain result is committed. Domain state records both the
correlation ID and its owner machine. Failed, malformed, empty, cached, replayed, and
deterministic-short-circuit paths have explicit dispositions so a missing domain
object cannot impersonate a negative decision.

Outcome annotations accept correlation identity and a registered rule ID. The
chokepoint validates that the decision exists, the rule owns the decision point, the
grade enum is valid, the evidence window and rule revision match, and the writer is
authorized. Writes are idempotent by correlation and grader rule. Cross-machine
annotations route to the correlation owner with a durable outbox; failed routing is
visible as pending, never silently rewritten locally as an orphan grade.

#### 3.2 Evidence taxonomy and precedence

Add a truthful `independent-human-review` evidence rung. The full precedence is:

1. deterministic proof;
2. authenticated independent human review;
3. recurrence or longitudinal proxy;
4. independently calibrated LLM interpreter;
5. pipeline self-report.

Within equal strength, direct contradiction resolves conservatively to wrong,
insufficient or mixed evidence to unknown, and only consistent positive evidence to
right. Evidence rule predicates and windows are immutable and versioned. A rule
change mints a new rule ID. `outcomesKnown` is not used as correctness; read surfaces
separate settled right/wrong grades, unknown, expired, and insufficient evidence.

The LLM-interpreter rung remains dark until it has a human-calibrated battery,
independent model/frozen rubric, explicit egress approval, and a measured confusion
matrix. It is not required to land the four human/proxy joins.

#### 3.3 Four live joins

**Unjustified stop.** Persist correlation beside the stop event ID. Preserve raw
authority recommendation and enacted disposition separately. Invalid evidence
pointers may produce immediate deterministic wrong evidence. Authenticated operator
correct/incorrect/unclear review is the strongest normal label. Resume and later work
are bounded recurrence proxies only. No fuzzy timestamp/hash join is permitted.

**Topic intent.** Return and persist correlation, proposals, and disposition for
every attempt, including empty, malformed, and error. Attach one correlation to zero
or many proposal/event IDs. Explicit later user affirmation or contradiction may
corroborate a proposal; silence and arc decay do not. Empty-result false negatives
require independent sampled human review of the local source turn and pre-decision
snapshot. The same extractor may not grade itself.

**Goal priority.** Persist correlation on the attempt envelope, checkpoint,
candidate, and resulting priority event. Checkpoint replay and quoted-only synthetic
paths do not mint a new LLM decision. Add an authenticated review surface mapping
correct/incorrect/uncertain to right/wrong/unknown. Needs-confirmation and later
same-extractor recurrence remain routing/proxy evidence, not correctness proof.

**Alignment.** Persist correlation only for actual model calls, not cache hits or
deterministic indeterminate paths. Retain a bounded local historical input snapshot
so review compares the state actually judged. Authenticated human review or a later
independently calibrated arbiter may grade it; task success is not causal proof
because the current phase has no actuation.

### 4. Periodic review and real-case benchmarks

The periodic review job is deterministic orchestration over settled and reviewable
rows. It does not invoke a model by default. It produces:

- coverage against the compiler denominator;
- capture completeness and failure distribution;
- outcome coverage by evidence strength and rule;
- confusion matrices by decision point, prompt revision, input policy revision,
  context builder revision, model, provider door, and time window;
- cost/latency by the same axes;
- a bounded queue of real-case benchmark candidates with local evidence links;
- explicit unreviewable and unknown populations.

A real-case candidate is content-addressed and immutable. It freezes the scrubbed
input package, expected outcome evidence, rule revision, model-visible choices, and
the production prompt/context identities. Promotion to a bench battery is an
authenticated human judgment; it never copies sensitive content into git. The
in-repo battery uses a scrubbed fixture derived from the case, while the local
manifest keeps the provenance link and derivation digest.

Experiments change exactly one declared axis unless a factorial experiment is
explicitly named. Reports distinguish:

- prompt wording/version;
- input selection and preprocessing;
- context construction and retrieval;
- model and provider door.

The system recommends no production change automatically. An operator can run an
explicit consent-gated replay against alternative prompts or models; those replays
are themselves provenance-enrolled and cost-metered.

### 5. Cost and throughput

Capture and review have separate budgets. Capture of structural and local rich
evidence is complete and not sampled. Review and replay may be budgeted because the
underlying cases already exist.

Immediate operational corrections:

- raise the temporary completion rich-row cap to 1,500 per day;
- raise the grading maximum from 200 to 500 rows per pass;
- allocate a fairness floor per decision point, then give unused capacity to the
  oldest/largest backlog;
- record actual provider usage/cost where available and an explicit estimated flag
  where not;
- charge failed attempts and persist budget state durably across restarts.

Completion verification receives a complete deterministic admission record on every
turn, but calls the model only for protected cues, ambiguous cases, or configured
high-criticality paths. The admission record states which condition admitted or
rejected review. Codex routing must not admit every general observation and then
silently suppress the general-observation contract. Prompts do not duplicate the
same full message and derived clauses unless a measured battery proves both are
necessary.

### 6. Read surfaces and operator experience

Extend the decision-quality surface and dashboard with:

- denominator coverage and the 28/9/10 work classification;
- complete versus partial capture, with missing-part reasons;
- settled right/wrong, unknown, expired, and insufficient-evidence counts;
- evidence-strength and rule-version filters;
- raw versus enacted decision filters;
- prompt/input/context/model comparison views;
- local-only links to a decision's auth-gated rich evidence and screenshot;
- review queue and benchmark-promotion actions;
- cost, latency, backlog age, write failures, and cross-machine routing health.

HTTP never returns full prompt, response, screenshot bytes, annotation rationale, or
message text in aggregate endpoints. A single-item rich view is auth-gated, local to
the owning machine, audited, rate-limited, and redacts by the stored scrubber policy.
Private-view links are not durable evidence pointers and are never written into the
corpus.

## Multi-machine posture

The default posture is unified across an agent's machines.

| Surface | Posture | Mechanism |
|---|---|---|
| Structural decision/outcome rows | unified | Correlation IDs encode the owner; annotations use the existing authenticated mesh with a durable per-owner outbox; pool reads merge owner-qualified aggregates. |
| Coverage registry and evidence rules | unified | Shipped source registries are byte-identical across the release; mixed-version peers report their registry digest and remain separate until upgraded. |
| Review queue and benchmark-candidate metadata | unified | Owner-qualified records merge on read; mutation routes to the owning machine and is idempotent. |
| Rich text evidence and screenshots | machine-local by constitutional exception | Full content stays on the machine that made the provider call; remote views expose only redacted metadata and an unavailable-on-this-machine state. |
| Cost budgets | unified for shared provider spend, machine-qualified for local resource cost | Shared spend uses the existing leased queue ledger; host CPU/storage remain per-machine and merge as qualified rows. |

machine-local-justification: operator-ratified-exception — registry key
`decision-provenance-outcome-review` explicitly requires machine-local-full and
HTTP-redacted handling for judgment content.

Rich content does not strand correctness when a topic moves: structural rows,
outcome annotations, rule identity, and hashes remain unified. A remote reviewer may
request an authenticated proxied view from the owner, but the blob is never replicated
into a second machine's durable store. Owner loss reports evidence unavailable; it
does not reconstruct content from current state or fabricate a grade.

## Decision points touched

| Decision point | Classification | Floor and treatment |
|---|---|---|
| Whether a production model invocation is registered | invariant | Compiler-resolved provider/router call plus a typed imported constant is required; uncertainty fails CI as unclassified rather than guessing coverage. |
| Whether capture may alter a production decision | invariant | It may not. Capture failures record missing evidence and leave the original result unchanged. |
| Whether visual evidence is eligible | invariant | Only an existing decision input or the same declared browser/page target may be captured; whole-desktop and unrelated-window capture are forbidden. Default is no capture with an explicit disposition. |
| Outcome-rule precedence and idempotency | invariant | Closed rule registry, owner match, immutable revisions, strongest-evidence precedence, and conservative unknown are mechanical integrity rules. |
| Human correctness review | judgment-candidate | Authenticated reviewer chooses correct, incorrect, or uncertain from the historical packet. Floor limits output to right, wrong, or unknown; conservative default and unresolved disagreement are unknown; no automated fallback widens that set. |
| LLM interpreter review | judgment-candidate | Floor requires an enrolled independent model, frozen rubric, human-calibrated battery, cost/egress authorization, and right/wrong/unknown only. Default and final deterministic fallback are unknown. Ships dark. |
| Real-case benchmark promotion | judgment-candidate | An authenticated human decides promote, reject, or needs-redaction. The floor forbids raw sensitive content in git and defaults to needs-redaction; no model may auto-promote. |
| Automatic production tuning | invariant | Forbidden by this spec. Reports inform a separately reviewed operator action. |

## Verify the state, not its symbol

| Symbol | Claimed state | Independent corroboration | Unmeasurable behavior |
|---|---|---|---|
| Compiler inventory equals registry partition | Every production model invocation has a declared posture | Build a fixture with router, direct-provider, injected-callback, multi-call, and dead-row cases; compare compiler resolution with runtime settlement IDs in E2E. | Coverage is unknown and CI fails; production read surface reports denominator unavailable. |
| Settlement count and unique correlation | Every invocation produced one structural row | E2E provider records actual starts/exits and domain actor records enacted result; reconcile all three identities. | Mark capture incomplete and raise health degradation; never infer one-to-one from totals. |
| Rich-manifest digest closure | Full scrubbed evidence is reproducible | Recompute every chunk digest and deserialize the historical packet in a clean process. | Package is corrupt/partial and excluded from review or benchmark promotion. |
| Domain correlation present | Outcome belongs to the original decision | Resolve the correlation owner and verify decision point, domain event identity, raw verdict, and enacted disposition. | Outcome remains pending/orphaned, never fuzzy-joined. |
| Grade present | Decision correctness is known at the stated strength | Re-run the immutable evidence predicate or authenticate the human review against the frozen packet. | Grade is unknown or insufficient-evidence. |
| Authored screenshot digest | Visual context was captured | Decode image, verify dimensions/digest/adapter identity, and confirm it was an input or same-target capture. | Visual disposition is unavailable/refused/failed, not captured. |
| Budget counters | Spend stayed inside a durable ceiling | Reconcile provider-reported usage with the persisted queue ledger, including failed attempts and restart recovery. | Refuse new review/replay spend; baseline capture continues locally. |

## Failure handling and supervision

There is no new autonomous operator-notification watcher in this spec. Existing
health surfaces and the periodic review job expose failures; any future notification
source must separately satisfy Self-Heal Before Notify.

The periodic review and retention jobs declare:

- single-flight per owner machine;
- durable cursor and idempotency key;
- maximum 500 grading rows per pass;
- bounded manifest/chunk sweep per tick;
- exponential backoff with jitter;
- breaker after five consecutive failures;
- no retry of a corrupt evidence package without a new repair record;
- audit trail containing IDs, hashes, enums, counts, and error classes only;
- lease ownership for shared/fleet mutation;
- shutdown flush and restart-safe resume.

Capture write failure is a security/observability degradation but not permission to
fail-open on redaction. If scrubbing cannot establish the safe persisted form, the
rich package is refused and the structural row records `scrub-failed`.

## Security and privacy

- Evidence directories are 0700 and files 0600, created through safe filesystem
  primitives with no symlink traversal.
- The rich store, screenshots, and local review annotations are excluded from git,
  support bundles, public publishing, and default backups. Backup includes only
  redacted structural state unless a future operator-approved encrypted-content
  policy is specified.
- Secret scrubbing happens before provider egress and before persistence. The store
  never becomes a route around an existing content ban.
- Every rich read is authenticated, audited, rate-limited, owner-routed, and bounded
  by item/byte limits. Aggregate reads are indexed and content-free.
- Untrusted prompt/response/image content is never executed, rendered with active
  HTML, interpolated into shell commands, or injected into another agent's context.
- Screenshot metadata and OCR are treated as sensitive content. OCR is off by
  default and cannot leave the owner machine without separate approval.
- Human-review endpoints derive reviewer identity from authenticated operator state;
  caller-supplied names do not establish authority.
- Outcome rule IDs, owners, enums, bounds, and revisions are closed registries.
- Retention deletion is reference-aware, bounded, auditable, and recoverable from
  quarantine until the sweep completes.

## Migration and compatibility

The build lands in ordered, independently useful increments:

### Increment 0 — loss and backlog stabilization

Raise the temporary completion cap to 1,500, grading maximum to 500, make grading
work-conserving, fix misleading outcome labels, and expose exact rich-loss windows.
No new content class or egress is introduced.

### Increment 1 — executable denominator

Land the compiler inventory, one-callsite registry identity, multi-call splits,
direct-provider classification, and ratchets. Migrate registry shape additively;
the current read surface serves both component and invocation totals during one
release. No capture behavior changes yet.

### Increment 2 — content-addressed capture substrate

Add the evidence catalog, scrubbed/compressed chunks, manifests, visual disposition,
health, retention, and shadow dual-write. Verify byte reconstruction and measured
storage before switching wired points from JSONL to manifests. Then remove the daily
drop valve for enrolled decisions.

### Increment 3 — census closure

Enroll the 28 straightforward points, repair and enroll the 9 aggregate/mismatched
points, and resolve the 10 blocked/stale rows through routing, a live owner, split,
or justified exemption. This may land as several PRs, but the increment completes
only when the compiler denominator has no unowned production invocation.

### Increment 4 — four outcome joins

Add correlation persistence, human-review evidence class, cross-machine routing,
and the stop, topic-intent, goal-priority, and alignment contracts. Ship review
surfaces read-only first, then enable authenticated annotation after E2E joins pass.

### Increment 5 — review and benchmark loop

Add periodic matrices, real-case candidate queue, safe fixture derivation,
prompt/input/context/model comparison, dashboard surfaces, and explicitly invoked
consent-gated replay. The LLM interpreter remains dark.

Existing JSONL and SQLite rows remain readable until their current retention expires.
No backfill invents missing rich context or correlation. Legacy rows report
`legacy-unreconstructable` and outcomes remain unknown unless an exact existing
domain join is independently provable.

Post-update migration creates directories and schemas idempotently, registers new
jobs disabled until their owning increment is live, and does not rewrite old content.
Rollback stops new dual-writes and jobs, leaves additive tables/files readable, and
retains evidence until normal expiry. Removing the feature must not delete evidence
as part of package rollback.

## Frontloaded Decisions

1. The denominator is production model invocations plus their deterministic
   enactment chain; pure deterministic decisions are a later extension, not a reason
   to call current coverage universal beyond model judgments.
2. Enrolled decisions receive complete structural and scrubbed local rich capture
   with no sampling or count drops. The temporary 1,500 cap exists only until the
   new store replaces JSONL.
3. Full rich evidence and screenshots stay machine-local under the ratified
   constitutional exception; redacted structure and outcomes are unified.
4. Visual capture is same-target or existing-input only. Whole-desktop capture is
   forbidden and absence always has a disposition.
5. Human review is the first subjective evidence rung enabled. Automated LLM
   interpretation stays dark pending a separate evidence-and-egress gate.
6. No production prompt, input, context, or model changes are automatic. The system
   reports and prepares real cases; an authenticated operator owns promotion and
   deployment.
7. Rich evidence is excluded from default backups and public artifacts. Structural
   rows and digests are backed up; content backup requires a future encrypted policy.
8. The implementation is one approved design delivered in six safe increments; a
   partial increment never earns the final full-visibility claim.

None of these decisions is tagged cheap-to-change-after. They touch sensitive
durable content, external provider egress, published interfaces, or correctness
semantics and therefore belong in the approved design.

## Testing and acceptance

### Denominator and registry

- Compiler fixtures cover router calls, direct providers, injected callbacks,
  multi-call compositions, aliases, dead rows, test exclusions, and inline-string
  attempts.
- A whole-tree test proves every production invocation has one unique typed point and
  every registered wired point has a source invocation.
- A real process makes one success, one provider failure, one empty result, and one
  fallback call; actual starts/exits, settlement rows, and correlation identities
  reconcile exactly.

### Capture and privacy

- Clean-process reconstruction produces the exact post-scrub prompt, inputs,
  response, options, floors, and manifest digests.
- Sustained volume above current peak writes every structural and rich package with
  zero budget drops; storage stays within measured bounds and retention is bounded.
- Duplicate chunks dedupe, shared chunks survive until the last manifest expires,
  corrupt manifests quarantine rather than over-delete, and restart resumes safely.
- Secret fixtures, symlink attacks, malicious HTML, huge inputs, corrupt images,
  read amplification, and unauthorized/tunnel reads are refused without leakage.
- Same-target screenshot capture passes; whole-desktop and unrelated-window capture
  are mechanically impossible through the adapter interface.

### Outcome joins

- Stop E2E proves raw versus enacted separation, invalid-evidence grading, operator
  review, retention horizon, and no fuzzy join under repeated stop attempts.
- Topic-intent E2E covers zero, one, and many proposals, malformed/error attempts,
  later affirmation/contradiction, changing intent, and false-negative human review.
- Goal-priority E2E covers attempts, checkpoints, candidate review, replay, synthetic
  bypass, supersession, and uncertain labels.
- Alignment E2E covers actual calls, cache/deterministic bypass, historical snapshot
  review, disagreement, and current-state drift.
- Cross-machine E2E routes an outcome to its owner, retries after temporary loss,
  dedupes replay, merges aggregates once, and leaves owner-loss evidence unknown.

### Periodic review and tuning axes

- Review backlog stays bounded at measured peak with fairness plus work-conserving
  allocation.
- Every aggregate separates right/wrong from unknown, evidence strength, and rule
  revision.
- A real production case derives a scrubbed immutable benchmark candidate and safe
  fixture without copying sensitive content to git.
- Controlled experiments attribute a change to prompt, input, context, or model; a
  mixed-axis run is explicitly labeled factorial rather than misattributed.
- No path can auto-promote a case or auto-change production routing/configuration.

### Release acceptance

The feature is complete only when live dev-agent evidence shows:

1. the compiler denominator and runtime settlements reconcile over a bounded window;
2. pending production invocations are zero, with only justified non-invocation
   exemptions remaining;
3. rich capture drops are zero under above-peak load;
4. all four named live points have nonzero, strength-typed outcome evidence without
   circular or fuzzy joins;
5. a real case is reviewed and becomes a safe benchmark candidate;
6. prompt, input, context, and model comparisons are separately readable;
7. fleet reads and owner-routed writes pass with two machines;
8. rollback leaves decisions unaffected and evidence honestly readable until expiry.

No code, release, or rollout may claim "full visibility into all decisions" before
all eight acceptance conditions pass for the model-judgment denominator declared by
this spec.

## Open questions

*(none)*
