# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Project-scope Phase 1.7 — `/project` skill surface (full command set)

Final code piece of project-scope Phase 1: the user-invocable
`/project` skill, the conversational interface spec § Phase 1.7
specifies as twelve canonical commands. Phase 1a shipped read-only
commands (`create`, `status`, plus a placeholder `next`); this PR
fleshes out the full mutating surface and adds the three small HTTP
routes the spec named but hadn't materialized yet.

- **`.claude/skills/instar-project/SKILL.md` rewritten end-to-end.**
  Documents every spec § 1.7 command with its backing endpoint, body
  schema, expected response codes, and a one-line conversational
  rendering rule. The Phase 1a "next is a 501 placeholder" language
  is gone — the structured `{action, params, skillCommand}` payload
  shipped in the connect-the-dots PR is now the documented contract.
- **`POST /projects/:id/run-round`** — manual round-start trigger.
  Calls `ProjectRoundRunner.preflight()` for the deterministic gate
  checks and, on accept, sets `autoAdvanceAt = now` so the existing
  auto-advance poller fires the executor on its next tick (≤60s).
  Does NOT spawn the autonomous child directly — keeps one fire path
  through one lock. Body: `{roundIndex}`. Returns 200 with
  `{id, roundIndex, scheduledAt, version}` on accept, 409 with the
  preflight verdict's `code` + `reason` on reject (surface those
  verbatim — they're written for users).
- **`POST /projects/:id/resume`** — resume a halted or failed round.
  Clears `haltedAt`/`haltReason`, schedules the round for the poller,
  re-actives `project.status` from `'halted'`/`'abandoned'` back to
  `'active'`. For rounds at `status: 'failed'` with
  `resumeAttempts >= 3` (the spec's three-attempt cap), `{force: true}`
  is required and the counter resets to zero on accept. Returns 409
  when the round is neither halted nor failed.
- **`POST /projects/:id/abandon`** — archive a halted project.
  Sets `project.status = 'abandoned'` and clears any future
  `autoAdvanceAt` on remaining rounds so the poller stops considering
  them. Children's `pipelineStage` is left untouched (per spec).
  Idempotent. Refuses (409) if a round is currently `in-progress` —
  halt first.
- **`skillCommandForAction()` realigned to canonical command names.**
  The connect-the-dots PR added a mapping that returned
  `/project approve` and `/project drift-check` for the
  `await-user-approval` and `run-drift-check` actions. Spec § 1.7
  uses `/project ack` and `/project drift` as the canonical command
  names; the mapping now matches the spec so dashboard hints and
  skill invocations stay in sync.

Tests added:

- `tests/unit/instar-project-skill.test.ts` — structural coverage of
  SKILL.md (28 assertions). Pins the frontmatter contract, asserts
  every spec § 1.7 command has a section header, and asserts each
  documented endpoint actually exists in `src/server/routes.ts`.
  Catches skill drift — if a route is renamed or removed without
  updating the skill, the test fails on the next push.
- `tests/integration/projects-api.test.ts` — 10 new cases (44 total)
  for the three new endpoints: preflight reject (409), happy path
  (200 + autoAdvanceAt landed), out-of-range round (404),
  haltedAt-clear on resume (200), neither-halted-nor-failed reject
  (409), failed-at-cap-without-force reject (409),
  failed-at-cap-with-force happy path (counter zeroed), abandon
  happy path (autoAdvanceAt cleared + status='abandoned'),
  abandon-while-in-progress reject (409), abandon idempotent
  (`alreadyAbandoned: true`).

## What to Tell Your User

- **You can now drive any project end-to-end through `/project`.**
  Twelve commands, one skill: register a project from a plan doc,
  read its state, advance a child item to its next stage, run a
  drift check, fire a round, halt the active round, record your
  acknowledgment, resume from halted or failed, abandon a project
  permanently, close out a partially-complete round, claim ownership
  on another machine. The skill walks me through each one with the
  right API call and the right error handling — I don't have to
  improvise the curl invocations.

- **The "what should I do next" answer is now actionable.**
  Asking `/project next` returns a structured action — "approval
  pending," "drift check needed," "round ready to start" — plus the
  exact follow-up command. I'll surface the suggested next step to
  you in plain English rather than dumping the JSON.

- **Halted projects can come back.** If a round halted because of a
  spec drift, a halted child, or a runtime failure, `/project resume`
  re-schedules it for the poller and re-actives the project. Rounds
  that hit the three-attempt failure cap need explicit `--force`
  before resuming, and the counter resets so the runner gets a fresh
  budget.

- **Permanently shelving a project is a single command.**
  `/project abandon` clears all pending auto-advance scheduling and
  marks the project as abandoned. Children stay where they were —
  you don't lose any pipeline progress; you just stop the auto-loop.

## Summary of New Capabilities

- `.claude/skills/instar-project/SKILL.md` — twelve-command skill body
  with frontmatter `user_invocable: true`. Each command section
  documents its backing endpoint, body schema, response shape, and
  expected error codes. Final "Conversational rendering" section pins
  the don't-paste-curl rule.
- `POST /projects/:id/run-round` — body `{roundIndex: number}`.
  Returns 200 `{id, roundIndex, scheduledAt, version}` on accept,
  409 `{error, code, reason}` on preflight reject, 404 on out-of-range
  round, 503 if `ProjectRoundRunner` is not wired. OCC-protected via
  `tracker.update(... ifMatch: project.version)`.
- `POST /projects/:id/resume` — body `{roundIndex?: number,
  force?: boolean}`. Returns 200 `{id, roundIndex, scheduledAt,
  forced, version}` on accept, 409 when the round is neither halted
  nor failed, 409 when failed-at-cap without `force`. Restores
  `project.status` from `'halted'`/`'abandoned'` to `'active'` and
  zeroes `resumeAttempts` on forced accept.
- `POST /projects/:id/abandon` — no body required. Returns 200
  `{id, status: 'abandoned', version}` on accept, 200
  `{... alreadyAbandoned: true}` on idempotent repeat, 409 with
  `activeRound` set when a round is in-progress. Clears
  `autoAdvanceAt` on every remaining round.
- `skillCommandForAction()` now emits `/project ack` for both
  `await-user-approval` and `ack-required` action verbs, and
  `/project drift` for `run-drift-check`. Aligns the dashboard hint
  strings with the spec § 1.7 canonical command set.

## Evidence

Not reproducible in dev — this release is a feature addition, not a
regression fix. The words "halted", "failed", "regression repair",
and "skill drift" in What Changed describe design properties of the
state machine and the structural test the PR introduces:

- "halted" / "failed" (resume route): these are valid round states
  in the existing `RoundStatus` union; the new endpoint's job is to
  transition out of them. Not a fix for an observed halt incident.
- "skill drift" (structural test): the new
  `instar-project-skill.test.ts` asserts every endpoint documented
  in SKILL.md exists in `routes.ts`. The "drift" is the test's
  failure mode if a future PR renames a route without updating the
  skill — a preventive guard, not the patching of a prior incident.
