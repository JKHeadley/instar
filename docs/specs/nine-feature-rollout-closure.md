---
title: "Drive 8 nine-source-PR placement closure"
slug: "nine-feature-rollout-closure"
author: "Instar-codey"
eli16-overview: "nine-feature-rollout-closure.eli16.md"
status: approved
approved: true
parent-principle: "Maturation Path — Test Agent → Development Agent → Fleet"
review-convergence: "2026-07-22T00:58:42.397Z"
review-iterations: 10
review-completed-at: "2026-07-22T00:58:42.397Z"
review-report: "docs/specs/reports/nine-feature-rollout-closure-convergence.md"
cross-model-review: "codex-cli:gpt-5.5 + gemini-cli:gemini-3.1-pro-preview"
single-run-completable: true
frontloaded-decisions: 2
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Drive 8 nine-source-PR placement closure

## Architectural overview

The scanner reads each canonical source spec. The reconciler stores one typed
accounting row on the existing initiative. D7 reads that row's numeric contract,
samples an existing owner counter, and writes an advisory evaluation to its existing
ledger. The lifecycle summary returns the accounting row and latest evaluation.

`source spec → scanner → initiative accounting → owner counter → D7 observation → summary`

No arrow points back into a flag or owner: this path observes and reports only.

## Key terms

- **D7:** the existing recurring, advisory feature-maturation evaluator and ledger.
- **Rung:** `test-agent-live`, `dev-agent-live`, or `fleet` for a feature with its
  own rollout flag. **Rung-null** means no independent flag or ladder advancement.
- **Placement closure:** every source PR has one honest accounting row.
- **Evidence readiness:** D7 has fresh, sufficient samples and the contract is `ready`.
- **Rollout promotion:** the existing owner authority changes an active feature's rung.
- **Operational readiness:** operator judgment over applicable origin-local evidence.
- **Owner surface:** the existing content-free counter or bounded event log from the
  component that performs the work, exposed through a component-internal read method
  or a bounded local file reader.

## Problem statement

PRs #1531–#1539 shipped five independently controlled features, three components
that deliberately compose existing controls, and one documentation-only foundation.
The shared rollout scanner and D7 maturation ledger cannot currently distinguish
those shapes. Treating every PR as independent would invent flags and owners; omitting
the composed and documentation work would make the closure report incomplete.
The current scanner implicitly models a shipped PR as one independently controlled
feature, which is exactly the assumption these composed and documentation rows break.

## Proposed design

Extend the existing spec frontmatter scanner, InitiativeTracker record, rollout
reconciler, blocker-lifecycle ledger, and summary schema. Every source PR has exactly
one `active`, `composed`, or `excluded` accounting row. Active rows retain their real
flag and derive one of `test-agent-live`, `dev-agent-live`, or `fleet`. Composed and
excluded rows are always rung-null. A composed row names its existing owner and owns
a feature-specific numeric contract, but never gains a rollout control. The excluded
documentation row has a reason and no metric.

D7 adds a closed `feature-summary` projection-descriptor allowlist. Readers snapshot counters
already owned by each feature into the existing D7 SQLite observation table. They do
not write feature state, advance rungs, or create a second store. Missing readers,
stale observations, and inadequate samples fail closed as insufficient evidence.
The allowlist is one additional source kind and fixed `sourceRef` entries in D7's
existing descriptor parser, paired with in-process read callbacks on the existing
evaluator. It extends the same D7 metric descriptor type and parser; it is not a
parallel or persisted registry. Unknown refs are rejected while
parsing the metric contract and therefore produce no observation, but the independently
parsed source-PR accounting row remains visible and the evaluator records
`invalid-contract` plus the bounded parser code; scanner tests pin that diagnostic rather than silently
coercing or dropping the source PR.
Each allowlisted descriptor is version 1 and fixes its sample definition, freshness
model, zero-activity posture, and additive-compatibility rule. D7 persists that
descriptor version on every observation; a future semantic change requires a new
version/ref rather than silently reinterpreting old evidence.
The owner owns its counter semantics; the child contract pins the corresponding
sourceRef/version. An owner change must prove additive compatibility or publish a new
sourceRef/version and update the child contract through ordinary spec review.
The existing evaluator scores active and composed contracts; it lists but never scores
excluded rows. SQLite migrations preserve old observations and make evaluation rung
nullable. Pool sanitization accepts the additive accounting fields while retaining
backward compatibility with peers that omit them.

| Data object | Existing owner/store | Key | Mutation authority |
|---|---|---|---|
| Source-PR accounting | InitiativeTracker | feature ID + source PR | rollout reconciler from canonical spec |
| Metric contract | canonical source-spec frontmatter | feature ID + metric ID | reviewed spec only |
| Numeric observation | D7 SQLite observation table | origin + feature + metric + due time | D7 projection reader |
| Evaluation | D7 SQLite evaluation table | origin + feature + due slot | D7 evaluator only |
| Lifecycle summary row | read projection, not stored | origin + feature | none |

A composed contract lives in the child's own source-spec frontmatter, for example:
`{"source":"feature-summary","sourceRef":"context-recovery.successful-recoveries",
"direction":"at-least","threshold":1,"minSamples":1}`. D7 writes the observation
under the child's feature ID, while its callback reads only the named existing owner
surface; owner and child observations are never blended. If the owner is dark,
unavailable, or has zero qualifying activity, the child remains
`insufficient-evidence` and cannot graduate independently.
`minSamples` reflects the smallest real activity set that proves the child path, and
`evidenceMaxAgeHours` is no longer than twice the cadence; reviewers set both from
expected live frequency so rare paths fail closed without masquerading as stale.

A **feature-specific numeric contract** is the child's closed source reference,
threshold, freshness window, and minimum sample count. An **owner surface** is the
already-existing content-free counter or bounded event log from the component that
actually performs the work.

| Row | Own flag | Named owner | Rung | Contract | D7 scored | Can independently graduate | Counted in closure |
|---|---:|---:|---:|---:|---:|---:|---:|
| Active | yes | self | real ladder rung | yes | yes | yes, through existing promotion authority | yes |
| Composed | no | existing component | null | yes | yes | no; score is evidence only | yes |
| Excluded | no | none | null | no | no | no | yes, as provenance |

“Counted in closure” means the source PR has an honest, complete placement row—not
that it is already operationally ready. A composed row remains an open maturation
item until its D7 status is `ready`, but that readiness is advisory evidence consumed
by the operator's existing rollout review; it cannot advance a rung or invoke a
promotion writer. Thus placement closure for this PR and later evidence closure are
visible, separate facts.

The summary labels promotion authority explicitly: active rows report `self-owner`,
composed rows `parent-owner-evidence-only`, and excluded rows `none`. A composed
`ready` status therefore cannot be mistaken for child-owned promotion.

Example: `#1537 accounted as composed → Slack owner emits a live counter → D7 status
ready → operator reviews applicable origins → child remains rung-null`.

## Exact accounting

- Active: #1531 feedback drain, #1533 autonomous throughput floor, #1534 claim
  verification, #1535 blocker lifecycle metrics, #1539 mutual SSH.
- Composed: #1536 context recovery latch under SessionRecovery, #1537 considered
  acknowledgment under AmbientContributionGate, #1538 SelfHealGate's first consumer
  under feedback-factory controls.
- Excluded: #1532 cross-rung coordination documentation.

## Invariants and failure posture

- No new flag, scheduler, state authority, promotion writer, or notification path.
- The reconciler observes flags but never writes them.
- Only closed source references can enter a maturation contract.
- A projection exception or unavailable source emits no observation and cannot pass.
- An unknown projection source is rejected by the closed parser and is visible as a
  distinct `invalid-contract`/`unknown-source-ref` diagnostic; it is never dynamically
  registered from frontmatter.
- Accounting parsing and metric-contract parsing are independent: failure in either
  path must not suppress the other row or diagnostic.
- A missing live reader or no qualifying event remains `insufficient-evidence`; the
  named owner evidence endpoint distinguishes unavailable-owner from zero activity
  without expanding D7 into another health registry.
- Every allowlisted callback has producer-side sample-definition fixtures. Changing
  a fixture's semantics without changing descriptor version/sourceRef fails review.
- Descriptors are point-in-time snapshots with a bounded window sample count; resets
  create a new observation and never reinterpret prior slots. Each descriptor fixture
  pins cumulative/windowed/reset behavior.
- The lifecycle summary lists each closed descriptor's sourceRef, version, threshold,
  direction, and sample floor for bounded operator discovery.
- Excluded work has zero metrics; composed work has an owner and null rung.
- Legacy initiatives without accounting retain their previous evaluation behavior.
- Migration preserves previous rows and rolls back atomically on failure.

## Multi-machine posture

The canonical initiative registry provides the shared accounting identity. D7
observations remain machine-local by the already ratified throughput-metrics design,
and the existing blocker-lifecycle pool read composes per-origin summaries. No new
machine-local state surface is introduced.

Each composed source is intentionally local to the origin that owns the evidence:
SessionRecovery's bounded recovery log, the Slack gate's content-free counters, and
the feedback-defaults SelfHealGate boot result. Zero local activity means inadequate
samples, not success, and another origin's activity never satisfies the local row.
The qualifying activity is explicit: the context-recovery fixture exercises a real
detector-positive recovery; opted-in eligible Slack traffic exercises the real gate;
and every development source-checkout boot runs the feedback-defaults consumer, whose
verified `healthy` or `healed` result is a real sample. Tests may exercise the first
two paths without minting production evidence; D7 records only live owner outputs.
The causality predicates are exact: #1536 counts only a logged
`failureType=context_exhaustion && recovered=true` path (the latch is set before that
path and cleared only after success); #1537 counts only the gate's `react` decision;
#1538 counts only the first consumer's verified `healthy` or `healed` result.
There is no synthetic fleet-wide readiness Boolean. Each composed status is
origin-local and the existing pool route reports origins separately. Operational
review considers only the origins where that owner is intentionally active: the
development source-checkout owner for context recovery and feedback self-heal, and
Slack-enabled origins for considered acknowledgments. Quiet or inapplicable origins
remain insufficient rather than blocking or falsely satisfying another origin.
The source-specific rule is: #1536 and #1538 require `ready` on the designated
development source-checkout owner; #1537 requires `ready` on every origin with an
opted-in Slack considered channel. Other origins are not inputs to that operational
review. The pool route preserves each origin so the operator can verify this rule
without cross-origin evidence substitution.
Applicability and evidence are read in the same D7 callback at the due slot: source
checkout/feedback-drain posture for #1536/#1538 and one
`/permissions/ambient-stats` snapshot for #1537. The pool row's origin plus that named
evidence endpoint is the review basis; later changes belong to the next due slot.
If the applicability reader is unavailable, applicability is unknown and the row is
`insufficient-evidence`; unavailability can never shrink the applicable-origin set.

machine-local-justification: operator-ratified-exception (`docs/specs/throughput-metrics.md` and the existing `blocker-lifecycle-ledger-v1` state-registry owner establish per-origin D7 truth with pool projection).

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| Accounting disposition | invariant | Exact operator-authorized mapping of nine source PRs. |
| Active rung | invariant | Deterministically derived from the existing observed flag posture. |
| Metric readiness | invariant | Closed threshold, minimum samples, freshness, and missing-evidence fail-closed rules. |
| Promotion non-authority | invariant | D7 remains advisory and has no advancement authority. |

## Frontloaded Decisions

The operator selected the composed-component model and authorized the exact 5/3/1
mapping. The operator also required extension of the existing registry and D7 ledger,
forbidding standalone child controls, fake flags, and parallel stores.

A static manifest was rejected because it could account for provenance but could not
run the operator-required real graduation criteria for the three composed children.
The scan remains the static accounting source; D7 supplies only recurring evidence.
Reusing the blocker-only D7 sources would mislabel unrelated owner counters as blocker
latency. Adding one closed read-only source kind keeps the existing descriptor shape
and storage path while avoiding three bespoke stores or semantically false fields.
A hybrid manifest plus contract references was also rejected: source-spec frontmatter
is already the reviewed canonical identity and contract path, while a standalone
manifest would create a second identity list that can drift from those specs.
A generated, non-authoritative report from scanner output remains acceptable for
audit convenience; only a hand-maintained identity manifest is rejected.
OpenTelemetry, Prometheus, or an event transport would add a second metrics transport
and weaken offline personal-agent operation; bounded local callbacks keep closed-ref
validation and reuse D7's existing durable observation/pool path.
Persisting a second owner event stream was rejected because these owners already
retain the needed bounded counters/log; live bounded reads avoid duplicate durable
events while D7 remains the sole durable evidence projection.
A generic internal metric registry would also add a parallel abstraction for only
eight closed descriptors; D7-specific descriptors preserve its freshness, sampling,
origin, and evaluation semantics in one reviewed type.
If the allowlist exceeds 32 descriptors or four producer families, a separately
converged typed-registry extraction is required; until then each addition is an
intentional code-reviewed descriptor, callback, and producer fixture.

## Open questions

*(none)*

## Maturation plan

- **test-agent-live:** Run the exact nine-spec scan, 5/3/1 reconciliation, real
  feature projections, invalid/missing evidence, nullable migrations, and hostile
  pool fixtures live on Codey. No composed row may acquire a control or rung.
- **dev-agent-live:** On the designated development owner, verify #1533/#1534/#1535
  remain visibly built-on and active, every applicable contract receives a fresh D7
  evaluation each cadence, and mixed legacy peers remain readable.
- **fleet:** Only each of the five active features' existing promotion authority may
  advance its real flag-derived rung after its own criterion. Composed/excluded rows
  remain rung-null; this closure work performs no default flip.
- **graduation criterion:** All source PRs #1531–#1539 appear exactly once as five
  active, three composed, and one excluded; every active/composed row has its declared
  owner, criterion, evidence, and descriptor; zero false-ready evaluations, zero
  synthetic flags, zero hostile peer acceptance, and no migration loss occur through
  a seven-day development-owner evidence window.
- **dark-window:** Review test-agent evidence within 14 days. Any missing contract,
  unknown applicability, stale evidence, or descriptor drift keeps that row open and
  advisory without changing owner behavior.

## Verification

Unit tests prove parsing, the closed projection registry, 5/3/1 reconciliation,
rung-null composed evaluation, excluded non-evaluation, nullable migration, and pool
sanitization. An integration fixture scans the real nine spec records and asserts each
source PR appears exactly once with a real contract where required. Typecheck, focused
tests, full test suite, migration audit, and independent review must pass before merge.
