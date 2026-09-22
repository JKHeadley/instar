# Side-Effects Review — Jev job-completion audit (observe-only v1)

**Version / slug:** `jev-job-completion-audit`
**Date:** `2026-09-21`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (see appended section)`

## Summary of the change

Implements `docs/specs/jev-job-supervision.md` (converged over 10 review
rounds incl. a GPT external each round; approved by Justin 2026-09-21):
`JevJobCompletionAudit` (src/scheduler/) captures a scrubbed, clamped evidence
pack when a scheduled job completes (the pack file is the durable
admission/dedupe/accounting record) and a batch pass — `POST /jev-audit/batch`,
driven by the new `jev-completion-audit` built-in job (ships `enabled:false`,
`completionAudit: excluded`) — asks Jev whether the evidence shows the
promised work happened, writing verdict rows that decide NOTHING. New manifest
fields `completionAudit` and `declaredEffects` are wired end-to-end
(frontmatter allowlist → PerSlugManifest + validator jail → JobDefinition).
Config `intelligence.jevJobCompletionAudit` ships dark via `migrateConfig`;
the CLAUDE.md template gains a minimal awareness card (new agents via
`generateClaudeMd`, existing agents via `migrateClaudeMd`).

## Decision-point inventory

- *(none — signal-only by construction)*: every branch (capture, refuse,
  audit, lowConfidence flag, sample-out) terminates in an unconsumed
  file/row/metric. `notifyJobComplete` and the script-path completion gain one
  guarded fire-and-forget `capture()` before the IntegrationGate; the run
  row, queue drain, claims and notifications are byte-identical (tested with
  a hanging and a throwing capture). The wake-reaper path is untouched
  (structural absence, asserted by test).

---

## 1. Over-block

Nothing can be blocked: the component holds no authority. `validateManifest`
now REFUSES a malformed `completionAudit`/`declaredEffects` (bad enum,
absolute path, `..`, >8 entries) — that is load-time schema validation in the
existing refuse-by-name style, and only fires for jobs that opt into the new
vocabulary. No existing manifest carries these fields. No issue identified.

## 2. Under-block

The audit is non-adversarial false-success detection by declaration: a job
can `touch` declared files and print auditor-pleasing text. Verdicts without
independent corroboration record `corroboration: none` and are excluded from
graduation counting; nothing acts on any verdict in v1.

## 3. Level-of-abstraction fit

Capture lives at the two completion callsites that hold the live output
(persisted `outputSummary` is capped at 2 KB with field-dropping — the wrong
source); judging lives in a batch over durable packs (nothing consumes
verdicts, so nothing needs real-time judging). Verdict/evidence storage is
deliberately NOT in `JobRunHistory` (2 KB row cap, first-writer-wins — the
wrong shape).

## 4. Signal vs authority compliance

Pure signal, unconsumed in v1. The deterministic effect check is recorded as
its own column and is the PRIMARY outcome when conclusive — the LLM never
holds authority over even the record's headline. Graduation into any
authority is a separate spec.

## 5. Interactions

- **Completion path cost:** in-memory eligibility checks + an O(1) tail
  slice; scrub/stats/write run detached under a 16-slot in-flight cap
  (overflow = counted `capture-failed` metric). The hanging-capture test pins
  `notifyJobComplete` returning promptly; the IntegrationGate ordering is
  unchanged (capture inserted strictly before it).
- **Retry/caps:** every ATTEMPTED (billed) call writes a row; the day's cap
  is derived from rows (restart-safe, failed attempts included); vendor
  failures retry with widening pass-spacing, terminal `audit-failed` after 3.
- **Batch reentrancy:** single-flight (`already-running` skip); the built-in
  job self-excludes (`completionAudit: excluded`), so the auditor never
  audits itself.
- **Feature metrics:** calls meter under `jev-job-completion-audit`
  (framework `typesafe-api`); no double-count with any other feature.
- **Existing suites:** JobScheduler (94 tests across 5 suites), loader +
  builtin-manifest (88 across 5) all pass unchanged.

## Second-pass review

**Reviewer:** independent reviewer subagent
**Verdict:** Concern raised: `InstrumentAssessment.reason` (a free-text field
authored by the job's own output, via `INSTAR_INSTRUMENT_ASSESSMENT=` /
`parseInstrumentAssessment`) is embedded in the evidence pack and the
outbound Jev request body WITHOUT passing through `scrubForStore`, unlike
`outputTail`/`goal`/`description`. It is only truncated
(`JSON.stringify(pack.instrumentAssessment).slice(0, 500)`), not scrubbed —
so a job that prints a credential inside its self-reported `reason` string
(the exact live, job-authored text the rest of the scrub chain exists to
protect) reaches TypeSafe unredacted. Recommend routing `reason` (and any
other free-text field of the assessment) through `scrubForStore` before it
enters the pack, matching the treatment already given to output/goal/
description. This does not block the dark/inert default posture, but should
be fixed before the operator-approved soak window opens (the point at which
this field first has real egress).

Checked and found no other blocking issues:

- **Completion-path safety (point 1):** `capture()` is synchronous-bounded
  (try/catch, in-memory eligibility, O(1) pre-slice) and never awaited at
  either completion callsite; `captureDetached()` runs fully detached.
  Confirmed the capture call sits strictly before the `IntegrationGate` await
  in `notifyJobComplete` (source order checked directly), and the script-path
  callsites are symmetric. The integration suite's hanging-capture and
  throwing-capture tests genuinely exercise this (verified test bodies, not
  just names) and a `no-audit-attached` test proves byte-identical behavior.
  The wake-reaper path (`reapStuckRuns`) contains zero `jevAudit` references
  (verified by direct source inspection, matching the wiring test's textual
  scan) — structurally absent, not just untested.
- **Secret/leak surfaces (point 2):** `outputTail`, `goal`, and `description`
  all pass through the shared `scrubForStore` (fail-safe-toward-redaction)
  before landing in the pack or the wire; a planted-secret unit test asserts
  absence from both the pack JSON and the sent request body. Verdict rows
  (`rowFor`) carry only metadata (runId/slug/sha256/deterministic/
  trivialHeuristic/corroboration/truncated + verdict fields) — no
  goal/output/effects text ever reaches a row or a log line. The vault key is
  never logged. Pack dir/file permissions are `0700`/`0600` via an
  atomic write-then-rename. The one gap found is the `instrumentAssessment`
  field above.
- **Cap accounting (point 3):** `readDayState` derives the day's attempted
  count and decided-run set from the active log plus its `.1` rotation only
  (`BoundedJsonlAudit` default 5 MB/rotation, 2 archives kept). At the shipped
  default (`dailyCallCap: 1500`, small metadata-only rows) a single day stays
  well under one rotation, so today's behavior is correct and the restart-
  safety test (fresh instance sees prior rows and refuses further calls)
  holds. Noting for the record: `dailyCallCap` is an operator-configurable
  field (not one of the frozen constants), so an operator raising it far
  beyond the measured p95 in combination with larger rows could in principle
  push same-day rows past `.1` into an unread `.2` archive, undercounting the
  day's spend. Not exploitable under shipped defaults; worth a comment/test
  if `dailyCallCap` is ever raised materially.
- **Spec conformance (point 4):** all frozen constants
  (`POSITIVE_THRESHOLD`, `TAIL_CAP_BYTES`, `GOAL_CLAMP_BYTES`,
  `PATH_CLAMP_BYTES`, `PACK_CEILING_BYTES`, `MAX_DECLARED_EFFECTS`,
  `CAPTURE_INFLIGHT_CAP`, `MAX_AUDIT_ATTEMPTS`, `PRIORITY_RESERVE`,
  `RETENTION_*`, `RETRY_BACKOFF_PASSES`, model id, timeout) match the spec's
  Frontloaded Decision #2 values exactly. Stratified sampling order
  (suspicious → priority-reserved-slice → uniform seeded shuffle) matches
  §B. Retry brakes (widening backoff passes, terminal `audit-failed` after 3,
  every failed-but-billed attempt writing its row immediately) match. The
  built-in job self-excludes (`completionAudit: excluded`, verified by both
  the template frontmatter and a wiring test) and is only discoverable via
  the directory-scan install mechanism (no registry edit needed) — correct.
  The no-declaredEffects single-noul gate (`false_success` confidence alone
  when `deterministic === 'no-effects-declared'`) is implemented and tested
  on both sides. One naming deviation: the closed `NotAuditedReason` union
  declares `'sampled-out'` and `'audit-excluded'`, but neither string is ever
  actually produced anywhere in the implementation — `runBatch()` emits an
  unrelated, untyped `'awaiting-later-batch'` key in its `skipped` summary
  instead of `'sampled-out'`, and the `completionAudit: 'excluded'` path in
  `capture()` returns silently with no reason recorded at all (not even a
  metric). This is consistent with the spec's more specific "Retry brakes"
  paragraph (sampled-out packs age out with no row), but it means two members
  of the "closed... each reachable in tests" reason set are neither reachable
  nor spelled as documented — a minor spec-fidelity gap, not a safety issue.
- **Artifact accuracy (point 5):** the side-effects summary above accurately
  describes the shipped code (capture ordering, batch behavior, egress scope,
  rollback levers). The `instrumentAssessment` scrub gap above is the one
  place the summary's "no secret or job text ever reaches a row/pack/wire"
  framing slightly overstates the current implementation.

### Re-review after fixes

**Reviewer:** independent reviewer subagent
**Verdict:** Concur with the review.

Re-read the current `src/scheduler/JevJobCompletionAudit.ts` directly (the
file is new/untracked, so `git diff` shows nothing — I diffed against the
version already captured in the first-pass review) and confirmed all three
items addressed:

- **`instrumentAssessment` scrub:** `captureDetached` now stores it as
  `clamp(scrubForStore(JSON.stringify(input.instrumentAssessment)).text,
  GOAL_CLAMP_BYTES).text` — a scrubbed, clamped STRING in the pack — and
  `auditOne` interpolates that already-scrubbed string (`String(pack.
  instrumentAssessment)`) into the outbound prompt, so nothing unscrubbed
  reaches the pack or the wire. The new unit test ("a secret inside
  instrumentAssessment reaches neither the pack nor the wire") plants a
  secret in `instrumentAssessment.reason`, then asserts it is absent from
  both `JSON.stringify(readPack(...))` and the captured `fetch` request
  body, while `'UNTRUSTED CLAIM'` still appears — a real, targeted assertion,
  not a name-only test. Ran it directly: passes.
- **Closed-set naming:** `capture()`'s excluded-job path now calls
  `this.metric('audit-excluded')` before returning (no longer silent), and
  `runBatch()` now assigns `skipped['sampled-out']` (was
  `'awaiting-later-batch'`). Both strings now match the `NotAuditedReason`
  union and the spec's closed vocabulary; `'audit-excluded'` is observable
  via feature metrics even though (correctly, matching the "Retry brakes"
  paragraph) neither reason writes a JSONL row.
- **Cap-accounting archive coverage:** `readDayState` now reads
  `[logPath, logPath + '.1', logPath + '.2']`, matching
  `BoundedJsonlAudit`'s default `keepArchives: 2`, closing the latent
  undercount path noted in the first pass.

Independently verified rather than taking the summary on faith: ran the full
targeted suite (`tests/unit/JevJobCompletionAudit.test.ts`,
`tests/unit/jev-audit-wiring.test.ts`,
`tests/integration/jev-completion-audit-scheduler.test.ts`,
`tests/e2e/jev-completion-audit-lifecycle.test.ts`) — 38/38 pass — and
`tsc --noEmit -p .` — no errors on any of the three touched files. No new
concerns found in this pass; the fixes are narrowly scoped to the three
findings and do not touch the completion-path safety invariants (capture
ordering, non-blocking guarantee, permissions) validated in the first pass.

## 6. External surfaces

While ENABLED (dark by default; inert without a future `soakEndsAt` + vault
`typesafe_api_key`), the scrubbed evidence pack leaves the machine to ONE
vendor (TypeSafe). The scrub removes credential-shaped secrets only — not
PII/business content — and the spec's egress section makes the operator's
flip-time consent explicit about that boundary. The output tail rides in an
untrusted-data envelope; `InstrumentAssessment` is labeled an untrusted
self-report and — like the tail, goal and description — is scrubbed and
clamped at capture, so every job-authored string reaching the pack or the
wire has passed the scrubber. Rows and packs are machine-local, never exported, never
HTTP-served (`POST /jev-audit/batch` is a trigger, not a read surface).

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local. `machine-local-justification: hardware-bound-resource` — the
audited runs are tmux/scheduler sessions bound to this machine's hardware;
each machine audits its own scheduler (declared in the spec's posture table).
Config is ordinary unified per-machine `intelligence.*`; the manifest fields
travel with job definitions. No user-facing notices, no topic-bound state, no
URLs.

## 8. Rollback cost

Operational: `intelligence.jevJobCompletionAudit.enabled: false` (read live
per candidate/batch — no restart). Code: revert; rows/packs are inert data on
a bounded retention (14 d / 25k files / 200 MB, swept at boot + daily), and
the manifest fields degrade to ignored vocabulary. The built-in job ships
disabled and its endpoint answers 503 when the audit is not constructed.
