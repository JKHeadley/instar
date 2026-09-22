---
title: "Jev job-completion audit (observe-only v1)"
slug: "jev-job-supervision"
author: "echo"
status: approved
approved: true
approved-by: Justin
approved-at: "2026-09-21T23:08:45Z"
approved-via: "Telegram topic 95267 (2026-09-21 16:08 PDT): Justin — 'Yes, approved please proceed', replying to the design handoff with the rendered ELI16 + at-cap convergence report links (13:29)."
parent-principle: "LLM-Supervised Execution"
review-convergence: "2026-09-21T23:09:53.620Z"
review-iterations: 10
review-completed-at: "2026-09-21T23:09:53.620Z"
review-report: "docs/specs/reports/jev-job-supervision-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 2
contested-then-cleared: 5
---

# Jev job-completion audit (observe-only v1)

**Naming honesty (frontloaded):** this is a **post-hoc completion audit**, not
Tier-1 supervision, and not tamper-resistant supervision — it is
**non-adversarial false-success detection** (a buggy or lazy job, not an
attacker crafting output; a compromised job can `touch` its declared files and
print auditor-pleasing text, which is why nothing here ever gains authority
without a later spec's independent probes). The constitution's Tier 1
(`docs/LLM-SUPERVISED-EXECUTION.md`) means failures *detected and reported*,
per step; v1 detects at run granularity and reports to nobody. Tier-1
compliance arrives only when a graduation spec wires verdicts to the attention
queue. The implementation names say what it is: component
`JevJobCompletionAudit`, config `intelligence.jevJobCompletionAudit`, log
`logs/jev-job-completion-audit.jsonl` — nothing is named "supervisor".

Audit eligibility lives in its own manifest field (`completionAudit`), so the
constitutional `supervision` field keeps its execution-mode meaning untouched
for a future real per-step Tier-1 implementation — no field encodes two
things, and this feature never reads `supervision` at all.

**Glossary (local terms):** *noul* — a TypeSafe question type returning a
single probability 0..1 (no native confidence field); *P20 / P24* — the
constitution's "Verify the State, Not Its Symbol" and "Never Silently Cut the
Data a Decision Depends On" standards; *real-check* — the autonomous
`verification_command` gate; *decision-quality meter* — the observe-only
grading substrate over enrolled LLM decisions; *MCA* — the TypeSafe master
customer agreement accepted 2026-09-20; *ladder-1* — the first measured Jev
test series in `docs/research/jev/`. The TypeSafe API contract as used here:
`POST /v1/systemone` with `{state, model, questions}` returns `{model,
answers: {id: {noul|choice, ...}}, usage.input_tokens}`; a non-2xx, a
malformed body, or a response naming another model records the matching
not-audited reason — never a guessed verdict.

## Problem

*(Orientation in one sentence: this is a shadow-mode / offline-eval
deployment of a cheap classifier over job outcomes — captured live, judged
in batch, acted on never.)*

The constitution requires every critical pipeline to run at ≥ Tier 1, but in
code this is a wish, not a guard: `JobDefinition.supervision`
(`src/core/types.ts:525`) is accepted by the manifest loader as forward
vocabulary and read by NOTHING at runtime — there is no supervisor component
at all (tranche-2 audit finding). Consequences, all live today:

- A scheduled job that exits 0 with useless output is recorded `success`
  everywhere: `JobRunHistory.result` derives purely from process/session
  status — the textbook "symbol, not state" failure.
- The one verdict-bearing field (`InstrumentAssessment.verdict`) is a
  SELF-report parsed only on the script path, landing in transient `JobState`,
  never the permanent run row.
- The per-run reflection (`JobReflector` via `IntegrationGate`) compares
  declared STEPS to executed steps — never declared EFFECT to observed effect.
- "Failure rate is not effect rate" (memory, 4 documented cases): work that
  ran and did nothing, with the disproof visible in output nobody read.

**Why an LLM audit rather than stronger job contracts:** typed deterministic
contracts (health checks, exit assertions, checksums, `verification_command`)
are the stronger tool where a job CAN declare one, and any job that can
should — the real-check machinery already exists for exactly that. The
measured gap is the long tail of jobs whose "did it work" lives only in prose
output and loose artifacts; those are the jobs this audit covers, and the
deterministic check's verdict is recorded separately precisely so the soak
shows where a contract would have sufficed. Paying a frontier model per run
was never economical — that is WHY tier1 stayed schema-only. The measured Jev
result changes the economics.

**Why not enrich `JobRunHistory` instead:** run rows carry a 2 KB size cap
with field-dropping and first-writer-wins semantics — the wrong shape for
verdicts plus reconstructable evidence on a different retention. The audit
stores are separate and nothing the scheduler reads changes; a pointer field
on the run row is graduation material.

## Measured basis — and its honest limits

`docs/research/jev/decision-point-fit.md` (21 Sep 2026): given a job's stated
goal plus transcript tail and artifact facts, Jev (jev-1.13.0) caught **8 of
8 false-success cases** at ~$0.001 and ~0.3 s per check. Four limits, stated
rather than implied away:

1. The 8/8 row measured **step-level** supervision; judging once at run
   completion is an **unvalidated extrapolation** of shape. The soak exists
   to re-measure at the run shape before anything acts on verdicts.
2. n=8 positives is too small to freeze a threshold on. **0.70 is
   provisional**: an initial default frozen in code beside the questions;
   changing it is a reviewed code change informed by soak calibration data,
   never config.
3. The ladder-1 calibration property ("across 237 decisions every error sat
   below 0.70 confidence") was measured on **Choice-type** questions, which
   return a native confidence. **Nouls return a bare probability with NO
   confidence field**, so this spec DEFINES the per-noul confidence as
   `max(p, 1 − p)` — a derived quantity the ladder-1 result does NOT
   validate. The transform is frozen in code beside the 0.70 constant, and
   the soak validates (or refutes) the property for this derived quantity on
   this task.
4. Calibration was measured on other tasks; the soak must verify it on-task.

## Design (v1 — capture at completion, audit in batch, observe-only, dark)

Two halves, deliberately decoupled. Nothing consumes verdicts in v1, so
nothing needs to be judged in real time — the LIVE moment is only for
CAPTURE (output exists only at completion). Judging runs in batch over the
captured packs: identical soak data, re-runnable against future prompts or
models for free, no queue/pool/burst machinery, and the capture file is
the durable accounting record FROM the moment it is written — the small
pre-write window is not crash-proof, and is exactly what the reconciliation
counts rather than prevents. A real-time transport is graduation-spec engineering:
batching decouples the TRANSPORT, while run-level verdict accuracy remains
exactly the soak's hypothesis to test (the step→run extrapolation limit
above).

### A. Capture at completion (`JevJobCompletionAudit.capture`)

Invoked at the two completion callsites that hold the live output:
`notifyJobComplete` (immediately after `recordCompletion`, strictly before
the awaited `IntegrationGate` block — the ordering is a tested invariant) and
the script-path completion handler. Wake-reaper timeout completions never
reach these callsites (that path kills the session before recording and its
`result: 'timeout'` is already a known non-success) — no capture, no row, by
structural absence; the test asserts exactly that.

Synchronous work is bounded and tested: eligibility checks are in-memory
reads (config enabled + future `soakEndsAt`; the job's `completionAudit`
manifest value — `excluded` | `eligible` (default) | `priority`); the
snapshot is an O(1) slice of the already-captured output string (≤ 8 KB,
tail-preferring — disproving evidence lives at the end). Everything else runs
detached: the scrub chain over the slice, async `lstat`/`realpath`-contained
stats over the (max 8, load-time-jailed) `declaredEffects` paths, and one
atomic write of the scrubbed evidence pack to
`state/jev-supervision-evidence/<runId>.json` (dir 0700 / files 0600). The
pack write IS the durable admission record; pack-file existence by `runId` is
also the dedupe (racing completion writers produce one pack). Detached capture work is bounded by a global in-flight cap (16): the
pipeline per completion is small (an 8 KB scrub, ≤ 8 stats, one ≤ 16 KB
write), and a completion arriving past the cap is dropped as a counted
`capture-failed` metric rather than allowed to pile up unbounded work. A
failed or dropped capture is visible later in the reconciliation (below),
never silently absorbed.

Pack contents: slug; the manifest's goal/description (clamped 1 KB each, with an in-band
`[truncated]` marker when clamped — same disclosure rule as the tail);
`result`, `durationSeconds`, `trigger`; the output tail with an in-band
truncation disclosure (`[truncated: dropped N of M bytes]` + `truncated:
true`) whenever anything was dropped; `InstrumentAssessment` when present,
labeled an UNTRUSTED SELF-REPORT; per declared effect: exists / byte size /
mtime-after-start as RAW FACTS (each path string clamped 512 B). A pack that
still exceeds 16 KB assembled is refused as `oversize-pack` (malformed
manifest). No file CONTENTS are read or sent. Two free comparator columns are computed and stored in the pack: the
deterministic effect verdict from those facts (all-present-and-fresh /
missing / stale) and a frozen TRIVIAL-HEURISTIC column (error-keyword regex
over the tail + empty-output flag) — the soak's confusion matrices carry
both, so "Jev earns its cost" is measured against the cheapest possible
baseline, never asserted. The deterministic verdict — it is the row's PRIMARY classified
outcome when conclusive, with one stated caveat: *stale can be a legitimate
no-op run* (an idempotent job that correctly had nothing to update), so
"stale" corroborates false-success only when the output CLAIMS the effect was
produced; the soak report breaks out stale-but-reported-nothing-to-do
separately, and the manifest authoring guidance says: declare externally
meaningful outputs, never sentinel files, note idempotent-no-op behavior (and that
mtime freshness is clock-sensitive — an NTP step or an early output touch
can read as stale), and a job that can express a deterministic contract
should use `verification_command`, not this.

### B. Batch audit (`jev-completion-audit` built-in job)

A scheduled built-in job (default every 6 h) iterates packs without a
verdict row, suspicious first (see sampling below), then oldest first, under one simple budget: `dailyCallCap` (default
1500, sized against the measured p95 ≈ 700 completions/day with headroom;
the day's spend counts every ATTEMPTED call — one row per attempt, verdict
or failure — so a restart cannot double it and a degraded vendor cannot
silently exceed it). When the day's eligible packs exceed the remaining budget, the
batch is STRATIFIED: first every pack whose deterministic column is
suspicious (missing, or stale-while-claiming-production — the population
this feature exists for), then `priority` jobs from a reserved 10% slice,
then UNIFORM seeded sampling over the remainder (no time-of-day bias is
possible by construction); rows record their stratum, the batch records its eligible-population size,
and each pack carries its pass-over count — the inputs unbiased
re-weighting actually needs, since repeated overlapping sampling grows a
surviving pack's inclusion probability. Per pack, one Jev call (endpoint
`api.typesafe.ai/v1/systemone`, vault key `typesafe_api_key`, 2.5 s abort
timeout, model pinned `jev-1.13.0`, a response from another model excluded
as `model-mismatch`): typed questions frozen in code —
`produced_declared_effect` (noul), `false_success` (noul), `failure_class`
(choice: did-nothing / partial / wrong-target / errored-but-exit-0 /
cannot-tell; diagnostic detail, deliberately excluded from the confidence
gate). The output tail rides inside an explicit untrusted-data envelope
(job output is attacker-influenceable text; unit-tested).

**Confidence (frozen beside 0.70):** per-noul confidence = `max(p, 1 − p)`;
the gating value is min over the two nouls when the job declares effects,
and `false_success` confidence alone when it declares none (the
`produced_declared_effect` question is structurally unanswerable there).
Every verdict RECORDS; below the line it simply carries
`lowConfidence: true`. **There is no escalation tier in v1**: nothing acts
on verdicts, the soak's corroborated ground truth is the only referee, and a
second LLM would add a vendor and a consent surface while refereeing
nothing. Calibration of the derived confidence happens offline in the soak
report by grading recorded verdicts — all of them, not a sample — against
ground truth. The graduation spec, where a verdict first bears consequence,
builds the System-One-first escalation ladder with its own explicitly named
vendor consent.

**Record, never act.** The verdict row (slug, runId, evidence sha256, the
deterministic effect column, verdicts + probabilities, min-confidence,
lowConfidence flag, ms, modelServed, truncated flag, `corroboration` field)
appends to `logs/jev-job-completion-audit.jsonl` through the codebase's
bounded-JSONL rotation utility. Packs are retention-swept at boot and daily:
age 14 days PLUS count/size ceilings (25,000 files / 200 MB, oldest-first,
audited-first). Rows and packs are machine-local, never exported, never
HTTP-served. Every call is metered into feature metrics
(`jev-job-completion-audit`, framework `typesafe-api`) and enrolled in the
decision-quality meter (observability, explicitly not a decision path).
**Accounting, honestly bounded and CHECKED:** every eligible completion
either has a pack (audited, awaiting audit — which includes `capped` and
still-eligible `sampled-out` — or terminal `audit-failed`/`oversize-pack`,
each state visible) or is counted capture-lost (including `capture-failed`
drops) by the reconciliation: diff the pack
store and verdict log against the scheduler's durable `JobRunHistory`
ledger. The soak report performs that diff, so coverage loss is a checked
number, never an assertion.

**Corroboration honesty (P20):** the quartet for the `false_success`
detector — symbol: the job's output tail (self-authored); claimed state: the
declared effect exists in the world; corroboration: the deterministic
declaredEffects check (and, where a job declares one, the real-check
family); unmeasurable case: **a job with NO independent state signal records
`corroboration: none` and is EXCLUDED from graduation-criterion counting**,
as are `truncated: true` rows (a verdict computed on a blinded tail is not
promotable evidence; the soak breaks out truncated-vs-complete accuracy
separately). Corroboration is ASYMMETRIC: a missing declared effect — or a
stale one whose output claims production — corroborates a FALSE-SUCCESS
positive; all-present-and-fresh does NOT corroborate success (a `touch`
satisfies it) — a success verdict counts as corroborated only via real-check
ground truth or operator reconstruction. Uncorroborated and truncated packs
are still audited on purpose: how Jev behaves on exactly those inputs is
soak measurement, even though their verdicts can never count as promotable
evidence.

**Retry brakes (every repeating behavior carries its own):** a `timeout` or
`http-error` increments an `attempts` counter inside the pack; retries back off across batches (attempt 2 no sooner
than 2 batch intervals after the first, attempt 3 no sooner than 4), and
after 3 failed attempts the pack gets a terminal `audit-failed` row and is
never retried (bounded with widening spacing — a persistently failing pack
cannot eat the cap every 6 h forever). Each FAILED attempt also writes its
reason row immediately (not only the terminal one), so every billed call
debits the day's cap when it happens; a crash between a billed call and its
row write can lose at most one debit per crash, an accepted approximation
the reconciliation surfaces. `sampled-out` is not an attempt: such packs remain eligible for
later batches until retention age-out; one that is never selected ages out
with NO row and falls to the reconciliation's accounting instead — eventual
coverage of every pack is NOT guaranteed and not claimed.

**Closed not-audited reason set** (each reachable in tests; every reason is
a ROW in the same JSONL except the two marked `(metric)`, so a failed but
BILLED attempt debits the cap and is distinguishable from never-attempted):
`disabled`,
`no-key`, `soak-expired`, `audit-excluded`, `capture-failed` (metric),
`oversize-pack`, `sampled-out`, `capped`, `timeout`, `http-error`,
`model-mismatch`, `audit-failed` (terminal after 3 attempts),
`write-failed` (metric when even the row write fails).

Config `intelligence.jevJobCompletionAudit` — same existence-check migration
pattern as `intelligence.jevSignalShadow`, with two added fields:
`{enabled: false, model: 'jev-1.13.0', timeoutMs: 2500, soakEndsAt: null,
dailyCallCap: 1500, batchIntervalHours: 6}`.

Dataflow at a glance:

```
completion callsite ──eligibility (in-memory)──▶ O(1) tail slice
        │                                            │ detached
        ▼ excluded → nothing                         ▼
                          scrub + jailed stats + deterministic verdict
                                       │ atomic write (durable admission)
                                       ▼
                     state/jev-supervision-evidence/<runId>.json
                                       │ every 6h, budgeted, uniform sample
                                       ▼
                       batch: Jev call (2.5s) ──▶ verdict row
                              (lowConfidence flag when min-noul < 0.70)
```

## Decision points touched

| Decision point | Classification | Justification |
|---|---|---|
| *(none — signal-only by construction)* | `invariant` (vacuously) | Every branch — capture, refuse, audit, flag lowConfidence, sample out — terminates in an unconsumed file/row/metric; no branch carries behavioral consequence for any message, job, or session. The guarded behaviour (completion handling never delayed/altered) is structural (bounded sync slice, detached everything else) and pinned by the hanging-stub timing test. Decision-quality-meter enrollment is observability, not a decision path. |

## Multi-machine posture

| Surface | Posture |
|---|---|
| `logs/jev-job-completion-audit.jsonl` + `state/jev-supervision-evidence/` | machine-local. `machine-local-justification: hardware-bound-resource` — the audited runs are tmux/scheduler sessions bound to this machine's hardware; each machine audits its own scheduler. (The sibling shadow spec's `physical-credential-locality` label for the same shape is arguably mis-keyed; correcting it is owned by evolution action ACT-037.) |
| Config | unified (ordinary per-machine `intelligence.*` block) |
| `declaredEffects` / `completionAudit` manifest fields | travel with the job definition like every manifest field |

## Egress honesty

While enabled, the scrubbed evidence pack leaves the machine to **one**
vendor: TypeSafe. The scrub chain removes **credential-shaped secrets
only** — it is not a PII or business-content filter, and job output can
contain such content; the operator's flip-time consent is informed of that
boundary. Job output is a NEW egress surface (distinct from the outbound
message shadow's), so the flag is never flipped without the operator's
explicit yes. When a graduation spec adds an escalation vendor, its consent
names that vendor explicitly — consent binds to vendors, never to a routing
abstraction.

## Agent awareness

The CLAUDE.md template gains a **minimal card in the same PR** (Agent
Awareness standard; a card postponed to a later release is a named
backtrack-tell, and the sibling shadow spec's missing card is an
outstanding gap owned by evolution action ACT-037): the feature's name, dark-by-default posture,
log/evidence locations, and the honest "this is an audit record, not
supervision" line. The full proactive-triggers card ships with graduation.

## Maturation plan

- **test-agent-live:** all three tiers green before merge; flag-off boot
  produces zero audit artefacts; the hanging-stub test proves completion
  timing is unaffected; a planted secret never reaches a pack, request body,
  or row.
- **dev-agent-live:** dark on merge; an observe-only soak on this agent after
  explicit egress approval. Soak length is the operator's flip-time decision
  (his standing direction is 2–3 days for trials; the spec does not bind
  it). Soak report contents: per-failure-class confusion vs (a) the
  deterministic effect column, (b) real-check ground truth where declared,
  (c) operator spot-checks reconstructed from retained packs (each pack's
  sha256 recomputed against its row first); a named breakout of every case
  where Jev CONTRADICTED conclusive deterministic evidence or trusted the
  self-report against weak corroboration; the stale-but-reported-nothing-
  to-do breakout; a confidence-distribution histogram (a degenerate
  `max(p, 1 − p)` clustering at extremes would make the lowConfidence flag
  meaningless — the histogram makes that visible); the truncated-vs-complete
  breakout, plus a note per corroborated positive on whether the disproving
  evidence actually sat inside the retained tail (the tail-preference
  assumption is itself under test); the **capture-loss reconciliation** (pack store + verdict log
  diffed against the durable `JobRunHistory` ledger — every eligible run is
  accounted for or counted capture-lost, making the process-alive accounting
  bound CHECKED, not asserted); and the **contract-migration list** — jobs
  where the free deterministic check alone matched Jev, named as
  `verification_command` candidates, shrinking the LLM's remit over time.
  Decision-quality entries for this feature are **soak-bounded**: afterwards
  they persist as ungraded telemetry unless a ground-truth source exists,
  and are never cited as standalone evidence of auditor trustworthiness.
- **fleet:** a ladder rung that only the graduation spec (plus a soak pass)
  can open.
- **dark-window:** indefinite by default — the flag is off except during the
  operator-approved soak window (`soakEndsAt` bounds it mechanically). A dark
  audit records nothing and costs nothing, which is correct for an
  instrument awaiting its trial.
- **graduation criterion:** (owned by the NEXT spec) ≥ 20 corroborated,
  untruncated soak positives; ≥ 15 operator-graded `corroboration: none`
  runs (the prose-only population is the TARGET population; authority must
  not be validated only on well-instrumented jobs and then extended over the
  jobs it was never scored on); an on-task calibration read on ≥ 50 graded
  verdicts with zero high-confidence errors; a false-alarm rate ≤ 2% on
  ≥ 100 corroborated true-success runs; every n-floor carries the same
  extend-until-n rule (a criterion below its n is never waived); AND a
  log-integrity check (permissions/append-only + process-identity over the
  soak window — the stores are same-user-writable, so the numbers are
  trusted only after the check). Then: propose wiring verdicts to ONE
  deduped attention item per offending job. Acting on verdicts is never this
  spec.

## Frontloaded Decisions

1. Capture at the two output-holding completion callsites, pinned strictly
   before the IntegrationGate await; wake-reaper runs are absent
   structurally; judging is batch, not live — the graduation spec owns any
   real-time transport.
2. Frozen constants beside the questions in code: the 0.70 line on the
   derived confidence `max(p, 1 − p)` (min-aggregated; false-success-only
   when no effects are declared), the 8 KB tail-preferring cap with in-band
   disclosure, the 1 KB / 512 B / 16 KB pack clamps, `jev-1.13.0`, 2.5 s
   timeout, 14-day / 25k-file / 200 MB pack retention, max 8 declaredEffects
   entries, the 6 h batch default, stratified-then-uniform seeded sampling,
   the 16-slot in-flight capture cap, the 3-attempt retry ceiling with
   widening spacing, and the 10% priority reserve slice.
3. No escalation tier and no second vendor in v1; calibration is offline
   grading of all recorded verdicts against ground truth.
4. `declaredEffects` optional BUT load-bearing: no independent state signal →
   `corroboration: none`, excluded from graduation counting (as are
   truncated rows); v1 scope is file-verifiable effects; paths jailed at
   load AND re-verified at audit time (lstat, no symlinks, realpath
   containment).
5. The pack file is the durable admission, dedupe, and accounting record;
   the soak-report reconciliation against the `JobRunHistory` ledger is the
   check on coverage claims; the day's cap spend derives from the day's
   verdict rows.
6. Provenance: full scrubbed packs retained machine-local (0700/0600),
   never exported or HTTP-served; hash-only rows rejected as the diagnosed
   anti-pattern from our own stores.
7. Threshold governance: soak calibration data → reviewed code change; never
   a config knob.
8. Minimal CLAUDE.md template card in the same PR; the proactive card is
   graduation's.
9. Honest naming end to end: audit, not supervisor, in every identifier.

## Tests

1. **Unit:** every closed not-audited reason reachable; both sides of the
   confidence rule on the derived quantity (min-noul 0.69 flags
   lowConfidence, 0.70 does not; p=0.35 and p=0.65 both yield 0.65; the
   false-success-only gate when declaredEffects is absent); pack-file dedupe
   under racing completion writers; `completionAudit`
   excluded/eligible/priority through REAL manifest loading
   (wiring-integrity, proving `supervision` is never consulted);
   declaredEffects jailing at load AND the symlink/realpath refusal at audit
   time; tail-preferring truncation + in-band disclosure; the stale-but-
   claims-production vs stale-no-op distinction in the deterministic column;
   truncated/corroboration-none exclusion flags; a planted secret never
   reaches pack, body, or row; untrusted envelope present in the Jev prompt;
   uniform sampling distribution under a seeded RNG; cap-spend derivation
   from the day's rows across a restart, INCLUDING failed attempts debiting
   the cap; evidence-store permissions
   (0700/0600); retention sweep age + count/size ceilings + audited-first
   order.
2. **Integration:** real `JobScheduler` completion with a hanging capture
   stub — run row, IntegrationGate timing, queue drain byte-identical; a
   throwing capture cannot break `notifyJobComplete`; a same-second burst of
   8 completions yields 8 packs (capture never sheds); the batch job over a
   fixture pack corpus writes verdict rows, respects the cap, and honors
   priority-first; a wake-reaper timeout completion produces NO capture and
   NO row.
3. **E2E:** migrator installs the dark default idempotently; flag-off boot
   writes nothing; config flip (no restart) captures the next completed run
   and the next batch pass audits it through the production factory;
   accounting visible in feature metrics.

## Migration

Config default via `migrateConfig()` existence-check. Manifest wiring, each
step with a wiring-integrity test proving the field reaches runtime: (1)
`.md` frontmatter allowlist (`ALLOWED_FRONTMATTER_KEYS`) for
`declaredEffects` and `completionAudit`; (2) `PerSlugManifest` JSON schema
fields for both; (3) the manifest→`JobDefinition` mapping for both (without
this step the opt-out and the priority reserve would be dead code — a review
round caught exactly this gap); (4) the CLAUDE.md template's minimal card
(with its `migrateClaudeMd` content-sniffing guard). The batch job installs
via the built-in job registry (non-destructive install-if-missing), gated by a LIVE read of
`intelligence.jevJobCompletionAudit.enabled` on each pass (no restart), and
its own registration carries
`completionAudit: excluded` — the auditor never audits itself (asserted by
the wiring-integrity test).

## Rollback

Flag off (live-read) is the operational rollback; revert is the code
rollback. Rows and packs are inert data on a bounded retention. The
`declaredEffects` and `completionAudit` fields degrade to ignored
vocabulary; `supervision` was never touched.

## Out of scope

- Acting on any verdict (attention items, retries, blocking) — graduation.
- Any real-time judging transport; any escalation ladder or second vendor.
- Fleet enablement; typed effect probes; any HTTP read surface for the rows.
- **Decisions owned by the graduation spec, registered as evolution action
  ACT-037 (due 2026-10-15; none blocks building v1, which is why Open
  questions is honestly empty):**
  per-slug cap fairness; the durable-outbox question if verdicts ever gain
  authority; on-task calibration validity and the stale-no-op
  interpretation (both explicitly what the soak exists to measure); the future execution-mode Tier-1 implementation behind
  `supervision`; the sibling shadow spec's posture-key correction.
- Autonomous-run supervision (the real-check + scope-accretion gates own
  it) and replacing JobReflector/IntegrationGate (they answer "what did we
  learn", not "did it work"; complementary).

## Open questions

*(none)*
