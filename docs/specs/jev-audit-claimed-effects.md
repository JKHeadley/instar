---
title: Claimed effects — make the job-completion audit answerable without manufacturing false failures
status: draft
created: 2026-09-23
eli16-overview: docs/specs/jev-audit-claimed-effects.eli16.md
---

# Claimed effects for the Jev job-completion audit

## Problem (measured, not assumed)

The job-completion audit asks Jev "did this job do what it promised?" and offers it
one piece of checkable evidence: whether a file the job declared actually changed
during the run. Measured on this agent over 2026-09-23, across 363 audited runs:

- `deterministic` was `no-effects-declared` on **363 of 363 rows** (100%).
- Jev answered `failure_class: cannot-tell` on **335 of 363** (92%).
- **91%** of rows were `lowConfidence`.

No job declares an effect, so the deterministic column is inert and Jev is left
inferring "did the work happen?" from the job's text output alone. `cannot-tell`
is the CORRECT answer to a question we made unanswerable. The trial therefore
cannot produce a verdict about Jev in either direction.

## Why the obvious fix is wrong

The naive repair — declare `declaredEffects` on jobs that write files — fails on
this job population, and fails in the most damaging direction:

1. **The jobs that write unconditionally are disabled.** `doorway-scan` and
   `routing-price-refresh` both ship `enabled: false`, so they generate no rows.
2. **The jobs that run write conditionally.** `reflection-trigger` writes memory
   only "if you find genuine learnings"; `commitment-detection` updates its
   bookmark only when it processed new messages. A legitimate quiet run writes
   nothing.
3. **Most enabled jobs write no file at all** — they call an internal endpoint and
   the server mutates its own stores.

Declaring an unconditional effect on a conditionally-writing job marks every
legitimate quiet run `stale` or `missing`. That manufactures evidence AGAINST the
model from OUR modelling error — the precise failure this spec exists to prevent.

## Design: the job claims, the audit verifies

Instead of guessing whether a quiet run was legitimate, the run SAYS what it did
and the audit checks the claim.

**Frontmatter (new, additive):**

```
conditionalEffects:
  - .instar/MEMORY.md
```

Same validation as `declaredEffects`: repo-relative only, no absolute, no `..`,
max 8 entries, string array. Absent means absent — no behaviour change.

**Runtime claim.** A job that did work emits a marker line on stdout:

```
EFFECT: .instar/MEMORY.md
```

**Evaluation.** The audit parses claimed paths from the run output and intersects
them with the declared `conditionalEffects` set. A job can only ever claim a path
it declared up front, so output cannot widen the verified set. Then:

| Condition | `deterministic` | Suspicious? |
|---|---|---|
| conditional declared, nothing claimed | `conditional-unclaimed` | **No** — a legitimate quiet run |
| claimed, file changed during run | `all-present-and-fresh` | No |
| claimed, file missing | `missing` | **Yes** |
| claimed, file exists but unchanged | `stale` | **Yes** |
| claimed a path NOT declared | ignored, counted | No (recorded for review) |

The `claimed-but-not-produced` case is the strongest evidence the audit can
generate: the run asserted it did work, and the work is not on disk. That is
exactly the "false success" the audit was built to detect, and today it cannot
see it at all.

## What this deliberately does NOT do

- It does not cover API-driven jobs whose effect is a server-side state change.
  A file check is the wrong instrument for them; that needs a separate effect
  kind and is out of scope here. <!-- tracked: CMT-565 -->
- It grants Jev no authority. The audit remains observe-only: it records verdicts
  and gates nothing.
- It does not change `declaredEffects` semantics. Existing unconditional
  declarations behave exactly as today.

The carrier for the deferred non-file effect kind, frozen from the registry:

> **CMT-565** — "Build the CONDITIONAL declaredEffects form for the Jev job-completion audit: a declared file is only expected to have changed when the job itself reports it did work, so quiet legitimate runs are not false failures. Declare real effects on qualifying built-in jobs. Ship via instar-dev, then restart the job soak on a fresh window. Rationale: the naive unconditional form would manufacture evidence a"

## Signal vs authority

This is a signal-producer, not an authority. The marker parse is deterministic and
narrow; its output feeds the existing evidence pack that Jev reasons over. No
blocking decision is added anywhere. A malformed or absent marker degrades to
`conditional-unclaimed` (the non-suspicious state) rather than to a failure —
uncertainty resolves toward NOT accusing the job.

## Rollback

Remove the `conditionalEffects` frontmatter entries. The audit falls back to
`no-effects-declared` — today's behaviour exactly. No migration, no data repair.
