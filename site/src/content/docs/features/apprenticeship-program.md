---
title: Apprenticeship Program
description: The instance registry and lifecycle gates that structure how Instar onboards each new agent framework — review before you start, capture before you close.
---

Instar onboards new agent frameworks (Claude Code, then Codex, then Gemini CLI, …) through a
structured **apprenticeship**: a graduated agent mentors the next newcomer while an overseer
watches the mentor, the mentee, and the process itself. The Apprenticeship Program is the standing
structure every onboarding plugs into — an instance registry plus two lifecycle gates that make
"learn from the last round" and "capture what you learned" impossible to skip.

This page documents the **program scaffold** (`core/ApprenticeshipProgram`). The wider design — the
roles, the differential-oversight loop, the runtime-adapter keystone — lives in the project design
spec (`docs/specs/APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md`).

## Instances as projects

Each apprenticeship/mentorship is its own tracked **instance** with a role triple — **overseer**
(watches everything), **mentor** (the apprentice-and-mentor — graduated, now teaching), and
**mentee** (the new framework) — plus its framework, status, and a required-artifact checklist.
State lives in `.instar/apprenticeship/instances.json` (atomic writes + an optimistic-version CAS,
fail-closed on corruption). A typed `ApprenticeshipOverseer` surface is reserved for the
differential-oversight computation built in a later step.

## The two gates (structure, not willpower)

Both gates are **structural preconditions on objective artifacts** — never quality judgments. The
quality call (did the mentor truly internalize the lessons?) stays with the overseer; every gate
verdict is appended to `logs/apprenticeship-decisions.jsonl`.

- **The retro-gate** — a `pending → active` transition is refused until the *prior* instance's
  retro-harvest exists at its canonical path and passes the harvest validator. The first instance
  is seeded by the Echo→Codey bootstrap harvest. This is "review the last round before you start
  the next" made unskippable.
- **The doc-as-required-artifact gate** — an `active → complete` transition is refused until the
  instance's required artifacts (its own retro-harvest, an instance-scoped ledger entry, the
  detector audit) are **verified present from live state** — a stored checklist boolean is never
  treated as evidence.

`complete` is a terminal status; illegal transitions are rejected with a reason.

## API

All routes require a Bearer token.

### Instance lifecycle

- `GET /apprenticeship/instances` — list every tracked instance.
- `GET /apprenticeship/instances/:id` — fetch one instance.
- `POST /apprenticeship/instances` — create an instance (the id and role names are charset-clamped;
  duplicate ids are rejected; `harvestFrom`/`harvestTo` are normalized at create).
- `POST /apprenticeship/instances/:id/transition` — the **only** way status changes. `pending→active`
  runs the retro-gate and refuses if it fails; `active→complete` runs the doc-gate; `active↔blocked`
  is allowed; `complete` is terminal.
- `POST /apprenticeship/instances/:id/can-start` — a read-only preview of the retro-gate verdict.
- `POST /apprenticeship/instances/:id/can-complete` — a read-only preview of the doc-gate verdict
  (returns the list of missing artifacts).

### Differential cycles

`ApprenticeshipCycleStore` persists the mentor/overseer learning loop in SQLite so each
apprenticeship cycle has durable, queryable evidence instead of living only in chat transcripts.
The server opens `server-data/apprenticeship-cycles.db`, registers the handle with the
`SqliteRegistry`, and exposes the store through authenticated routes.

Each cycle records `id`, `instanceId`, `cycleNumber`, `createdAt`, `task`, `menteeOutput`,
`mentorFlagged`, `overseerDifferential`, `coaching`, `infraItems`, `kind`, and `status`.
Array fields are stored as JSON and returned as arrays.

Cycle `kind` is the source of truth for role-axis visibility. New writes use the explicit axis
vocabulary `mentor-mentee-differential`, `overseer-apprentice-devreview`, or
`overseer-mentee-direct`; historical `differential-cycle` rows are treated as `unknown` so the
program never fabricates coverage it cannot prove.

- `POST /apprenticeship/cycles` — record one cycle. Required fields are `instanceId`,
  `cycleNumber`, `task`, and `menteeOutput`; array fields are optional arrays of strings.
- `GET /apprenticeship/cycles?instanceId=&limit=` — list recent cycles, optionally scoped to one
  instance and bounded by `limit`.
- `GET /apprenticeship/cycles/overdue?instanceId=` — read the observe-only overdue-cycle SLA
  signal. It returns open cycles older than `monitoring.apprenticeshipCycleSla.overdueAfterMinutes`
  (default 120 minutes), optionally scoped to one instance. The monitor ships disabled by default;
  when it is unavailable, this route returns 503.
- `GET /apprenticeship/cycles/:id` — fetch one recorded cycle, returning 404 when the id is
  unknown.
- `POST /apprenticeship/cycles/:id/close` — mark an open cycle as closed and return the updated
  record.
- `GET /apprenticeship/instances/:id/role-coverage` — read the observe-only role coverage surface
  for one instance. It returns per-axis `{ fired, cycleCount, lastAt }`, an `unknown` bucket,
  `dormantAxes`, and `driftWarning`. The warning is true when the mentor-mentee differential axis is
  dormant while the overseer-apprentice dev-review axis has fired at least twice.

If the SQLite store is unavailable, the cycle routes return 503 instead of pretending the feature
is alive.

`ApprenticeshipCycleSlaMonitor` is observe-only. When enabled, it reads open cycles from
`ApprenticeshipCycleStore`, computes age from `createdAt`, and raises at most one attention item per
overdue cycle id. It never closes cycles, edits cycle rows, or emits a repeated alert on every
monitoring tick. The server wires it into the existing token-ledger poller cadence so this signal
does not add a new background timer.

```bash
# Preview whether an instance may start (the retro-gate)
curl -X POST -H "Authorization: Bearer $AUTH" \
  http://localhost:4042/apprenticeship/instances/codey-to-gemini-mentorship/can-start

# Transition it active (refused unless the prior harvest validates)
curl -X POST -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' \
  http://localhost:4042/apprenticeship/instances/codey-to-gemini-mentorship/transition \
  -d '{"to":"active"}'
```

## Why it matters

Without this structure, an onboarding is unbounded and its hard-won lessons evaporate. The program
makes each onboarding a durable project, forces every round to start from the distilled learnings of
the last, and forces every round to write down what it learned before it can close — so the system
gets better at onboarding the next framework, every generation.
