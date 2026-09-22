---
title: Jev Job-Completion Audit
description: An observe-only audit that asks a cheap decision model whether a scheduled job actually produced the effect it promised. Captures evidence at completion, judges it in batch, and acts on nothing. Ships dark behind intelligence.jevJobCompletionAudit.
---

A scheduled job counts as "successful" today when its process exits cleanly. Nothing checks whether
the work it exists for actually happened — `JobRunHistory.result` derives purely from process and
session status, which is the textbook case of trusting a symbol instead of the state it stands for.
Instar has four documented cases of jobs reporting success for days while doing nothing.

The **Jev job-completion audit** closes the measurement half of that gap. It is an *audit record,
not supervision*: it writes down what happened and decides nothing.

## How it works

**Capture, at completion.** When a job finishes, a small evidence pack is written to
`.instar/state/jev-supervision-evidence/<runId>.json`: the job's goal, its recorded result and
duration, the tail of its output (credential-scrubbed, clamped, tail-preferring with an in-band
truncation marker), and — when the job declares `declaredEffects` — whether those files exist, how
big they are, and whether they were written after the run started. The work at the completion
callsite is bounded to in-memory checks plus one slice; everything else runs detached under a
16-slot cap, so job completion is never delayed. The pack file is also the dedupe and accounting
record.

**Judge, in batch.** The `jev-completion-audit` built-in job runs every six hours and calls
`POST /jev-audit/batch`, which audits packs that have no verdict yet — deterministically suspicious
ones first, then `priority` jobs from a reserved slice of the daily budget, then a seeded uniform
sample of the rest. Each pack gets one Jev call with a frozen three-question battery. Every
attempted call writes a row, so a failed-but-billed attempt still debits the daily cap across
restarts; retries widen their spacing and go terminal after three.

**Two free comparators.** Each pack also carries a deterministic declared-effects verdict (the
PRIMARY classified outcome when it is conclusive) and a trivial-heuristic column (error keywords,
empty output). The soak report compares Jev against both, so "the model earns its cost" is measured
rather than assumed.

## Honest scope

- **It decides nothing.** No job is blocked, retried or alerted on. Nothing reads a verdict on any
  decision path. Wiring verdicts to the attention queue is a separate, later decision.
- **It is not tamper-resistant.** A compromised job can `touch` its declared files and print
  auditor-pleasing text. This is non-adversarial false-success detection.
- **Corroboration is asymmetric.** A missing declared effect corroborates a false-success finding;
  files merely being present never corroborates success on its own.
- **Records only, locally.** Verdict rows live in `logs/jev-job-completion-audit.jsonl` (rotation
  bounded) and packs are swept on age plus count and size ceilings. Neither is exported or served
  over HTTP.

## Turning it on

Dark by default, and inert even when enabled unless a future `soakEndsAt` is set and the vault holds
`typesafe_api_key`:

```json
{ "intelligence": { "jevJobCompletionAudit": {
  "enabled": true, "soakEndsAt": "2026-10-05T00:00:00Z", "dailyCallCap": 1500
} } }
```

Enabling is deliberately an operator decision: during the soak, scrubbed job output leaves the
machine to one vendor (TypeSafe), and the scrubber removes credential-shaped secrets only — it is
not a PII filter.

## Per-job controls

- `completionAudit: excluded` — never audit this job. `priority` — audit it first from the reserved
  slice. Absent means eligible.
- `declaredEffects: ["out/report.md"]` — repo-relative paths (max 8) the job promises to produce.
  Jailed at manifest load and re-verified at audit time, so a symlink cannot point the check at
  another file. Declare externally meaningful outputs, never sentinel files; a job that can express
  a deterministic contract should use `verification_command` instead.

Spec: `docs/specs/jev-job-supervision.md`.
