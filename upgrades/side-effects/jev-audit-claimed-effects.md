# Side-Effects Review — Jev audit: claimed effects

**Version / slug:** `jev-audit-claimed-effects`
**Date:** `2026-09-23`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1; observe-only, adds no decision surface, fully reversible by removing frontmatter)`

## Summary of the change

The job-completion audit's deterministic column was inert on 363/363 rows
because no job declared an effect. Declaring unconditional `declaredEffects`
on this job population would manufacture false failures (the enabled jobs
write conditionally). This adds `conditionalEffects`: a jailed path the audit
verifies ONLY when the run claims it with an `EFFECT: <path>` stdout line.
Unclaimed → new `conditional-unclaimed` state (not suspicious). Claimed but
missing/stale → the existing `missing`/`stale` states (suspicious — the
false-success signal). Two built-in templates declare one effect each.

## Decision-point inventory

- *(none)* — the audit remains observe-only. The new state feeds the existing
  evidence pack Jev reasons over; no block, retry, alert or gate is added.

---

## 1. Over-block

Nothing is newly rejected. A run that prints no marker is `conditional-unclaimed`,
which is excluded from the suspicious stratum and gated on `false_success`
alone (same treatment as `no-effects-declared`). A claimed path that is
refused by the jail (absolute/`..`/symlink/escape) is recorded as `refused`,
as today, never as a failure of the job.

## 2. Under-block

A job that does work but forgets to print the marker reads as a quiet run —
the audit under-detects that run's success/failure exactly as it does today.
This is the safe direction: silence never accuses. A job that prints the marker
without writing the file is caught (`missing`/`stale`) — the target case.

## 3. Level-of-abstraction fit

The claim is parsed at the audit's capture chokepoint, the only place that
already holds the run output, the declared set and the jail root. No new
layer. The alternative — inferring "did work" from Jev — would put an LLM in
the deterministic column; the marker keeps the deterministic column
deterministic.

## 4. Signal vs authority compliance

Signal-producer. The marker parse is brittle-by-design (exact line shape) and
holds NO authority: its only output is a field in the evidence pack. Per
`docs/signal-vs-authority.md`, a brittle check may inform, never block. It
informs.

## 5. Interactions

- `declaredEffects` semantics unchanged; the two lists are unioned into the
  verified set, each capped at 8 independently.
- The suspicious-stratum filter (`missing`/`stale`) is untouched, so
  `conditional-unclaimed` never jumps the queue.
- Load-time validation is shared between both lists (one loop), so the jail
  cannot drift between them.
- `installBuiltinJobs` overwrites built-in job bodies on update, so existing
  agents receive the two template declarations on their next update
  (Migration Parity — no separate migration needed; manifests regenerate).

## 6. External surfaces

Job stdout gains one line on the two declaring jobs. That line is the job's
own output, already captured, scrubbed and clamped by the audit; it reaches
Jev inside the evidence pack under the existing egress rules. No new
network surface, no new user-facing message.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN, identical to `declaredEffects`: the effect is a file
on the disk where the job ran, verified on that disk. Evidence packs and
verdict rows are already machine-local (14-day retention, never replicated,
never HTTP-served raw). No user-facing notice is added, so one-voice gating
does not apply.

## 8. Rollback cost

Delete the `conditionalEffects` entries (and the marker instruction line)
from the two templates. The audit falls back to `no-effects-declared` —
today's behaviour. No migration, no state repair; existing packs with the
new state remain valid JSON and are read as non-suspicious.
