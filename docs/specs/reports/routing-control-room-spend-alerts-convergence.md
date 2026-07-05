# Convergence Report — Routing Control Room — Spend Tracking, Caps & Alerts (Surfaces 1 & 2)

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass ran through the agent's codex CLI in EVERY round
(rounds 1–7, all successful — including both post-amendment rounds). The Gemini
family (gemini-cli:gemini-3.1-pro-preview) contributed one full successful pass in
round 1 and timed out (per-round `degraded`) in every later attempt (rounds 2–5 and
both amendment rounds 6–7) — recorded honestly per round; because at least one full
pass per family succeeded and codex reviewed every round, the spec-level flag is the
clean RAN state, not `degraded-all-rounds`. Family diversity was real: codex drove
the price-freshness/booking-vs-reporting/single-writer findings; gemini's round-1
pass drove the manifest-update-workflow and running-machine-refresh findings.

## Operator amendments (2026-07-05, rounds 6–7)

After the round-5 convergence the OPERATOR reviewed the design summary and issued
TWO amendments, folded as a proper revision and taken through a full confirmation
review round (two internal angle reviewers + codex external + a gemini attempt + the
live Standards-Conformance Gate) plus a verification round (codex external + an
internal delta verifier):

1. **Provider-reported cost/usage as ground truth** (verbatim intent: *"whenever and
   as much as possible ground our cost usage on actual reporting from the
   provider"*). A new **Layer 1c**: per-provider reporting researched and stated
   honestly — OpenRouter reports per-call USD cost in-response (`usage.cost` +
   `cost_details`; the request MUST set `usage:{include:true}`) plus a `/generation`
   authoritative cost and a `/credits` balance; Groq and Gemini report authoritative
   per-call TOKEN usage but NO cheap per-call USD cost; Gemini USD exists only via
   the heavyweight, lagging Cloud-Billing/BigQuery export (a registered follow-up
   input). Provider reports are captured as immutable, append-only, timestamped
   `provider_cost_report` records (retention-declared, receive-clamped), joined per
   call on ONE durable `meteredCallId` (=== the ledger `reserveId`), PREFERRED on
   read (per-row `costBasis`), and cross-checked by a cadenced
   provider-reconciliation sweep whose drift feeds the alerts topic and the PIN
   price-promotion path. One-way safety preserved: a provider report can refine
   REPORTING retroactively but NEVER re-opens gate headroom; the fail-closed
   booking-at-time-of-use gate semantics are UNCHANGED and the gate/settle is
   structurally excluded from the provider-report store. New FD-21.
2. **One single dedicated alerts topic** (verbatim intent: *"any alerts go to one
   single topic … created if it doesn't already exist with checks to make sure a
   duplicate topic isn't being created"*). ALL control-room alerts deliver into ONE
   dedicated **"💰 Routing & Spend Alerts"** Telegram topic via `sendToTopic` (the
   `burnDetection.alertTopicId` precedent) — never `POST /attention`, which spawns a
   topic per item. Idempotent find-or-create rides a resolution LADDER
   (operator-configured id → a POOL-PUBLISHED durable topic-id record → create ONCE
   as a bounded create-once system topic, the `ensureLifelineTopic`/
   `persistLifelineTopicId` precedent); the duplicate guard is fenced
   SERVING-lease-holder-only creation + in-process single-flight +
   everyone-else-falls-back-to-lifeline. Money-critical alerts ride the durable
   relay (dedup latched on CONFIRMED delivery) and the lifeline is the single NAMED
   emergency exception. FD-6 rewritten; the Telegram channel implementation targets
   this one durable topic; Slack extensibility unchanged.

Everything the amendments did not touch — the booking-priced fail-closed gate, PIN
surfaces, single-writer money, rollup storage, subsidy-reporting-only, the increment
split's structure — is UNCHANGED; the split was amended minimally (Layer 1c
capture/display in A as schema+interface-contract, the authoritative reconciliation
in B, the drift alert in C; B ships the minimal topic-resolver foundation it is the
first to need).

## ELI10 Overview

The agent is about to start paying real money, per token, through paid AI "doors"
(gemini-api, openrouter-api, groq-api). Today there is a read-only map of which door
each job uses, but nothing that tracks the dollars: no spend total, no spending limit
you can adjust, and no alert when a bill balloons or a door dies. This spec designs
that missing money layer.

The core idea is **two separate sets of books, kept apart on purpose**. The
*reporting* book answers "what did we spend?" — it stores only immutable tokens with
timestamps and multiplies by a dated price book on read, so a wrong price can be
corrected later and every dollar figure recomputes itself. The *money* book answers
"may this call spend?" — a new, deliberately paranoid ledger the spending gate reads:
fail-closed on any uncertainty, booked at the price in effect at the moment of the
call, and never re-priced afterward. Subsidies and credits only ever make the report
rosier; they can never loosen the cap. Hitting a cap doesn't kill work — the call
just steps over to the next (usually free) door, exactly like a door that went dark.

Control is human-shaped: anyone can FREEZE spending instantly, but raising a cap,
un-freezing, turning a paid door on, or promoting a new price into the book that the
gate trusts requires the operator's dashboard PIN, approving a server-written
plain-language plan on their phone — and what they approve is exactly and only what
applies. Alerts go to a dedicated Telegram topic (Slack pluggable later), are polite
about routine self-healed churn, and a money alert is never dropped just because no
topic was configured. The first live release deliberately keeps the whole budget on
ONE machine; sharing it across machines is a later, separately-gated increment with
its accounting rules already decided.

## Original vs Converged

**Originally**, one book tried to do both jobs: the existing best-effort token
observability table was also the ground truth the money gate would be "rebuildable"
from, and the cross-machine cap reused a lease library's allocation accounting.
Review broke both: a price correction could silently LOWER the money counter and
re-open a cap the operator had set; a dropped observability write could under-count
real spend below the cap; and the borrowed lease accounting re-frees already-spent
headroom under slice churn (an overspend, not a safety bug in the library — a
category error in reusing it for cumulative dollars). **After review**, the money
gate reads its own authoritative, booking-priced, fail-closed `MeteredSpendLedger`
(adopting the write-discipline of the existing `DriftSpendLedger`), reporting stays
recomputable, and nothing flows from the reporting side into the gate — with the
committed figure and the recomputed figure both shown, labeled.

Other load-bearing changes earned by review: prices only reach the gate from a
human-reviewed canonical manifest (the automated price-checker writes a separate
observed cache that structurally cannot touch the gate; promotion is a PIN action
under the same rendered-plan rule as every other money write, with a single-use
nonce, TTL, and refuse-on-drift); every price takes effect at a UTC day boundary, so
the long-horizon daily rollup stays exact under corrections without keeping 400 days
of raw rows (and without ever freezing the server's event loop); reserve/settle got
idempotent terminal states and a locked reconciliation sweep so a slow provider call
racing the sweep can't under-count; a metered call with no bounded output ceiling is
refused; the first money release is single-writer (whole cap on one PIN-designated
machine) with multi-machine slicing deferred to a dark Increment D whose
cumulative-committed rules are frontloaded now; an alive-but-partitioned old money
machine self-fences before a reclaim can ever be offered, so dual money authority is
structurally impossible; the caps view on any other machine proxies to the money
machine instead of showing a false `$0`; and cap-adjust/go-live became phone-complete
dashboard actions approving server-authored plans, stored in a PIN-only state file
that `PATCH /config` (Bearer) structurally cannot reach.

Honesty notes the review forced into the spec: per-door money attribution and the
gate's wiring into the metered call path DEPEND on separate in-flight routing work
(nature-routing enforcement A2.2 + metered provider implementations) — declared as an
out-of-scope dependency with a release gate (no production go-live until one live
end-to-end call proves door === ledger door === priced door); the bench funnel prior
art lives on a research branch, so its earned logic is vendored into `src/` rather
than cited by an off-branch path; and "total" spend is honestly "total within the
400-day rollup horizon."

## Iteration Summary

| Round | Reviewers who flagged | Material findings | Spec changes |
|-------|----------------------|-------------------|--------------|
| 1 | Standards-Conformance Gate: ran (3 flags) · codex (5) · gemini (3) · security (2 blockers + 5 maj) · scalability (1 blocker + 6 maj) · adversarial (4 blockers + 6 maj) · integration (1 blocker + 5 maj) · decision-completeness (7 GAPs) · lessons/foundation (2 blockers + 4 maj) | ~40 (≈10 blocker-class) | Full rewrite: the accounting split (reporting vs MONEY; new `MeteredSpendLedger`, FD-9); cumulative-committed pool cap (FD-10); reviewed-source-only gate prices; token pre-aggregation (no event-loop freeze, 30d raw + 400d rollup); PIN-only state store outside `PATCHABLE_CONFIG_KEYS`; money-gate refusal = swap-tail advance; maturation split (dev-on A / DARK_GATE_EXCLUSIONS B); door-attribution scope honesty (FD-11); Mobile-Complete + rendered-plan writes; testing/migration/awareness/alternatives sections |
| 2 | Gate: ran (0 flags) · codex (5, SERIOUS) · gemini degraded (timeout) · security (3) · adversarial (4) · scal+decision (1) · integ+lessons (2) | 15 | Day-aligned `effectiveAt` (FD-18); canonical-vs-observed price split + promotion flow; cached-token pricing (FD-19); single-writer Increment B + new dark Increment D (FD-20); idempotent terminal reserve states + locked sweep + absolute late-settle; hard `max_tokens` reserve sizing; holder-death surviving-voice alert + PIN reclaim/rebase; gate-consumed stale-price values pinned out of config; rendered-plan smuggle-proofing; proxied-to-holder caps read; overlay/credits declared machine-local with merge-once composition; durable PIN-attempt counter honesty |
| 3 | Gate: ran (1 flag — Near-Silent) · codex (6, MINOR) · gemini degraded · money-safety verifier (2: N-1, N-2) · systems verifier (0 — CONVERGED) | 3 | Promotion brought under the rendered-plan rule (N-1); holder self-fencing `lease-liveness-unconfirmed` + reclaim refused while alive-but-partitioned (N-2); plan nonce/TTL/single-use/refuse-on-drift (C3-4); fallback digest spike-gated (Near-Silent); exactness-wording, holder-health-before-go-live, conservativeMax lint, reportingBasis labeling, substrate-alternatives |
| 4 | Gate: ran (0 flags) · codex (5, MINOR — refinement-class) · gemini degraded · delta verifier (0 — CONVERGED) | 0 (5 refinements folded anyway) | Round-5 polish: exactness qualifier applied everywhere; torn-write recovery invariants (fold is canon, totals a cache); reclaim attestation = conservative emergency estimate (max of fold/attested); schema validator independent of the plan path + before/after audits; go-live release gate (e2e door===ledger===priced proof) |
| 5 | Gate: ran (advisory stochastic singles — each a re-statement of a resolved concern) · codex (5, MINOR — "no fundamental architecture blocker"; refinement-of-refinement notes, all folded) | 0 | Mobile-Complete primary path for credit/subsidy writes; requirement-6 fallback wording spike-gated at the source; C5 folds: stale-price/drift alerts moved INTO Increment B; go-live release gate extended (holder-death drill + invoice-drift reporting); plan-drift = optimistic version-field concurrency with deterministic re-render UX; ledger daily-rotation size bound + build-phase failure-injection design proof |
| 6 (operator amendments) | Gate: ran (51 standards; 1 advisory pre-existing single-writer flag) · codex (5: 2 in-scope material, 2 converged-content tightenings, 1 subsumed) · gemini degraded (timeout) · internal money-safety/adversarial (1 blocker + 7 major + 3 minor) · internal integration/precedents (3 major + 4 minor; ALL cited precedents verified accurate) | ~13 | Duplicate-guard hardened: SERVING-lease-holder creator (not metered-lease), POOL-PUBLISHED topic-id, resolution ladder, fail-toward-lifeline; money-critical alerts on the durable relay with confirmed-delivery dedup + audible `telegramTopicId` repoint; invariant restated (steady-state one topic + named lifeline exception); B ships the minimal topic-resolver foundation (B-never-depends-on-C restored); `meteredCallId` join key; settle reads in-hand response only; per-door BILLED-token mapping (Gemini candidates+thoughts); OpenRouter `usage:{include:true}` mandated; receive-clamp + poisoned capture/render test; provider-store retention (400d, not regenerable); provider-reconciliation sweep isolated (no money lock, `.iterate()`, cadence knob); verifiable totals-checkpoint across rotation; heartbeat-carried monotone committed figure in the reclaim max() |
| 7 (verification) | codex (6: 3 foldable refinements, 3 re-statements of converged decisions) · gemini degraded (timeout) · delta verifier (1 material residue + 6 polish; all 11 other folds verified present & coherent) | 1 | The material residue fixed: the money layer's sweep renamed RESERVE-EXPIRY sweep at every site (the provider-reconciliation sweep is now genuinely "named distinctly" — the two have opposite lock semantics); Increment A's Layer 1c restated as schema + display + interface contract with stub-only tests; provider capabilities hedged as degradable facts (absent field ⇒ normal internal-derived, never an error); implementer's glossary (the two leases, the two sweeps, meteredCallId, topic/lifeline/relay); polish (capture-after-settle wording, three-input rebase audit, both Gemini response shapes, ELI16 ship-list) |

Standards-Conformance Gate: ran every round (51 standards; 3 → 0 → 1 → 0 → 1 flags;
the round-3 flag was fixed; the round-5 singles are advisory LLM re-statements of
concerns the design body resolves — the gate is signal-only by design and its verdicts
are recorded, not chased to a stochastic zero).

## Full Findings Catalog

### Round 1 (initial draft, commit 9db15e18b)

**Standards-Conformance Gate (3):** Maturation Path (dark without a dev-agent-enabled
posture) → FD-16; Mobile-Complete Operator Actions (no phone surface for money
writes) → phone-complete Spend-tab controls; Agent Proposes/Operator Approves (raw
JSON fields) → server-rendered plans.

**External codex (5 material + 1 minor):** price-freshness SLA + stale-gate behavior
→ FD-14; booked-vs-recomputed naming → committed/net labels (FD-15); lifetime cap
outliving pruned ground truth → the 400d token rollup + `MeteredSpendLedger`
(lifetime committed never depends on raw-row retention); pool-lease underspecified →
FD-10 + (round 2) FD-20; Bearer-only STOP as DoS → scoped set-true-only freeze with
actor audit; alternatives section → added.

**External gemini (3):** git-manifest price-update workflow brittleness → the
observed-cache + promotion split (round 2); distributed cap-invariant mechanism
detail → FencedLease binding + (round 2) cumulative-committed accounting; running-
machine price-index refresh → mtime/hash poll rebuild.

**Security (2 blockers, 5 majors, 3 minors):** S-F1 price under-statement loosens the
gate (subsidy 0.99 = known price) → gate books BASE price only, reviewed-source-only,
plausibility floor; S-F2 `PATCH /config` could arm spend → dedicated PIN-only state
store + regression test; S-F3 credit/subsidy write authority → PIN route (primary,
phone-complete) / overlay escape hatch, never the refresh job; S-F4 replicated
records self-authorize on a peer → untrusted-replica posture (and in D,
operator-signed arming); S-F5 frozen freeze-wins monotone latching; S-F6 spoofable
door label books $0 → door single-sourced with the gate from the resolved keyRef;
S-F7 metadata-only scrub + poisoned-error-body test; S-F8 distinct attention source
for cap alerts; S-F9/S-F10 PIN counter durability + parameterized inserts.

**Scalability (1 blocker, 6 majors, 1 minor):** unbounded synchronous full-horizon
rollup + correlated as-of subquery freezes the event loop → daily token
pre-aggregation + worker-thread snapshot above a concrete threshold + `.iterate()`
streaming; stored-token-rollup insight (immutable sums never go stale); 400d raw
retention disk blowup → 30d raw / 400d rollup decoupling; unbounded prune DELETE →
batched rowid-IN-subselect; money-lock scope pinned (booking-only, released during
the call); pool fan-out rides the shared per-peer poll cache; partial `(door, ts)`
index.

**Adversarial (4 blockers, 6 majors, 5 minors):** FD-3 rebuild self-contradiction
(rebuild-from-Layer-0 applies corrected prices to the gate) → the booking ledger is
the sole rebuild source, Layer-0 rebuild forbidden; reserve/settle crash leak + 5xx
phantom spend → reconciliation sweep + all-no-charge-outcomes settle $0; WS5.2
outstanding-allocation accounting miscast as a cumulative dollar cap (slice churn
re-frees spent headroom) → cumulative-committed accounting (FD-10); unfenced per-call
gate under split-brain → per-call epoch re-validation + freeze-on-holder-death;
subsidy range validation; single pool dayEpoch; forward-only refresh; fenced
cap-lowering; two-numbers labeling; freeze-halts-new-admissions; credits expiry;
honest cap-hit wording; episode-bucketed door-dark dedup; NULL-door uncosted rows.

**Integration/multi-machine (1 blocker, 5 majors, 4 minors):** the door never reaches
a recorded row (no plumbing router→provider→recordMetric; metered providers unbuilt;
A2.2 enforcement unbuilt) → the seam contract + FD-11 scope honesty; DriftSpendLedger
reconcile (build-new-adopt-discipline, FD-17); Agent Awareness + Migration Parity
sections; price-join key canonicalization (including a real casing bug in the round-0
example); test-tier design; `/metrics/features`-is-local correction; retention
callsite; fan-out isolation + the nature-routing-observation dependency.

**Decision-completeness (7 GAPs):** metered-lease designation + zero-slice behavior
(FD-13); credits posture; gate gross-vs-net (FD-12 — no downward adjustment reaches
the gate); approaching alerts on daily AND lifetime; alert-topic fallback to the
lifeline; dashboard placement of the controls; operator-specific prices as a
machine-local overlay. FD-5's self-cancelling cheap hedge removed; FD-7 split
(deferral cheap; display frontloaded).

**Lessons/foundation (2 blockers, 4 majors):** the observability side-channel
(error-swallowing `record()`) cannot be the money ground truth → the accounting split
(FD-9); Maturation Path posture (FD-16); the money gate's blocking authority scoped
to a swap-tail advance (Signal vs Authority); caps-display divergence surfacing
(`coverageOk`); metered-calls-through-the-funnel verified as a dependency, not
assumed; FD-8 supervision tier + P19 brakes; testing tiers; retention wiring.

### Round 2 (commit b696a9b72)

**External codex (5, SERIOUS):** daily rollup too coarse for as-of pricing beyond the
30d raw window → FD-18 day-aligned `effectiveAt` (every daily bucket = one price
regime; splitting deleted); canonical-vs-observed store split with an explicit
promotion flow; multi-machine authority tension → FD-20 single-writer B + Increment D
operator-signed arming; cached-token pricing → FD-19 `cachedInPerMtok` (absent =
cached bills as full input; the gate always reserves cached-as-input); Increment B
complexity → single-writer first release.

**Security (3):** the "durable PIN counter" claim was false against the cited code
(in-memory Map) → honest note + an explicit durable `state/pin-attempts.json` build
item + XFF rewording; `reviewed:true` writer constraint was prose → the refresh job
structurally never writes the canonical manifest (lint + test); proposal-smuggling →
the rendered-plan-only commit rule with absent-field rejection + test.

**Adversarial (4):** cadence-sweep vs in-flight late settle under-counts committed →
idempotent terminal states, locked sweep, reconciliation-aware ABSOLUTE late settle,
TTL > max call latency; holder-death freeze had no reclaim path and the alert would
be emitted by the corpse → PIN reclaim/rebase + the surviving-voice alert exception;
the stale-price conservative-MAX was a gate input with no authority home (config =
Bearer-patchable) → pinned to the canonical manifest `doors{}` meta / PIN store +
extended S-F2 regression; reserve sizing undefined without hard `max_tokens` →
required, refuse `unbounded-reservation`.

**Scal+decision (1):** mid-day `effectiveAt` on a day older than 30d cannot be split
→ FD-18 (with the notes: batched-DELETE idiom, TTL pinning, boot rollup reconcile,
credits posture, default SLA — all folded).

**Integ+lessons (2):** the caps money-read had no multi-machine posture (false `$0`
on a non-holder) → proxied-to-holder with honest `holderUnreachable`; the overlay +
credits stores were undeclared machine-local surfaces → declared BY DESIGN with
justification + the merge-once composition rule.

### Round 3 (commit d5a1fd734)

**Conformance gate (1):** Near-Silent Notifications on the hourly fallback digest →
spike-gated (jsonl always; a digest line only on a rate spike).

**Money-safety verifier (2):** N-1 — the price-promotion PIN action sat OUTSIDE the
rendered-plan rule (the one PIN write that sets gate-consumed booking prices,
`corrects`, and doors-meta; the observed cache is untrusted agent-writable input) →
promotion commits solely from a rendered plan enumerating the full point + meta
delta, S2-3 test extended; N-2 — an alive-but-partitioned old holder was not
self-fenced, so a PIN reclaim could create dual money authority (~2× cap silent
spend; the Increment-B "surviving fold" is structurally empty) → the gate fails
closed `lease-liveness-unconfirmed` on a designation/epoch staleness window pinned
strictly SHORTER than the mesh-death threshold, and reclaim is refused while the
alive-but-partitioned (heartbeat-advancing) signal is live. The systems verifier
returned zero material findings (CONVERGED) with the tag counts.

**External codex (6, MINOR — all folded):** exactness wording; single-machine-until-D
honesty + holder health in the go-live plan; conservativeMax maintenance lint + drift
alert; plan canonicalization (nonce/TTL/single-use/refuse-on-drift); reportingBasis
labeling on `/summary`; ledger-substrate alternatives paragraph.

### Round 4 (commit bc9c335c9) and polish (4d1de629d, cc62a74c5, 9e5fc9b4f)

**Delta verifier: zero material findings — CONVERGED (round-4 delta).** N-1/N-2/
C3-1..6/plan-canonicalization/Near-Silent verified complete, consistent, and free of
new contradictions (specifically: the self-fence composes with the O(1) gate read;
the promotion plan rule composes with the git path; the spike gate refines rather
than contradicts requirement 6).

**External codex (5, MINOR — refinement-class, all folded as polish):** the
exactness qualifier applied at every remaining site; torn-write recovery invariants
(the fold is canon, the totals file a regenerable cache; append-first ordering; boot
re-fold; torn-direction tests); the reclaim attestation classified as a conservative
emergency estimate (`max(fold, attested)` — can never under-count); a schema-level
validator independent of the rendered-plan path + canonical before/after audit rows;
an explicit release gate — no production go-live until one live end-to-end metered
call proves `door === ledger door === priced door`.

**Final conformance-gate singles (advisory):** Mobile-Complete on the credit/subsidy
hand-edit option → the PIN dashboard form made the primary path; Near-Silent on the
verbatim requirement-6 wording → spike-gating stated at the source; a final-run
re-statement of the foundation concern (best-effort `feature_metrics` as reporting
ground truth) — this is the exact concern the accounting split exists to resolve, and
the reporting layer self-labels as best-effort (`reportingBasis`, `coverageOk`) while
the money gate reads only the authoritative ledger. Recorded as advisory; the gate is
signal-only by design.

**External codex round 5 (5, MINOR — "I do not see a fundamental architecture
blocker"; all folded):** stale-price/observed-drift alerts moved INTO Increment B
(they change money admission — silent staleness until costs diverge is the failure
this closes); the go-live release gate extended with a holder-death drill + runbook
and provider-invoice drift REPORTING (observability-only, never gate authority);
plan-drift invalidation pinned to optimistic version fields on each governed store
(deterministic "re-rendered — here's the fresh plan" UX, no broad invalidation); the
ledger's bespoke-ness bounded (DriftSpendLedger daily-rotation size bound; a
build-phase failure-injection JSONL-vs-SQLite-WAL design proof); the remaining
"policy-exact" wording note was already satisfied by the applied qualifier.

### Rounds 6–7 (operator-amendment revision, commits b2ab1ae76 / 59811787b / a6b3d1a66 / a5c413b75)

**Round 6 (confirmation round over both amendments).** The Standards-Conformance
Gate ran live (51 standards; its single `possible-violation` flag re-states the
DELIBERATE converged single-writer/Increment-D deferral — pre-existing, defended in
the spec, not introduced by the amendments). The integration reviewer VERIFIED every
cited precedent against the worktree source (`burnDetection.alertTopicId` /
`BurnThrottleRunbook.sendTelegram`; `ensureLifelineTopic`/`persistLifelineTopicId`;
the `bounded:true` create-once budget exemption; the per-lane in-flight
`createForumTopic` single-flight; `POST /attention` = one topic per item) — none
mis-cited. Material findings and their resolutions: the amendment's original
metered-lease-holder-creates + machine-local-persisted-id design would DUPLICATE the
topic on any holder change and was undefined in the C-without-B window → creator
changed to the fenced SERVING-lease holder with a pool-published id and a
resolve-before-create ladder that fails toward the lifeline; money-critical alerts
were fire-and-forget → durable relay + confirmed-delivery dedup latch + lifeline
fallback on ANY failure + audible repoint; a stale `/attention rails` line and the
B-depends-on-C sequencing were fixed (B ships the minimal resolver foundation);
codex's per-call join-key gap → `meteredCallId` threaded end-to-end; the settle's
token source was pinned to the in-hand response with a per-door BILLED-token mapping
(Gemini candidates+thoughts — the thinking-token under-booking trap); OpenRouter's
cost field was made a MUST-set request option; provider fields got a receive-clamp
and the poisoned-body test extended to capture/render; the provider store got a
declared 400d retention (and lost its inaccurate "regenerable" label); the
provider-reconciliation sweep was isolated from the money lock with a cadence knob
and `.iterate()` streaming; the totals-checkpoint became verifiable across rotation
(corrupt/stale ⇒ full re-fold, fail-closed); and the reclaim rebase gained the
heartbeat-carried monotone committed figure as a third max() input.

**Round 7 (verification round).** codex ran again on the changed body: three
foldable refinement-class notes (Increment-A capture honesty; provider-claims
hedging; a glossary), all folded, plus three re-statements of converged decisions —
the JSONL-vs-SQLite substrate choice (resolved at C3-6 with the failure-injection
design proof), the single-writer holder-death trade (FD-13/FD-20/C4-3, now
STRONGER via the heartbeat-carried counter), and "zero open questions" (the named
items are recorded frontloaded decisions: FD-11(c), FD-13, C3-2 — the structural
open-questions gate working as intended). The internal delta verifier confirmed 11
of the 12 round-6 folds present and coherent and found ONE material residue — the
money-layer sweep had not been renamed on its own side, leaving the "named
distinctly" claim false — fixed exactly as prescribed (reserve-expiry sweep at every
site + prefixed ambiguous references), alongside its six polish items. The verifier
itself classified the spec as CONVERGED contingent on precisely that rename.

### External-reviewer degradation (honest record)

gemini-cli timed out (`degraded: timeout`) on its round-2, round-3, round-4,
round-6, and round-7 attempts after a successful round-1 pass. codex-cli succeeded
on every round (1–7). The spec therefore received real cross-model review of every
revision from the GPT family, and of the round-1 design from the Gemini family.
Spec-level flag: clean RAN (`codex-cli:gpt-5.5`), per the aggregation rule; the
per-round degradations are recorded here rather than hidden.

## Convergence verdict

Converged at iteration 7 (re-convergence after the two operator amendments; the
original convergence was iteration 5). The round-7 delta verifier confirmed every
amendment fold present and coherent with exactly one material residue, which was
fixed as prescribed; the remaining external notes are refinement-class or
re-statements of decisions the design body already resolves; the
Standards-Conformance Gate's single advisory flag re-states the deliberate,
defended single-writer deferral. Zero unresolved user decisions remain (the tag
writer's structural open-questions check passes). Frontloaded decisions: 21 (FD-21
added by Amendment 1); surviving cheap-to-change tags: 1 (FD-7's deferral of
amortized subscription cost); contested-then-cleared: 1. Spec is ready for user
review and approval — noting plainly that this is DESIGN ONLY: nothing here is
built, and `approved: true` is the operator's step after reading this report.
