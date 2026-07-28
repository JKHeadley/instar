# ELI16 — A durable compass for long autonomous work (Phase 1)

## What changed

Long autonomous runs now have an observation-only alignment reviewer. On development
agents, verified operator messages in an active run's topic feed a durable priority
ledger, and a periodic reviewer compares that ledger with the run's current goal and
unfinished tasks.

Phase 1 only sees and records. It does not inject advice into sessions, edit the run
plan, block work, create attention items, or notify the operator. The authenticated
`GET /goal-realignment` status surface shows the candidate inbox, active/closed
priorities, counters, and latest dry-run verdict.

## Important lifetime rule

The recency window controls discovery of new priorities only. Once a verified
priority is recorded, it remains active until an explicit later operator message
supersedes it or clearly confirms it addressed. Silence and age never remove it.

The risky `diverged` verdict still requires validated evidence on both sides: an
authoritative priority citation and an exact contradictory or abandoning quote from
the current run focus. Missing, conflicting, or incomplete evidence becomes
`indeterminate`.

Incomplete is enforced before model review: truncated history, an unresolved
candidate extraction, or a digest projection that omits a live priority records
`indeterminate` at confidence zero and makes no reviewer call.

## Durability and provenance

- Every deterministic instruction-shaped operator message enters a candidate inbox
  before model classification.
- Extraction checkpoints persist the source cursor, exact raw provider output,
  validated result, prompt ID, and model ID before any ledger event.
- A crash after the checkpoint reuses it, producing the same deterministic priority
  ID without another model call.
- Telegram forwarded-message provenance now survives TopicMemory storage and
  rebuilds. Legacy rows with unknown forwarded state remain ineligible.
- Both LLM decisions emit bounded, identity-only decision provenance; raw operator
  text and run-focus bodies are not copied into the provenance archive.

## Rollout

The feature is development-agent gated and structurally `dryRun: true`. Fleet agents
remain dark. Existing TopicMemory databases migrate automatically from schema 4 to
schema 5 by adding the nullable forwarded-provenance column. No operator action or
configuration change is required.

## Validation

Refusal-first coverage pins the three acceptance cases: an old standing priority
survives the discovery window, quoted-only instructions require operator
confirmation, and crash replay reuses the checkpoint and priority ID. Unit,
integration, end-to-end, type, lint, and build results are recorded in the Phase 1
validation artifact.
